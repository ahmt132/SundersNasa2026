"""Stage 3 - calibrate, validate, and assemble the final harmonized series.

Final series rule, per region and month:
  before viirs_era_start
      Terra and Aqua both complete      -> observed MODIS, weight 1
      Aqua missing or incomplete        -> Terra scaled to Terra+Aqua units, flagged terra_only
  from viirs_era_start
      first VIIRS satellite in viirs_priority with a complete month and a fitted transfer
                                        -> VIIRS converted to MODIS-equivalent units
      otherwise complete MODIS if present, otherwise the best partial record (flagged partial)

Outputs (data/processed/harmonized/):
  region_monthly/region=<id>/data.parquet   one row per month: raw series, harmonized, band, flags
  tile_weights/region=<id>/data.parquet     harmonization weight per 1-degree tile, month, predictor
  cells_monthly/region=<id>/year=<y>/       harmonized values on the shared 0.1-degree grid
  uncertainty.parquet                       residual quantile table used for the bands
  meta.json                                 selected methods, coverage, run settings
reports/:
  validation_metrics.csv, loyo_region_monthly.parquet, validation_<region>.png
"""
from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone

import duckdb
import numpy as np
import pandas as pd

from . import validate
from .config import duck_connect, METRICS, SERIES, Config
from .transfer import LEVEL_NAMES, fit_hierarchy, predict
from .uncertainty import BandLookup, build_table

SINGLE = ("terra", "aqua", "viirs_snpp", "viirs_n20", "viirs_n21")
LABELS = {
    "terra": "MODIS Terra",
    "viirs_snpp": "VIIRS S-NPP",
    "viirs_n20": "VIIRS NOAA-20",
    "viirs_n21": "VIIRS NOAA-21",
}


def _month(text: str) -> pd.Timestamp:
    return pd.Timestamp(text + "-01")


# ------------------------------------------------------------------ inputs


def load_tiles(cfg: Config, con: duckdb.DuckDBPyConnection) -> pd.DataFrame:
    if not list((cfg.processed / "monthly_cells").glob("*/data.parquet")):
        raise SystemExit(
            "[harmonize] no gridded data found. Put FIRMS CSV files in data/raw/<region_id>/ "
            "(see docs/DATA_DOWNLOAD.md), then run: python -m pipeline.run all"
        )
    src = (cfg.processed / "monthly_cells").as_posix()
    k = cfg.cells_per_tile
    df = con.execute(
        f"""
        SELECT region, month, ix // {k} AS tx, iy // {k} AS ty, series,
               sum(n)::DOUBLE AS count, sum(celldays)::DOUBLE AS celldays
        FROM read_parquet('{src}/*/data.parquet', hive_partitioning=true)
        GROUP BY ALL
        """
    ).df()
    df["month"] = pd.to_datetime(df["month"])
    df["region"] = df["region"].astype(str)
    return df[df["region"].isin(cfg.regions)]


def load_coverage(cfg: Config, regions: list[str]) -> pd.DataFrame:
    """First / last date per region and satellite, with quiet edges snapped (see config [coverage])."""
    cov = pd.read_parquet(cfg.processed / "coverage.parquet")
    cov = cov[cov["region"].isin(regions)].copy()
    cov["first_date"] = pd.to_datetime(cov["first_date"])
    cov["last_date"] = pd.to_datetime(cov["last_date"])
    snap = pd.Timedelta(days=cfg.snap_days)
    newest = cov.groupby("series")["last_date"].transform("max")
    cov.loc[newest - cov["last_date"] <= snap, "last_date"] = newest
    for series, start in cfg.nominal_start.items():
        start = pd.Timestamp(start)
        hit = (cov["series"] == series) & (cov["first_date"] >= start) & (cov["first_date"] - start <= snap)
        cov.loc[hit, "first_date"] = start
    return cov


def month_state(cov: pd.DataFrame) -> pd.DataFrame:
    """Per region and month: for each series 'full' / 'partial' / 'none' and days observed."""
    rows = []
    for r in cov.itertuples():
        for m in pd.date_range(r.first_date.replace(day=1), r.last_date, freq="MS"):
            end = m + pd.offsets.MonthEnd(0)
            days = (min(end, r.last_date) - max(m, r.first_date)).days + 1
            rows.append((r.region, m, r.series, days))
    long = pd.DataFrame(rows, columns=["region", "month", "series", "days"])
    days = long.pivot(index=["region", "month"], columns="series", values="days")
    days = days.reindex(columns=list(SINGLE)).fillna(0).astype(int)
    dim = days.index.get_level_values("month").days_in_month.to_numpy()
    state = pd.DataFrame(index=days.index)
    for s in SINGLE:
        state[f"s_{s}"] = np.where(days[s] == dim, "full", np.where(days[s] > 0, "partial", "none"))
        state[f"d_{s}"] = days[s]
    both = (state["s_terra"] == "full") & (state["s_aqua"] == "full")
    any_modis = (days["terra"] > 0) | (days["aqua"] > 0)
    state["s_modis"] = np.where(both, "full", np.where(any_modis, "partial", "none"))
    state["d_modis"] = np.minimum(days["terra"], days["aqua"])
    state["days_in_month"] = dim
    return state.reset_index()


GAP_OTHER_MIN = 50  # detections by another satellite that make a zero month implausible


def mark_gaps(state: pd.DataFrame, tiles: pd.DataFrame) -> pd.DataFrame:
    """Mark months where a satellite's file is missing, so they are 'none' instead of zero fires.

    Coverage is first..last date per satellite, so a missing year file in the middle would
    otherwise read as a year without fires. Two rules:
      - a calendar year in which the satellite has no detection at all in the region;
      - a month in which it has none while another satellite has GAP_OTHER_MIN or more
        (a missing file or an outage; both mean "not observed", not "no fire"). The other
        satellite is taken from the same instrument family (Terra/Aqua, or the VIIRS trio).
    """
    counts = tiles.pivot_table(index=["region", "month"], columns="series", values="count", aggfunc="sum", fill_value=0)
    counts = counts.reindex(columns=list(SINGLE), fill_value=0)
    st = state.set_index(["region", "month"])
    c = counts.reindex(st.index, fill_value=0)
    years = c.groupby([c.index.get_level_values("region"), c.index.get_level_values("month").year]).transform("sum")
    flagged = []
    for s in SINGLE:
        observed = st[f"s_{s}"] != "none"
        # compare within the same instrument family: MODIS and VIIRS differ ~3x in counts,
        # so a VIIRS-only month is normal, but Terra 50 vs Aqua 0 is not.
        family = ["terra", "aqua"] if s in ("terra", "aqua") else ["viirs_snpp", "viirs_n20", "viirs_n21"]
        others = c[[f for f in family if f != s]].max(axis=1)
        gap = observed & ((years[s] == 0) | ((c[s] == 0) & (others >= GAP_OTHER_MIN)))
        if gap.any():
            st.loc[gap, f"s_{s}"] = "none"
            st.loc[gap, f"d_{s}"] = 0
            for (region, month) in gap[gap].index:
                flagged.append((region, s, month))
    if flagged:
        df = pd.DataFrame(flagged, columns=["region", "series", "month"])
        for (region, s), g in df.groupby(["region", "series"]):
            print(f"[harmonize] {region} {s}: {len(g)} month(s) with no data treated as not observed "
                  f"({g.month.min():%Y-%m} .. {g.month.max():%Y-%m})")
    # recompute the combined MODIS state from the corrected single-satellite states
    both = (st["s_terra"] == "full") & (st["s_aqua"] == "full")
    any_modis = (st["s_terra"] != "none") | (st["s_aqua"] != "none")
    st["s_modis"] = np.where(both, "full", np.where(any_modis, "partial", "none"))
    st["d_modis"] = np.minimum(st["d_terra"], st["d_aqua"])
    return st.reset_index()


def make_pairs(wide: pd.DataFrame, state: pd.DataFrame, predictor: str, start, end) -> pd.DataFrame:
    """Tile-months where predictor and both MODIS satellites have a complete month."""
    ok = state[
        (state[f"s_{predictor}"] == "full")
        & (state["s_modis"] == "full")
        & (state["month"] >= start)
        & (state["month"] <= end)
    ][["region", "month"]]
    df = wide.merge(ok, on=["region", "month"])
    df = df.assign(x=df[predictor], y=df["modis"])
    df = df[(df["x"] > 0) | (df["y"] > 0)]
    df = df[["region", "month", "tx", "ty", "x", "y"]].copy()
    df["year"] = df["month"].dt.year
    df["moy"] = df["month"].dt.month
    return df.reset_index(drop=True)


# ------------------------------------------------------------------ main


def run(cfg: Config, figures: bool = True) -> dict:
    con = duck_connect()
    tiles = load_tiles(cfg, con)
    if tiles.empty:
        raise SystemExit("[harmonize] no gridded data found - run the ingest and grid stages first")
    regions = sorted(tiles["region"].unique())
    cov = load_coverage(cfg, regions)
    state = mark_gaps(month_state(cov), tiles)

    wide = {}
    for metric in METRICS:
        w = tiles.pivot_table(index=["region", "month", "tx", "ty"], columns="series",
                              values=metric, aggfunc="sum", fill_value=0.0)
        wide[metric] = w.reindex(columns=list(SERIES), fill_value=0.0).reset_index()

    last_month = state["month"].max()
    overlap = (_month(cfg.overlap_start), _month(cfg.overlap_end) if cfg.overlap_end else last_month)
    terra_window = (_month(cfg.terra_fit_start), _month(cfg.terra_fit_end))
    predictors = ["terra", *cfg.viirs_priority]

    score_frames, loyo_frames, residual_frames, weight_frames = [], [], [], []
    selection: dict[str, dict] = {}
    loyo_rm: dict[tuple[str, str], pd.DataFrame] = {}

    for predictor in predictors:
        window = terra_window if predictor == "terra" else overlap
        for metric in METRICS:
            pairs = make_pairs(wide[metric], state, predictor, *window)
            key = f"{predictor}/{metric}"
            if pairs.empty:
                print(f"[harmonize] {key}: no overlap with MODIS - no transfer fitted")
                continue

            validated = pairs["year"].nunique() >= 2
            if validated:
                held = validate.loyo(pairs, cfg)
                rm = validate.region_monthly(held, cfg)
                scores = validate.score(rm, cfg, predictor, metric)
                chosen = validate.select(scores, cfg)
                validated = validate.ALL in chosen
            if validated:
                score_frames.append(scores)
                loyo_rm[(predictor, metric)] = rm
                loyo_frames.append(rm.assign(predictor=predictor, metric=metric))
            else:
                # Fewer than two usable years: nothing to validate against, so use the
                # simplest method and say so in meta.json.
                chosen = {validate.ALL: "ratio"}
            default = chosen[validate.ALL]
            by_region = {r: chosen.get(r, default) for r in regions}
            selection[key] = {
                "validated": bool(validated),
                "method_by_region": by_region,
                "fit_window": [str(window[0].date()), str(window[1].date())],
                "n_tile_months": int(len(pairs)),
                "years": sorted(int(y) for y in pairs["year"].unique()),
            }

            if validated:
                for region, method in by_region.items():
                    col = f"pred_{method}"
                    for frame in (held[held["region"] == region], rm[rm["region"] == region]):
                        residual_frames.append(pd.DataFrame({
                            "predictor": predictor, "metric": metric, "region": region,
                            "pred": frame[col].to_numpy(float), "obs": frame["y"].to_numpy(float)}))

            # Final fit on every available year, applied to every tile-month of the predictor.
            models = {m: fit_hierarchy(pairs, m, cfg.min_pairs, cfg.max_fit_points, cfg.seed)
                      for m in set(by_region.values())}
            app = wide[metric][["region", "month", "tx", "ty", predictor]].rename(columns={predictor: "x"})
            app = app[app["x"] > 0].copy()
            app["moy"] = app["month"].dt.month
            for region, g in app.groupby("region"):
                pred, level = predict(models[by_region[region]], g)
                weight_frames.append(pd.DataFrame({
                    "region": region, "month": g["month"].to_numpy(), "tx": g["tx"].to_numpy(),
                    "ty": g["ty"].to_numpy(), "predictor": predictor, "metric": metric,
                    "raw": g["x"].to_numpy(), "harmonized": pred, "weight": pred / g["x"].to_numpy(),
                    "level": [LEVEL_NAMES[i] if i >= 0 else "none" for i in level]}))
            print(f"[harmonize] {key}: {len(pairs):,} tile-months, "
                  f"{'validated' if validated else 'NOT validated'}, methods {sorted(set(by_region.values()))}")

    weights = pd.concat(weight_frames, ignore_index=True) if weight_frames else pd.DataFrame(
        columns=["region", "month", "tx", "ty", "predictor", "metric", "raw", "harmonized", "weight", "level"])
    unc_table = build_table(pd.concat(residual_frames, ignore_index=True) if residual_frames
                            else pd.DataFrame(columns=["predictor", "metric", "region", "pred", "obs"]))
    bands = BandLookup(unc_table)
    fitted = {p for p in predictors if f"{p}/count" in selection and f"{p}/celldays" in selection}

    # ---------------------------------------------------------- final series
    era_start = _month(cfg.viirs_era_start)

    def choose(row) -> str:
        st = {s: row[f"s_{s}"] for s in SERIES}
        viirs = [p for p in cfg.viirs_priority if p in fitted]
        if row["month"] >= era_start:
            for p in viirs:
                if st[p] == "full":
                    return p
            if st["modis"] == "full":
                return "modis"
            for p in viirs:
                if st[p] == "partial":
                    return p
            return "modis" if st["modis"] != "none" else "none"
        if st["modis"] == "full":
            return "modis"
        if st["terra"] != "none" and st["aqua"] != "full":
            return "terra"
        return "modis" if st["modis"] != "none" else "none"

    state["source"] = state.apply(choose, axis=1)
    state = state[state["source"] != "none"].reset_index(drop=True)

    h_tot = weights.groupby(["region", "month", "predictor", "metric"])["harmonized"].sum(min_count=1)
    out_dir = cfg.processed / "harmonized"
    out_dir.mkdir(parents=True, exist_ok=True)
    series_frames = []
    for region in regions:
        st = state[state["region"] == region].sort_values("month").reset_index(drop=True)
        out = st[["month"]].copy()
        out["year"] = out["month"].dt.year
        out["moy"] = out["month"].dt.month
        src = st["source"].to_numpy()
        for metric in METRICS:
            w = wide[metric]
            raw = w[w["region"] == region].groupby("month")[list(SERIES)].sum()
            raw = raw.reindex(st["month"]).fillna(0.0)
            for s in SERIES:
                vals = raw[s].to_numpy()
                out[f"{metric}_{s}"] = np.where(st[f"s_{s}"].to_numpy() == "none", np.nan, vals)

            h = np.full(len(st), np.nan)
            lo, hi = h.copy(), h.copy()
            method = np.full(len(st), "", dtype=object)
            for source in np.unique(src):
                sel = src == source
                months = st.loc[sel, "month"]
                if source == "modis":
                    h[sel] = raw["modis"].to_numpy()[sel]
                    lo[sel] = hi[sel] = h[sel]
                    method[sel] = "observed"
                    continue
                if source not in fitted:
                    method[sel] = "no_transfer"
                    continue
                try:
                    tot = h_tot.xs((region, source, metric), level=("region", "predictor", "metric"))
                except KeyError:
                    tot = pd.Series(dtype=float)
                h[sel] = tot.reindex(months).fillna(0.0).to_numpy()
                lo[sel], hi[sel] = bands.band(source, metric, region, h[sel])
                method[sel] = selection[f"{source}/{metric}"]["method_by_region"][region]
            out[f"h_{metric}"], out[f"h_{metric}_lo"], out[f"h_{metric}_hi"] = h, lo, hi
            out[f"method_{metric}"] = method

        out["source"] = src
        out["era"] = np.where(src == "terra", "modis_terra_only",
                              np.where(src == "modis", "modis_observed", "viirs_transfer"))
        out["terra_only"] = src == "terra"
        d_obs = np.array([st.loc[i, f"d_{s}"] for i, s in enumerate(src)])
        out["days_observed"] = d_obs
        out["days_in_month"] = st["days_in_month"].to_numpy()
        out["partial"] = d_obs < out["days_in_month"].to_numpy()

        path = out_dir / "region_monthly" / f"region={region}"
        path.mkdir(parents=True, exist_ok=True)
        out.to_parquet(path / "data.parquet", index=False)
        series_frames.append(out.assign(region=region))

        wpath = out_dir / "tile_weights" / f"region={region}"
        wpath.mkdir(parents=True, exist_ok=True)
        weights[weights["region"] == region].drop(columns="region").to_parquet(wpath / "data.parquet", index=False)

    unc_table.to_parquet(out_dir / "uncertainty.parquet", index=False)

    # ---------------------------------------------------------- harmonized cells on the shared grid
    src_df = state[["region", "month", "source"]]  # noqa: F841  (queried by DuckDB below)
    w_df = weights.pivot_table(index=["region", "month", "tx", "ty", "predictor"], columns="metric",
                               values="weight", aggfunc="first").reset_index()
    for metric in METRICS:
        if metric not in w_df.columns:
            w_df[metric] = np.nan
    k = cfg.cells_per_tile
    for region in regions:
        cdir = out_dir / "cells_monthly" / f"region={region}"
        if cdir.exists():
            shutil.rmtree(cdir)
        cdir.mkdir(parents=True)
        cells = (cfg.processed / "monthly_cells" / f"region={region}" / "data.parquet").as_posix()
        con.execute(
            f"""
            COPY (
                SELECT c.month, c.ix, c.iy, s.source, c.n AS raw_count, c.celldays AS raw_celldays,
                       c.n * CASE WHEN s.source = 'modis' THEN 1.0 ELSE w.count END AS h_count,
                       c.celldays * CASE WHEN s.source = 'modis' THEN 1.0 ELSE w.celldays END AS h_celldays,
                       year(c.month) AS year
                FROM read_parquet('{cells}') c
                JOIN src_df s ON s.region = '{region}' AND CAST(s.month AS DATE) = c.month AND s.source = c.series
                LEFT JOIN w_df w ON w.region = '{region}' AND CAST(w.month AS DATE) = c.month
                     AND w.tx = c.ix // {k} AND w.ty = c.iy // {k} AND w.predictor = s.source
                ORDER BY c.month, c.iy, c.ix
            ) TO '{cdir.as_posix()}' (FORMAT PARQUET, PARTITION_BY (year), COMPRESSION ZSTD)
            """
        )

    # ---------------------------------------------------------- reports
    cfg.reports.mkdir(parents=True, exist_ok=True)
    scores_all = pd.concat(score_frames, ignore_index=True) if score_frames else pd.DataFrame()
    if not scores_all.empty:
        picked = []
        for r in scores_all.itertuples():
            by_region = selection[f"{r.predictor}/{r.metric}"]["method_by_region"]
            picked.append(r.method == by_region.get(r.region, "") if r.region != validate.ALL else False)
        scores_all["selected"] = picked
        scores_all.to_csv(cfg.reports / "validation_metrics.csv", index=False, float_format="%.4f")
        pd.concat(loyo_frames, ignore_index=True).to_parquet(cfg.reports / "loyo_region_monthly.parquet", index=False)

    if figures and not scores_all.empty:
        for region in regions:
            for predictor in cfg.viirs_priority:
                rm = loyo_rm.get((predictor, "count"))
                if rm is None or region not in set(rm["region"]):
                    continue
                method = selection[f"{predictor}/count"]["method_by_region"][region]
                sc = scores_all[(scores_all["predictor"] == predictor) & (scores_all["metric"] == "count")
                                & (scores_all["region"] == region)].set_index("method")
                validate.figure(rm[rm["region"] == region], method, sc.loc["raw"].to_dict(),
                                sc.loc[method].to_dict(), cfg.regions[region].name, LABELS[predictor],
                                cfg.reports / f"validation_{region}.png")
                break

    meta = {
        "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "regions": {r: {"name": cfg.regions[r].name, "bbox": list(cfg.regions[r].bbox)} for r in regions},
        "grid": {"cell_per_deg": cfg.cell_per_deg, "fine_per_deg": cfg.fine_per_deg, "tile_per_deg": cfg.tile_per_deg},
        "cleaning": {"modis_min_confidence": cfg.modis_min_confidence,
                     "viirs_keep_confidence": list(cfg.viirs_keep_confidence),
                     "include_nonveg_types": cfg.include_nonveg_types},
        "viirs_era_start": cfg.viirs_era_start,
        "viirs_priority": list(cfg.viirs_priority),
        "uncertainty_band": "empirical 5th-95th percentile of leave-one-year-out residuals",
        "selection": selection,
        "coverage": [
            {"region": r.region, "series": r.series, "first": str(r.first_date.date()), "last": str(r.last_date.date())}
            for r in cov.sort_values(["region", "series"]).itertuples()
        ],
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2), "utf-8")
    print(f"[harmonize] wrote harmonized series for {len(regions)} region(s) to {out_dir}")
    return {"meta": meta, "scores": scores_all, "series": pd.concat(series_frames, ignore_index=True)}
