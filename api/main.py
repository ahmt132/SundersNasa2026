"""FastAPI app.  Run:  python -m uvicorn api.main:app --port 8000

Selection parameters (exactly one group), shared by every data endpoint:
  geom=<GeoJSON Polygon|MultiPolygon|Feature>   bbox=west,south,east,north
  lat=&lon=&radius_km=                          region=<id from /regions>
Optional: start, end (YYYY-MM or YYYY-MM-DD), metric=count|celldays

Errors are JSON: {"error": {"code": "...", "message": "..."}}
  404 outside_coverage | unknown_region | no_data_in_range | empty_selection
  413 selection_too_large | export_too_large
  422 invalid_selection | invalid_geometry | invalid_date | invalid_metric
  503 no_data (the pipeline has not been run)
"""
import io
import math
import os
from datetime import datetime, timezone

import pandas as pd
from fastapi import Depends, FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from pipeline.config import load_config

from .geometry import ApiError, parse_selection
from .store import Store

CITATION = (
    "Data: NASA FIRMS (Fire Information for Resource Management System), part of NASA LANCE/ESDIS - "
    "MODIS Collection 6.1 and VIIRS 375 m active fire products. https://firms.modaps.eosdis.nasa.gov/"
)
SERIES_OUT = {"modis": "modis_raw", "terra": "terra_raw", "aqua": "aqua_raw", "viirs_snpp": "viirs_snpp_raw",
              "viirs_n20": "viirs_n20_raw", "viirs_n21": "viirs_n21_raw"}


def _parse_date(text: str | None, name: str, end: bool = False) -> pd.Timestamp | None:
    if not text:
        return None
    try:
        if len(text) == 7:
            ts = pd.Timestamp(datetime.strptime(text, "%Y-%m"))
            return ts + pd.offsets.MonthEnd(0) if end else ts
        return pd.Timestamp(datetime.strptime(text, "%Y-%m-%d"))
    except ValueError:
        raise ApiError(422, "invalid_date", f"{name} must be YYYY-MM or YYYY-MM-DD, got '{text}'") from None


def _clean(value):
    """JSON-safe scalar: NaN/NaT -> null, numpy types -> Python types."""
    if value is None or value is pd.NaT:
        return None
    if hasattr(value, "item"):
        value = value.item()
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def create_app(config_path: str | None = None) -> FastAPI:
    app = FastAPI(title="Burning calendar API", version="1.0",
                  description="Harmonized MODIS + VIIRS active-fire hotspot series (MODIS-equivalent units).")
    origins = os.environ.get("BURNCAL_CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
    app.add_middleware(CORSMiddleware, allow_origins=[o.strip() for o in origins if o.strip()],
                       allow_methods=["GET"], allow_headers=["*"], expose_headers=["Content-Disposition"])
    app.state.store = None

    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError):
        return JSONResponse({"error": {"code": exc.code, "message": exc.message}}, status_code=exc.status)

    def store() -> Store:
        if app.state.store is None:
            cfg = load_config(config_path or os.environ.get("BURNCAL_CONFIG", "config/pipeline.toml"))
            try:
                app.state.store = Store(cfg)
            except FileNotFoundError as exc:
                raise ApiError(503, "no_data", str(exc)) from None
        return app.state.store

    class Selection:
        def __init__(
            self,
            geom: str | None = Query(None, description="GeoJSON Polygon / MultiPolygon / Feature (lon, lat)"),
            bbox: str | None = Query(None, description="west,south,east,north"),
            lat: float | None = None,
            lon: float | None = None,
            radius_km: float | None = None,
            region: str | None = Query(None, description="region id from /regions"),
            start: str | None = Query(None, description="YYYY-MM or YYYY-MM-DD"),
            end: str | None = Query(None, description="YYYY-MM or YYYY-MM-DD"),
            metric: str = Query("count", description="count | celldays"),
            st: Store = Depends(store),
        ):
            if metric not in ("count", "celldays"):
                raise ApiError(422, "invalid_metric", "metric must be 'count' or 'celldays'")
            self.st, self.metric = st, metric
            self.geom, self.describe = parse_selection(geom=geom, bbox=bbox, lat=lat, lon=lon, radius_km=radius_km,
                                                       region=region, regions=st.regions)
            self.start, self.end = _parse_date(start, "start"), _parse_date(end, "end", end=True)
            if self.start is not None and self.end is not None and self.start > self.end:
                raise ApiError(422, "invalid_date", "start must not be after end")

        def table(self) -> tuple[pd.DataFrame, list[str]]:
            df, used = self.st.calendar(self.geom, self.start, self.end)
            m = self.metric
            out = pd.DataFrame({"month": df["month"].dt.strftime("%Y-%m"), "year": df["year"], "moy": df["moy"],
                                "harmonized": df[f"h_{m}"], "lo": df[f"h_{m}_lo"], "hi": df[f"h_{m}_hi"]})
            for series, name in SERIES_OUT.items():
                out[name] = df[f"{m}_{series}"]
            out["source"], out["era"], out["method"] = df["source"], df["era"], df[f"method_{m}"]
            for c in ("terra_only", "partial", "days_observed", "days_in_month"):
                out[c] = df[c]
            return out, used

        def meta(self, used: list[str]) -> dict:
            st = self.st
            unit = ("MODIS-equivalent hotspots per month" if self.metric == "count"
                    else "MODIS-equivalent active cell-days per month (0.05 degree cells)")
            return {
                "selection": self.describe,
                "regions": used,
                "metric": self.metric,
                "unit": unit,
                "band": st.meta["uncertainty_band"],
                "include_nonveg_types": st.include_nonveg,
                "methods": {r: st.meta["selection"].get(f"viirs_snpp/{self.metric}", {}).get("method_by_region", {}).get(r)
                            for r in used},
                "pipeline_run_utc": st.meta["generated_utc"],
                "served_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "citation": CITATION,
            }

    def note_lines(sel: Selection, used: list[str], extra: list[str]) -> str:
        m = sel.meta(used)
        lines = [
            "Burning calendar - harmonized MODIS + VIIRS active-fire hotspots",
            "Selection: " + ", ".join(f"{k}={v}" for k, v in m["selection"].items() if k != "type")
            + f" ({m['selection']['type']}); regions: {', '.join(used)}",
            f"Unit: {m['unit']}",
            "Method: before 2012 observed MODIS (Terra+Aqua); Terra-only months (2000-11..2002-07) scaled to "
            "Terra+Aqua units; from 2012-02 VIIRS converted to MODIS-equivalent units with a transfer fitted on the "
            "MODIS/VIIRS overlap and chosen by leave-one-year-out validation. See METHODS.md.",
            f"Uncertainty (lo, hi): {m['band']}. Zero width where MODIS is observed directly.",
            "Hotspots are satellite pixel detections, not individual fires. Cloud and smoke hide fires.",
            *extra,
            f"Pipeline run {m['pipeline_run_utc']}; exported {m['served_utc']}.",
            CITATION,
        ]
        return "".join(f"# {line}\n" for line in lines)

    def csv_response(body: str, filename: str) -> Response:
        return Response(body, media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{filename}"'})

    # ------------------------------------------------------------------ routes

    @app.get("/health")
    def health():
        return {"status": "ok"}

    @app.get("/regions")
    def regions(st: Store = Depends(store)):
        lo, hi = st.data_range()
        return {
            "data_range": {"start": f"{lo:%Y-%m}", "end": f"{hi:%Y-%m}"},
            "regions": [
                {"id": rid, "name": info["name"], "bbox": info["bbox"],
                 "start": f"{st.series[rid]['month'].min():%Y-%m}", "end": f"{st.series[rid]['month'].max():%Y-%m}",
                 "coverage": [c for c in st.meta["coverage"] if c["region"] == rid]}
                for rid, info in st.regions.items()
            ],
            "citation": CITATION,
        }

    @app.get("/meta")
    def meta(st: Store = Depends(store)):
        return st.meta

    @app.get("/cells")
    def cells(start: str | None = None, end: str | None = None, metric: str = "count",
              region: str | None = None, st: Store = Depends(store)):
        """Harmonized total per 0.1 degree cell over the period (map layer)."""
        if metric not in ("count", "celldays"):
            raise ApiError(422, "invalid_metric", "metric must be 'count' or 'celldays'")
        if region and region not in st.regions:
            raise ApiError(404, "unknown_region", f"unknown region '{region}'")
        return st.cells(_parse_date(start, "start"), _parse_date(end, "end", end=True), metric, region)

    @app.get("/calendar")
    def calendar(sel: Selection = Depends(Selection)):
        table, used = sel.table()
        records = [{k: _clean(v) for k, v in row.items()} for row in table.to_dict("records")]
        return {"meta": sel.meta(used), "months": records}

    @app.get("/summary")
    def summary(sel: Selection = Depends(Selection)):
        df, used = sel.st.calendar(sel.geom, sel.start, sel.end)
        kpis = sel.st.summary(df, sel.metric)
        return {"meta": sel.meta(used), "kpis": kpis}

    @app.get("/calendar.csv")
    def calendar_csv(sel: Selection = Depends(Selection), notes: bool = True):
        table, used = sel.table()
        buf = io.StringIO()
        if notes:
            buf.write(note_lines(sel, used, [
                "Columns: harmonized = value to use; lo/hi = band; *_raw = unadjusted detections per sensor; "
                "source = sensor the harmonized value comes from; partial = month not fully observed."]))
        for name in SERIES_OUT.values():  # raw detections are whole numbers for both metrics
            table[name] = table[name].round().astype("Int64")
        table.to_csv(buf, index=False, float_format="%.3f", lineterminator="\n")
        return csv_response(buf.getvalue(), f"burning_calendar_{sel.metric}.csv")

    @app.get("/hotspots.csv")
    def hotspots_csv(sel: Selection = Depends(Selection), notes: bool = True):
        lo, hi = sel.st.data_range()
        d0 = (sel.start or lo).date()
        d1 = (sel.end or hi + pd.offsets.MonthEnd(0)).date()
        df = sel.st.hotspots(sel.geom, d0, d1)
        buf = io.StringIO()
        if notes:
            buf.write(note_lines(sel, sorted(df["region"].unique()), [
                "Rows: individual cleaned detections (MODIS confidence >= 30, VIIRS nominal/high), both sensors.",
                "harmonization_weight: what this detection adds to the harmonized count. The sum of this column "
                "equals the harmonized total. 0 = not used (other sensor is the source that month, or a "
                "non-vegetation type).",
                "type (standard processing only): 0 vegetation fire, 1 volcano, 2 other static land source, 3 offshore.",
            ]))
        df.to_csv(buf, index=False, float_format="%.5f", lineterminator="\n")
        return csv_response(buf.getvalue(), "hotspots.csv")

    return app


app = create_app()
