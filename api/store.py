"""Data access: answers selections from the pipeline's Parquet outputs with DuckDB.

How a selection is answered exactly without scanning every hotspot:
  1. The geometry is clipped to each region's bbox.
  2. Grid cells fully inside the geometry are summed from pre-aggregated Parquet.
  3. Only cells crossing the geometry's edge fall back to individual hotspots:
     bbox prefilter in DuckDB, then an exact point-in-polygon test (shapely).
Harmonized value = sum over hotspots of their tile's harmonization weight (see METHODS.md 4).
"""
from __future__ import annotations

import json
from collections import OrderedDict

import duckdb
import numpy as np
import pandas as pd
import shapely

from pipeline.config import METRICS, SAT_TO_SERIES, SERIES, Config
from pipeline.uncertainty import BandLookup

from .geometry import ApiError, classify_cells

MAX_EDGE_POINTS = 2_000_000      # hotspots needing an exact point-in-polygon test, per region
MAX_EXPORT_ROWS = 500_000        # rows in one /hotspots.csv response
FLAG_COLS = ["month", "year", "moy", "source", "era", "terra_only", "partial", "days_observed", "days_in_month"]


class Store:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        hdir = cfg.processed / "harmonized"
        if not (hdir / "meta.json").exists():
            raise FileNotFoundError(
                f"no harmonized data in {hdir}. Run: python -m pipeline.run all")
        self.meta = json.loads((hdir / "meta.json").read_text("utf-8"))
        self.regions: dict = self.meta["regions"]
        self.include_nonveg: bool = self.meta["cleaning"]["include_nonveg_types"]
        self.C = self.meta["grid"]["cell_per_deg"]
        self.F = self.meta["grid"]["fine_per_deg"]
        self.k = self.C // self.meta["grid"]["tile_per_deg"]
        self.series, self.weights = {}, {}
        for rid in self.regions:
            self.series[rid] = pd.read_parquet(hdir / "region_monthly" / f"region={rid}" / "data.parquet")
            w = pd.read_parquet(hdir / "tile_weights" / f"region={rid}" / "data.parquet")
            w = w.pivot_table(index=["month", "tx", "ty", "predictor"], columns="metric", values="weight", aggfunc="first")
            w = w.reindex(columns=list(METRICS)).rename(columns={m: f"w_{m}" for m in METRICS}).reset_index()
            self.weights[rid] = w
        self.bands = BandLookup(pd.read_parquet(hdir / "uncertainty.parquet"))
        self.con = duckdb.connect()
        self._cache: OrderedDict = OrderedDict()

    # ------------------------------------------------------------------ helpers

    def _path(self, *parts: str) -> str:
        return self.cfg.processed.joinpath(*parts).as_posix()

    def _clips(self, geom):
        out = []
        for rid, info in self.regions.items():
            clip = geom.intersection(shapely.box(*info["bbox"]))
            if not clip.is_empty and clip.area > 0:
                out.append((rid, clip))
        if not out:
            raise ApiError(404, "outside_coverage",
                           "the selection does not overlap any region with data. See /regions for available areas.")
        return out

    def data_range(self) -> tuple[pd.Timestamp, pd.Timestamp]:
        return (min(s["month"].min() for s in self.series.values()),
                max(s["month"].max() for s in self.series.values()))

    # ------------------------------------------------------------------ calendar

    def _region_calendar(self, rid: str, clip, m0: pd.Timestamp, m1: pd.Timestamp) -> pd.DataFrame | None:
        base = self.series[rid]
        base = base[(base["month"] >= m0) & (base["month"] <= m1)].reset_index(drop=True)
        if base.empty:
            return None
        months = pd.Index(base["month"], name="month")
        raw = {m: pd.DataFrame(0.0, index=months, columns=list(SERIES)) for m in METRICS}
        harm = pd.DataFrame(0.0, index=months, columns=list(METRICS))
        d0, d1 = m0.date(), (m1 + pd.offsets.MonthEnd(0)).date()
        interior, edge = classify_cells(clip, self.C)
        cur = self.con.cursor()

        if len(interior):
            cur.register("interior", interior)
            q = cur.execute(
                f"""SELECT month, series, sum(n)::DOUBLE AS count, sum(celldays)::DOUBLE AS celldays
                    FROM read_parquet('{self._path("monthly_cells", f"region={rid}", "data.parquet")}')
                    SEMI JOIN interior USING (ix, iy)
                    WHERE month BETWEEN ? AND ? GROUP BY ALL""", [d0, d1]).df()
            q["month"] = pd.to_datetime(q["month"])
            for m in METRICS:
                raw[m] = raw[m].add(q.pivot(index="month", columns="series", values=m), fill_value=0.0)[list(SERIES)]
            hdir = self.cfg.processed / "harmonized" / "cells_monthly" / f"region={rid}"
            if any(hdir.glob("*/*.parquet")):
                q = cur.execute(
                    f"""SELECT month, sum(h_count) AS count, sum(h_celldays) AS celldays
                        FROM read_parquet('{hdir.as_posix()}/*/*.parquet') SEMI JOIN interior USING (ix, iy)
                        WHERE month BETWEEN ? AND ? GROUP BY ALL""", [d0, d1]).df()
                q["month"] = pd.to_datetime(q["month"])
                harm = harm.add(q.set_index("month")[list(METRICS)], fill_value=0.0)

        if len(edge):
            cur.register("edge", edge)
            w, s, e, n = clip.bounds
            veg = "" if self.include_nonveg else "AND (type IS NULL OR type = 0)"
            pts = cur.execute(
                f"""SELECT latitude, longitude, acq_date, satellite, ix, iy FROM (
                        SELECT latitude, longitude, acq_date, satellite,
                               CAST(floor((longitude + 180) * {self.C}) AS INTEGER) AS ix,
                               CAST(floor((latitude + 90) * {self.C}) AS INTEGER) AS iy
                        FROM read_parquet('{self._path("hotspots", f"region={rid}")}/*/*.parquet', hive_partitioning=true)
                        WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?
                          AND acq_date BETWEEN ? AND ? {veg})
                    SEMI JOIN edge USING (ix, iy) LIMIT {MAX_EDGE_POINTS + 1}""", [s, n, w, e, d0, d1]).df()
            if len(pts) > MAX_EDGE_POINTS:
                raise ApiError(413, "selection_too_large",
                               "the selection boundary crosses too many hotspots to test exactly. "
                               "Use a simpler shape, a smaller area, or a shorter date range.")
            shapely.prepare(clip)
            pts = pts[shapely.intersects_xy(clip, pts["longitude"].to_numpy(), pts["latitude"].to_numpy())].copy()
            if len(pts):
                pts["acq_date"] = pd.to_datetime(pts["acq_date"])
                pts["month"] = pts["acq_date"].dt.to_period("M").dt.to_timestamp()
                pts["series"] = pts["satellite"].map(SAT_TO_SERIES)
                pts["fx"] = np.floor((pts["longitude"] + 180) * self.F).astype("int64")
                pts["fy"] = np.floor((pts["latitude"] + 90) * self.F).astype("int64")
                pts["tx"], pts["ty"] = pts["ix"] // self.k, pts["iy"] // self.k
                both = pd.concat([pts, pts[pts["series"].isin(["terra", "aqua"])].assign(series="modis")])
                uniq = both.drop_duplicates(["series", "fx", "fy", "acq_date"])
                for m, frame in (("count", both), ("celldays", uniq)):
                    add = frame.groupby(["month", "series"]).size().unstack(fill_value=0).astype(float)
                    raw[m] = raw[m].add(add, fill_value=0.0).reindex(months)[list(SERIES)]
                keys = ["month", "series", "tx", "ty"]
                t = pd.concat([both.groupby(keys).size().rename("count"),
                               uniq.groupby(keys).size().rename("celldays")], axis=1).fillna(0.0).reset_index()
                t = t.merge(base[["month", "source"]], on="month")
                t = t[t["series"] == t["source"]]
                t = t.merge(self.weights[rid], how="left", left_on=["month", "tx", "ty", "source"],
                            right_on=["month", "tx", "ty", "predictor"])
                observed = (t["source"] == "modis").to_numpy()
                for m in METRICS:
                    value = t[m].to_numpy() * np.where(observed, 1.0, t[f"w_{m}"].to_numpy())
                    harm[m] = harm[m].add(pd.Series(value).groupby(t["month"].to_numpy()).sum(), fill_value=0.0)

        out = base[FLAG_COLS].copy()
        for m in METRICS:
            for s in SERIES:
                covered = base[f"{m}_{s}"].notna().to_numpy()
                out[f"{m}_{s}"] = np.where(covered, raw[m][s].reindex(months).fillna(0.0).to_numpy(), np.nan)
            has_h = base[f"h_{m}"].notna().to_numpy()
            out[f"h_{m}"] = np.where(has_h, harm[m].reindex(months).fillna(0.0).to_numpy(), np.nan)
            out[f"method_{m}"] = base[f"method_{m}"].to_numpy()
        return out

    def calendar(self, geom, start: pd.Timestamp | None, end: pd.Timestamp | None) -> tuple[pd.DataFrame, list[str]]:
        """Monthly table for a selection: raw series, harmonized values and 5-95 % band, flags."""
        lo_m, hi_m = self.data_range()
        m0 = (start or lo_m).to_period("M").to_timestamp()
        m1 = (end or hi_m).to_period("M").to_timestamp()
        key = (geom.wkb, m0, m1)
        if key in self._cache:
            self._cache.move_to_end(key)
            return self._cache[key]

        frames, used = [], []
        for rid, clip in self._clips(geom):
            f = self._region_calendar(rid, clip, m0, m1)
            if f is not None:
                frames.append(f)
                used.append(rid)
        if not frames:
            raise ApiError(404, "no_data_in_range",
                           f"no data between {m0:%Y-%m} and {m1:%Y-%m}. Data covers {lo_m:%Y-%m} to {hi_m:%Y-%m}.")

        if len(frames) == 1:
            df = frames[0]
        else:  # selection spans several regions: add values, combine flags
            cat = pd.concat(frames)
            num = [c for c in cat.columns if c.startswith(("count_", "celldays_", "h_"))]
            g = cat.groupby("month")
            df = g[num].sum(min_count=1)
            df["year"], df["moy"] = df.index.year, df.index.month
            df["source"] = g["source"].agg(lambda s: "+".join(sorted(set(s))))
            df["era"] = g["era"].agg(lambda s: "+".join(sorted(set(s))))
            for m in METRICS:
                df[f"method_{m}"] = g[f"method_{m}"].agg(lambda s: "+".join(sorted(set(s))))
            df["terra_only"], df["partial"] = g["terra_only"].any(), g["partial"].any()
            df["days_observed"], df["days_in_month"] = g["days_observed"].min(), g["days_in_month"].max()
            df = df.reset_index()

        detections = sum(np.nansum(df[f"count_{s}"].to_numpy()) for s in ("modis", "viirs_snpp", "viirs_n20", "viirs_n21"))
        if detections == 0:
            raise ApiError(404, "empty_selection",
                           "no hotspots were detected inside this selection in the chosen date range. "
                           "Try a larger area or a longer period.")

        for m in METRICS:
            h = df[f"h_{m}"].to_numpy(float)
            lo, hi = np.full(len(df), np.nan), np.full(len(df), np.nan)
            for source in df["source"].unique():
                sel = (df["source"] == source).to_numpy()
                if source == "modis":
                    lo[sel] = hi[sel] = h[sel]      # observed, no transfer applied
                else:
                    lo[sel], hi[sel] = self.bands.band(source, m, used[0], h[sel])
            df[f"h_{m}_lo"], df[f"h_{m}_hi"] = lo, hi

        self._cache[key] = (df, used)
        if len(self._cache) > 64:
            self._cache.popitem(last=False)
        return df, used

    # ------------------------------------------------------------------ map layer

    def cells(self, start: pd.Timestamp | None, end: pd.Timestamp | None, metric: str, region: str | None) -> dict:
        """Harmonized totals per grid cell over a period, for the map layer. Compact column arrays."""
        lo_m, hi_m = self.data_range()
        d0 = (start or lo_m).to_period("M").to_timestamp().date()
        d1 = (end or hi_m).to_period("M").to_timestamp().date()
        lon, lat, val = [], [], []
        cur = self.con.cursor()
        for rid in self.regions:
            if region and rid != region:
                continue
            hdir = self.cfg.processed / "harmonized" / "cells_monthly" / f"region={rid}"
            if not any(hdir.glob("*/*.parquet")):
                continue
            q = cur.execute(
                f"""SELECT ix, iy, sum(h_{metric}) AS v FROM read_parquet('{hdir.as_posix()}/*/*.parquet')
                    WHERE month BETWEEN ? AND ? GROUP BY ALL HAVING sum(h_{metric}) > 0""", [d0, d1]).df()
            lon += np.round(q["ix"] / self.C - 180, 4).tolist()
            lat += np.round(q["iy"] / self.C - 90, 4).tolist()
            val += np.round(q["v"], 2).tolist()
        return {"cell_deg": 1 / self.C, "start": f"{d0:%Y-%m}", "end": f"{d1:%Y-%m}", "metric": metric,
                "west": lon, "south": lat, "value": val}

    # ------------------------------------------------------------------ KPIs

    @staticmethod
    def summary(df: pd.DataFrame, metric: str) -> dict:
        col = f"h_{metric}"
        done = df[~df["partial"] & df[col].notna()]
        out: dict = {"n_months": int(len(df)), "n_complete_months": int(len(done))}
        raw = "count" if metric == "count" else "celldays"
        out["totals"] = {
            "harmonized": float(df[col].sum()),
            "modis_raw": float(df[f"{raw}_modis"].sum()),
            **{f"{s}_raw": float(df[f"{raw}_{s}"].sum()) for s in ("viirs_snpp", "viirs_n20", "viirs_n21")},
        }
        if done.empty:
            return out
        ref = done.iloc[-1]
        others = done[(done["moy"] == ref["moy"]) & (done["month"] != ref["month"])][col]
        median = float(others.median()) if len(others) else None
        out["latest_month"] = {
            "month": f"{ref['month']:%Y-%m}",
            "value": float(ref[col]),
            "historical_median": median,
            "ratio_to_median": float(ref[col] / median) if median else None,
            "percentile_rank": float(100.0 * (others <= ref[col]).mean()) if len(others) else None,
            "n_other_years": int(len(others)),
            "note": "last complete month; compared with the same calendar month in the other years of the selection",
        }
        by_moy, basis = done.groupby("moy")[col].median(), "median"
        if by_moy.max() == 0:  # sparse selection: every monthly median is 0, so rank months by their mean
            by_moy, basis = done.groupby("moy")[col].mean(), "mean"
        if by_moy.max() > 0:
            out["peak_month"] = {"moy": int(by_moy.idxmax()), "value": float(by_moy.max()), "basis": basis}
        years = done.groupby("year")[col].agg(["sum", "size"])
        years = years[years["size"] == 12]
        if len(years):
            out["record_year"] = {"year": int(years["sum"].idxmax()), "value": float(years["sum"].max()),
                                  "n_complete_years": int(len(years))}
        return out

    # ------------------------------------------------------------------ hotspots export

    def hotspots(self, geom, d0, d1) -> pd.DataFrame:
        """Individual hotspots inside the geometry, with the weight each carries in the harmonized series."""
        frames, total = [], 0
        cur = self.con.cursor()
        for rid, clip in self._clips(geom):
            w, s, e, n = clip.bounds
            src = f"read_parquet('{self._path('hotspots', f'region={rid}')}/*/*.parquet', hive_partitioning=true)"
            where = "latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ? AND acq_date BETWEEN ? AND ?"
            args = [s, n, w, e, d0, d1]
            total += cur.execute(f"SELECT count(*) FROM {src} WHERE {where}", args).fetchone()[0]
            if total > MAX_EXPORT_ROWS:
                raise ApiError(413, "export_too_large",
                               f"more than {MAX_EXPORT_ROWS:,} hotspots fall in this area and period. "
                               "Shorten the date range or reduce the area, then export again.")
            p = cur.execute(
                f"""SELECT latitude, longitude, acq_date, acq_time, sensor, satellite, proc AS processing,
                           confidence, frp AS frp_mw, daynight, type FROM {src} WHERE {where}""", args).df()
            shapely.prepare(clip)
            p = p[shapely.intersects_xy(clip, p["longitude"].to_numpy(), p["latitude"].to_numpy())].copy()
            if p.empty:
                continue
            p["acq_date"] = pd.to_datetime(p["acq_date"])
            p["month"] = p["acq_date"].dt.to_period("M").dt.to_timestamp()
            p["series"] = p["satellite"].map(SAT_TO_SERIES)
            p["tx"] = np.floor((p["longitude"] + 180) * self.C).astype("int64") // self.k
            p["ty"] = np.floor((p["latitude"] + 90) * self.C).astype("int64") // self.k
            p = p.merge(self.series[rid][["month", "source"]], on="month", how="left")
            p = p.merge(self.weights[rid][["month", "tx", "ty", "predictor", "w_count"]], how="left",
                        left_on=["month", "tx", "ty", "series"], right_on=["month", "tx", "ty", "predictor"])
            observed = (p["source"] == "modis") & p["series"].isin(["terra", "aqua"])
            used = (observed | (p["series"] == p["source"])) & (self.include_nonveg | p["type"].isna() | (p["type"] == 0))
            p["harmonization_weight"] = np.where(used, np.where(observed, 1.0, p["w_count"]), 0.0)
            p["in_harmonized_series"] = used
            p["region"] = rid
            frames.append(p)
        if not frames:
            raise ApiError(404, "empty_selection",
                           "no hotspots were detected inside this selection in the chosen date range.")
        out = pd.concat(frames, ignore_index=True).sort_values(["acq_date", "acq_time", "satellite"])
        out["acq_date"] = out["acq_date"].dt.strftime("%Y-%m-%d")
        return out[["latitude", "longitude", "acq_date", "acq_time", "sensor", "satellite", "processing",
                    "confidence", "frp_mw", "daynight", "type", "region", "in_harmonized_series",
                    "harmonization_weight"]]
