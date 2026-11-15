"""Export everything the website needs as static files, so it runs on plain web hosting
(Cloudflare R2 / any static host, no Python on the server).

out/
  index.json                 regions, coverage, run settings, uncertainty table, file sizes
  r/<region>/series.json     exact monthly region series (same numbers as the API's /calendar for the region)
  r/<region>/cells_h.bin     harmonized value per 0.1 deg cell and month          (map layer, custom areas)
  r/<region>/cells_raw.bin   raw counts per 0.1 deg cell, month and sensor series  (custom areas)
  r/<region>/weights.json    harmonization weight per 1 deg tile, month, predictor (hotspot export)
  r/<region>/hot/<YYYY-MM>.bin  every cleaned hotspot of that month                 (map points, hotspot export)
  map/tiles1.bin             harmonized value per 1 deg tile and month, whole world   (map layer when zoomed out)
  map/t1y.bin, map/t1m/<YYYY>.bin, r/<region>/hy.bin, r/<region>/hm/<YYYY>.bin
                             the same map values per year (y) and per month split by year (m), so the
                             map layer downloads only the years it shows (written by export_map)
  recent/<YYYY-MM-DD>.bin    every hotspot of each of the last RECENT_DAYS days, whole world (map points)

Binary files are little-endian column blocks, one after another, each column for all N rows.
N per file is in index.json. Layouts (column: type):
  cells_h.bin    m:u16 ix:u16 iy:u16 hc:f32 hd:f32
  cells_raw.bin  m:u16 ix:u16 iy:u16 s:u8 n:u32 cd:u16           (columns padded to 4-byte offsets)
  hot/<ym>.bin   lat:i32 lon:i32 frp:f32 day:u16 time:u16 sat:u8 conf:u8 type:i8 dn:u8 proc:u8
  map/tiles1.bin m:u16 tx:u16 ty:u16 hc:f32 hd:f32               (tx = floor(lon + 180), ty = floor(lat + 90))
  t1m/<Y>.bin, hm/<Y>.bin   same layout as tiles1.bin / cells_h.bin, rows of year Y only
  t1y.bin, hy.bin           y:u16 x:u16 y:u16 hc:f32 hd:f32  (y = year - 2000; sums over the year's months)
  t1y_all.bin, hy_all.bin   same layout, y = 65535, sums over every month in the data
  r/<region>/am/<cx>_<cy>.bin  custom areas: sums per 1 deg tile and month for one 5 deg chunk
                            (cx = tx // 5, cy = ty // 5). Header nr:u32 nh:u32, then
                            raw  m:u16 tx:u16 ty:u16 s:u8 n:u32 cd:u32  (nr rows)
                            h    m:u16 tx:u16 ty:u16 hc:f32 hd:f32       (nh rows)
  days/<YYYY>/<YYYY-MM-DD>.bin  map dots when zoomed out: an even random sample of at most DAY_SAMPLE
                            detections of that day, whole world. Header n:u32 total:u32 modis:u32 0:u32
                            (n sampled, the day's real total and real MODIS count), then the recent/ layout
  r/<region>/ac/<tx>_<ty>.bin  custom areas: the 0.1 deg cells of one 1 deg tile, same header, then
                            cells_raw layout (nr rows) and cells_h layout (nh rows)
  recent/<d>.bin lat:i32 lon:i32 frp:f32 time:u16 sat:u8 conf:u8
m = months since 2000-01, lat/lon in 1e-5 degrees, day = day of year - 1.
Codes: series  0 modis 1 terra 2 aqua 3 viirs_snpp 4 viirs_n20 5 viirs_n21
       sat     0 Terra 1 Aqua 2 SNPP 3 NOAA20 4 NOAA21
       conf    MODIS 0-100; VIIRS 201 low, 202 nominal, 203 high
       type    -1 unknown (NRT); dn 0 day, 1 night, 2 unknown; proc 0 standard, 1 NRT
"""
from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

from .config import duck_connect, SERIES, Config

SATS = ["Terra", "Aqua", "SNPP", "NOAA20", "NOAA21"]
RECENT_DAYS = 7
DAY_SAMPLE = 20_000  # detections per day in the zoomed-out dot files (days/)
PREDICTORS = ["modis", "terra", "aqua", "viirs_snpp", "viirs_n20", "viirs_n21"]
CITATION = (
    "Data: NASA FIRMS (Fire Information for Resource Management System), part of NASA LANCE/ESDIS - "
    "MODIS Collection 6.1 and VIIRS 375 m active fire products. https://firms.modaps.eosdis.nasa.gov/ "
    "Yearly country archives (MODIS from 1 Nov 2000, S-NPP from 20 Jan 2012, NOAA-20 from 1 Apr 2018, through 2022) "
    "and archive downloads 13 Nov 2022 - 13 Nov 2026 (S-NPP, NOAA-20, NOAA-21, MODIS), whole world."
)


def _month_index(s: pd.Series) -> np.ndarray:
    s = pd.to_datetime(s)
    return ((s.dt.year - 2000) * 12 + s.dt.month - 1).to_numpy(np.uint16)


def _write_blocks(path: Path, columns: list[np.ndarray]) -> int:
    """Write column blocks, padding so every block starts at a multiple of 4 bytes."""
    with open(path, "wb") as fh:
        for col in columns:
            data = np.ascontiguousarray(col).tobytes()
            fh.write(data)
            pad = (-len(data)) % 4
            if pad:
                fh.write(b"\0" * pad)
    return path.stat().st_size


def _clean(v):
    if isinstance(v, (np.floating, float)):
        return None if not np.isfinite(v) else round(float(v), 6)
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.bool_,)):
        return bool(v)
    return v


def run(cfg: Config, out: str, keep_hotspots: bool = False) -> None:
    hdir = cfg.processed / "harmonized"
    if not (hdir / "meta.json").exists():
        raise SystemExit("no harmonized data - run: python -m pipeline.run all")
    meta = json.loads((hdir / "meta.json").read_text("utf-8"))
    out_dir = Path(out)
    old_index = None
    if keep_hotspots and (out_dir / "index.json").exists():
        # Detection files depend only on the ingest, not on the calibration: keep them and rewrite the rest.
        old_index = json.loads((out_dir / "index.json").read_text("utf-8"))
        for d in ("map",):
            shutil.rmtree(out_dir / d, ignore_errors=True)
    else:
        if out_dir.exists():
            shutil.rmtree(out_dir)  # generated output only
        out_dir.mkdir(parents=True)
    old_hot = {r["id"]: r for r in old_index["regions"]} if old_index else {}
    con = duck_connect()
    k = meta["grid"]["cell_per_deg"] // meta["grid"]["tile_per_deg"]
    regions, total_bytes = [], 0

    for rid, info in meta["regions"].items():
        if not (hdir / "region_monthly" / f"region={rid}" / "data.parquet").exists():
            continue
        rdir = out_dir / "r" / rid
        (rdir / "hot").mkdir(parents=True, exist_ok=True)
        entry: dict = {"id": rid, "name": info["name"], "bbox": info["bbox"], "files": {}}

        # ---- exact region series
        s = pd.read_parquet(hdir / "region_monthly" / f"region={rid}" / "data.parquet")
        s["month"] = pd.to_datetime(s["month"]).dt.strftime("%Y-%m")
        series = {c: [_clean(v) for v in s[c].tolist()] for c in s.columns}
        (rdir / "series.json").write_text(json.dumps(series, separators=(",", ":")), "utf-8")
        entry["start"], entry["end"] = s["month"].iloc[0], s["month"].iloc[-1]

        # ---- harmonized cells
        cdir = hdir / "cells_monthly" / f"region={rid}"
        if any(cdir.glob("*/*.parquet")):
            h = con.execute(
                f"SELECT month, ix, iy, h_count, h_celldays FROM read_parquet('{cdir.as_posix()}/*/*.parquet') "
                "WHERE h_count > 0 OR h_celldays > 0 ORDER BY month, iy, ix").df()
        else:  # a block with no fire detections at all (open ocean)
            h = pd.DataFrame({"month": pd.Series(dtype="datetime64[ns]"), "ix": pd.Series(dtype="int64"),
                              "iy": pd.Series(dtype="int64"), "h_count": pd.Series(dtype="float64"),
                              "h_celldays": pd.Series(dtype="float64")})
        entry["files"]["cells_h"] = {"n": len(h), "bytes": _write_blocks(rdir / "cells_h.bin", [
            _month_index(h["month"]), h["ix"].to_numpy(np.uint16), h["iy"].to_numpy(np.uint16),
            h["h_count"].fillna(0).to_numpy(np.float32), h["h_celldays"].fillna(0).to_numpy(np.float32)])}

        # ---- raw cells per series
        r = pd.read_parquet(cfg.processed / "monthly_cells" / f"region={rid}" / "data.parquet")
        r = r.sort_values(["month", "series", "iy", "ix"])
        entry["files"]["cells_raw"] = {"n": len(r), "bytes": _write_blocks(rdir / "cells_raw.bin", [
            _month_index(r["month"]), r["ix"].to_numpy(np.uint16), r["iy"].to_numpy(np.uint16),
            r["series"].map({v: i for i, v in enumerate(SERIES)}).to_numpy(np.uint8),
            r["n"].to_numpy(np.uint32), r["celldays"].to_numpy(np.uint16)])}

        # ---- tile weights (count metric) for hotspot export
        w = pd.read_parquet(hdir / "tile_weights" / f"region={rid}" / "data.parquet")
        w = w[w["metric"] == "count"]
        weights = {"m": _month_index(w["month"]).tolist(), "tx": w["tx"].astype(int).tolist(),
                   "ty": w["ty"].astype(int).tolist(),
                   "p": w["predictor"].map({v: i for i, v in enumerate(PREDICTORS)}).astype(int).tolist(),
                   "w": [_clean(v) for v in w["weight"].tolist()]}
        (rdir / "weights.json").write_text(json.dumps(weights, separators=(",", ":")), "utf-8")

        # ---- hotspots per year
        src = f"read_parquet('{(cfg.processed / 'hotspots' / f'region={rid}').as_posix()}/*/*.parquet', hive_partitioning=true)"
        years = [] if rid in old_hot else [y for (y,) in con.execute(f"SELECT DISTINCT year FROM {src} ORDER BY 1").fetchall()]
        entry["hot"] = dict(old_hot[rid]["hot"]) if rid in old_hot else {}
        total_bytes += sum(v["bytes"] for v in entry["hot"].values()) if rid in old_hot else 0
        for year in years:
          py = con.execute(
              f"SELECT latitude, longitude, frp, acq_date, acq_time, satellite, confidence, type, daynight, proc "
              f"FROM {src} WHERE year = ? ORDER BY acq_date, acq_time", [year]).df()
          py["acq_date"] = pd.to_datetime(py["acq_date"])
          for mon, p in py.groupby(py["acq_date"].dt.month):
            key = f"{year}-{mon:02d}"
            day = (p["acq_date"] - pd.Timestamp(f"{year}-01-01")).dt.days.to_numpy(np.uint16)
            conf = p["confidence"].astype(str).str.lower()
            conf_code = np.where(conf.str[0] == "l", 201, np.where(conf.str[0] == "n", 202, np.where(conf.str[0] == "h", 203,
                                 pd.to_numeric(conf, errors="coerce").fillna(0).clip(0, 100)))).astype(np.uint8)
            size = _write_blocks(rdir / "hot" / f"{key}.bin", [
                np.round(p["latitude"].to_numpy() * 1e5).astype(np.int32),
                np.round(p["longitude"].to_numpy() * 1e5).astype(np.int32),
                p["frp"].fillna(np.nan).to_numpy(np.float32),
                day, pd.to_numeric(p["acq_time"], errors="coerce").fillna(0).to_numpy(np.uint16),
                p["satellite"].map({v: i for i, v in enumerate(SATS)}).to_numpy(np.uint8),
                conf_code,
                p["type"].fillna(-1).to_numpy(np.int8),
                p["daynight"].map({"D": 0, "N": 1}).fillna(2).to_numpy(np.uint8),
                (p["proc"] == "NRT").to_numpy(np.uint8)])
            entry["hot"][key] = {"n": len(p), "bytes": size, "last": str(p["acq_date"].max())[:10]}
            total_bytes += size
        entry["last_day"] = max(v["last"] for v in entry["hot"].values()) if entry["hot"] else None
        total_bytes += sum(f["bytes"] for f in entry["files"].values())
        regions.append(entry)
        print(f"[export] {rid}: {len(s)} months, {len(h):,} harmonized cell-months, {len(r):,} raw cell-months, "
              f"{sum(v['n'] for v in entry['hot'].values()):,} hotspots in {len(entry['hot'])} month files")

    # ---- world map layer (coarse): harmonized total per 1-degree tile and month
    (out_dir / "map").mkdir(exist_ok=True)
    t = con.execute(
        f"SELECT month, ix // {meta['grid']['cell_per_deg']} AS tx, iy // {meta['grid']['cell_per_deg']} AS ty, "
        f"sum(h_count) AS hc, sum(h_celldays) AS hd "
        f"FROM read_parquet('{(hdir / 'cells_monthly').as_posix()}/*/*/*.parquet', hive_partitioning=true) "
        "GROUP BY ALL HAVING sum(h_count) > 0 OR sum(h_celldays) > 0 ORDER BY month").df()
    tiles = {"n": len(t), "bytes": _write_blocks(out_dir / "map" / "tiles1.bin", [
        _month_index(t["month"]), t["tx"].to_numpy(np.uint16), t["ty"].to_numpy(np.uint16),
        t["hc"].fillna(0).to_numpy(np.float32), t["hd"].fillna(0).to_numpy(np.float32)])}
    total_bytes += tiles["bytes"]

    # ---- recent detections, whole world, one file per day
    last_day = max((r["last_day"] for r in regions if r["last_day"]), default=None)
    recent = old_index["recent"] if old_index else {}
    if not old_index:
        (out_dir / "recent").mkdir()
    if last_day and not old_index:
        hsrc = f"read_parquet('{(cfg.processed / 'hotspots').as_posix()}/*/*/*.parquet', hive_partitioning=true)"
        d = con.execute(
            f"SELECT latitude, longitude, frp, acq_date, acq_time, satellite, confidence FROM {hsrc} "
            f"WHERE acq_date > CAST(? AS DATE) - INTERVAL {RECENT_DAYS} DAY ORDER BY acq_date, acq_time", [last_day]).df()
        d["acq_date"] = pd.to_datetime(d["acq_date"]).dt.strftime("%Y-%m-%d")
        for day, p in d.groupby("acq_date"):
            conf = p["confidence"].astype(str).str.lower()
            conf_code = np.where(conf.str[0] == "l", 201, np.where(conf.str[0] == "n", 202, np.where(conf.str[0] == "h", 203,
                                 pd.to_numeric(conf, errors="coerce").fillna(0).clip(0, 100)))).astype(np.uint8)
            size = _write_blocks(out_dir / "recent" / f"{day}.bin", [
                np.round(p["latitude"].to_numpy() * 1e5).astype(np.int32),
                np.round(p["longitude"].to_numpy() * 1e5).astype(np.int32),
                p["frp"].to_numpy(np.float32),
                pd.to_numeric(p["acq_time"], errors="coerce").fillna(0).to_numpy(np.uint16),
                p["satellite"].map({v: i for i, v in enumerate(SATS)}).to_numpy(np.uint8), conf_code])
            recent[day] = {"n": len(p), "bytes": size}
            total_bytes += size
        print(f"[export] recent days: {', '.join(f'{k} ({v["n"]:,})' for k, v in recent.items())}")

    unc = pd.read_parquet(hdir / "uncertainty.parquet")
    index = {
        "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "pipeline_run_utc": meta["generated_utc"],
        "grid": meta["grid"],
        "cleaning": meta["cleaning"],
        "viirs_era_start": meta["viirs_era_start"],
        "band": meta["uncertainty_band"],
        "selection": meta["selection"],
        "coverage": meta["coverage"],
        "citation": CITATION,
        "data_range": {"start": min(r["start"] for r in regions), "end": max(r["end"] for r in regions)},
        "last_day": last_day,
        "series": list(SERIES),
        "predictors": PREDICTORS,
        "sats": SATS,
        "tiles_per_cell": k,
        "uncertainty": {c: [_clean(v) for v in unc[c].tolist()] for c in unc.columns},
        "regions": regions,
        "presets": [{"id": pid, "name": r.name, "bbox": list(r.bbox)} for pid, r in cfg.presets.items()],
        "map_tiles": tiles,
        "recent": recent,
    }
    (out_dir / "index.json").write_text(json.dumps(index, separators=(",", ":")), "utf-8")
    print(f"[export] wrote {out_dir} ({total_bytes / 1e6:.1f} MB of binary data)")
    export_map(cfg, out)


def _write_split(con, df: pd.DataFrame, xcol: str, ycol: str, yearly_path: Path, monthly_dir: Path) -> tuple[dict, dict, dict]:
    """Write sums over all months (y = 65535), per-year sums (one file) and the monthly rows
    split into one file per year."""
    shutil.rmtree(monthly_dir, ignore_errors=True)
    monthly_dir.mkdir(parents=True)
    df = df.assign(year=pd.to_datetime(df["month"]).dt.year)
    monthly = {}
    for year, g in df.groupby("year", sort=True):
        g = g.sort_values(["month", ycol, xcol])
        monthly[str(year)] = {"n": len(g), "bytes": _write_blocks(monthly_dir / f"{year}.bin", [
            _month_index(g["month"]), g[xcol].to_numpy(np.uint16), g[ycol].to_numpy(np.uint16),
            g["hc"].fillna(0).to_numpy(np.float32), g["hd"].fillna(0).to_numpy(np.float32)])}
    y = df.groupby(["year", xcol, ycol], as_index=False)[["hc", "hd"]].sum().sort_values(["year", ycol, xcol])
    yearly = {"n": len(y), "bytes": _write_blocks(yearly_path, [
        (y["year"] - 2000).to_numpy(np.uint16), y[xcol].to_numpy(np.uint16), y[ycol].to_numpy(np.uint16),
        y["hc"].to_numpy(np.float32), y["hd"].to_numpy(np.float32)])}
    a = df.groupby([xcol, ycol], as_index=False)[["hc", "hd"]].sum().sort_values([ycol, xcol])
    alltime = {"n": len(a), "bytes": _write_blocks(yearly_path.with_name(yearly_path.stem + "_all.bin"), [
        np.full(len(a), 65535, np.uint16), a[xcol].to_numpy(np.uint16), a[ycol].to_numpy(np.uint16),
        a["hc"].to_numpy(np.float32), a["hd"].to_numpy(np.float32)])}
    return alltime, yearly, monthly


def export_map(cfg: Config, out: str) -> None:
    """Map-layer files split by year (see module docstring). Reads the harmonized cells and adds
    the file list to an existing index.json, so it can run on its own after export-static."""
    hdir = cfg.processed / "harmonized"
    out_dir = Path(out)
    index = json.loads((out_dir / "index.json").read_text("utf-8"))
    meta = json.loads((hdir / "meta.json").read_text("utf-8"))
    k = meta["grid"]["cell_per_deg"]
    con = duck_connect()
    total = 0
    t = con.execute(
        f"SELECT month, ix // {k} AS tx, iy // {k} AS ty, sum(h_count) AS hc, sum(h_celldays) AS hd "
        f"FROM read_parquet('{(hdir / 'cells_monthly').as_posix()}/*/*/*.parquet', hive_partitioning=true) "
        "GROUP BY ALL HAVING sum(h_count) > 0 OR sum(h_celldays) > 0").df()
    index["map_tiles_all"], index["map_tiles_y"], index["map_tiles_m"] = _write_split(
        con, t, "tx", "ty", out_dir / "map" / "t1y.bin", out_dir / "map" / "t1m")
    total += index["map_tiles_all"]["bytes"] + index["map_tiles_y"]["bytes"] + sum(v["bytes"] for v in index["map_tiles_m"].values())
    for entry in index["regions"]:
        rid = entry["id"]
        cdir = hdir / "cells_monthly" / f"region={rid}"
        if not any(cdir.glob("*/*.parquet")):
            entry["files"]["hall"], entry["files"]["hy"], entry["files"]["hm"] = {"n": 0, "bytes": 0}, {"n": 0, "bytes": 0}, {}
            continue
        h = con.execute(
            f"SELECT month, ix, iy, h_count AS hc, h_celldays AS hd FROM read_parquet('{cdir.as_posix()}/*/*.parquet') "
            "WHERE h_count > 0 OR h_celldays > 0").df()
        rdir = out_dir / "r" / rid
        entry["files"]["hall"], entry["files"]["hy"], entry["files"]["hm"] = _write_split(con, h, "ix", "iy", rdir / "hy.bin", rdir / "hm")
        total += entry["files"]["hall"]["bytes"] + entry["files"]["hy"]["bytes"] + sum(v["bytes"] for v in entry["files"]["hm"].values())
    con.close()
    (out_dir / "index.json").write_text(json.dumps(index, separators=(",", ":")), "utf-8")
    print(f"[export-map] wrote year-split map files ({total / 1e6:.1f} MB)")
    export_areas(cfg, out)


def _write_two(path: Path, raw: list[np.ndarray], h: list[np.ndarray], nr: int, nh: int) -> int:
    """Header (nr, nh as u32) followed by two column-block sections."""
    with open(path, "wb") as fh:
        fh.write(np.array([nr, nh], np.uint32).tobytes())
        for col in raw + h:
            data = np.ascontiguousarray(col).tobytes()
            fh.write(data)
            pad = (-len(data)) % 4
            if pad:
                fh.write(b"\0" * pad)
    return path.stat().st_size


def export_areas(cfg: Config, out: str) -> None:
    """Files for drawn areas and quick areas, split by place (see module docstring): a shape reads
    1-degree tile sums for the tiles it covers completely and 0.1-degree cells only for the tiles on
    its edge, instead of every cell of every 30-degree block it touches."""
    hdir = cfg.processed / "harmonized"
    out_dir = Path(out)
    index = json.loads((out_dir / "index.json").read_text("utf-8"))
    k = json.loads((hdir / "meta.json").read_text("utf-8"))["grid"]["cell_per_deg"]
    con = duck_connect()
    total, files = 0, 0
    for entry in index["regions"]:
        rid = entry["id"]
        rdir = out_dir / "r" / rid
        for d in ("am", "ac"):
            shutil.rmtree(rdir / d, ignore_errors=True)
            (rdir / d).mkdir(parents=True)
        entry["files"]["am"] = []
        cdir = hdir / "cells_monthly" / f"region={rid}"
        rpath = cfg.processed / "monthly_cells" / f"region={rid}" / "data.parquet"
        if not any(cdir.glob("*/*.parquet")) or not rpath.exists():
            continue
        r = con.execute(f"SELECT month, ix, iy, series, n, celldays FROM read_parquet('{rpath.as_posix()}')").df()
        r["s"] = r["series"].map({v: i for i, v in enumerate(SERIES)}).astype(np.uint8)
        h = con.execute(
            f"SELECT month, ix, iy, h_count AS hc, h_celldays AS hd FROM read_parquet('{cdir.as_posix()}/*/*.parquet') "
            "WHERE h_count > 0 OR h_celldays > 0").df()
        for df in (r, h):
            df["m"] = _month_index(df["month"])
            df["tx"] = (df["ix"] // k).astype(np.uint16)
            df["ty"] = (df["iy"] // k).astype(np.uint16)
        # 0.1-degree cells per 1-degree tile
        rg, hg = dict(tuple(r.groupby(["tx", "ty"]))), dict(tuple(h.groupby(["tx", "ty"])))
        for key in set(rg) | set(hg):
            a = rg.get(key, r.iloc[0:0]).sort_values(["m", "s", "iy", "ix"])
            b = hg.get(key, h.iloc[0:0]).sort_values(["m", "iy", "ix"])
            total += _write_two(rdir / "ac" / f"{key[0]}_{key[1]}.bin", [
                a["m"].to_numpy(np.uint16), a["ix"].to_numpy(np.uint16), a["iy"].to_numpy(np.uint16),
                a["s"].to_numpy(np.uint8), a["n"].to_numpy(np.uint32), a["celldays"].to_numpy(np.uint16)], [
                b["m"].to_numpy(np.uint16), b["ix"].to_numpy(np.uint16), b["iy"].to_numpy(np.uint16),
                b["hc"].fillna(0).to_numpy(np.float32), b["hd"].fillna(0).to_numpy(np.float32)], len(a), len(b))
            files += 1
        # 1-degree tile sums per month, grouped into 5-degree chunks
        rt = r.groupby(["m", "tx", "ty", "s"], as_index=False)[["n", "celldays"]].sum()
        ht = h.groupby(["m", "tx", "ty"], as_index=False)[["hc", "hd"]].sum()
        for df in (rt, ht):
            df["cx"], df["cy"] = df["tx"] // 5, df["ty"] // 5
        rc, hc = dict(tuple(rt.groupby(["cx", "cy"]))), dict(tuple(ht.groupby(["cx", "cy"])))
        for key in sorted(set(rc) | set(hc)):
            a = rc.get(key, rt.iloc[0:0]).sort_values(["m", "s", "ty", "tx"])
            b = hc.get(key, ht.iloc[0:0]).sort_values(["m", "ty", "tx"])
            total += _write_two(rdir / "am" / f"{key[0]}_{key[1]}.bin", [
                a["m"].to_numpy(np.uint16), a["tx"].to_numpy(np.uint16), a["ty"].to_numpy(np.uint16),
                a["s"].to_numpy(np.uint8), a["n"].to_numpy(np.uint32), a["celldays"].to_numpy(np.uint32)], [
                b["m"].to_numpy(np.uint16), b["tx"].to_numpy(np.uint16), b["ty"].to_numpy(np.uint16),
                b["hc"].to_numpy(np.float32), b["hd"].to_numpy(np.float32)], len(a), len(b))
            entry["files"]["am"].append(f"{int(key[0])}_{int(key[1])}")
            files += 1
    con.close()
    (out_dir / "index.json").write_text(json.dumps(index, separators=(",", ":")), "utf-8")
    print(f"[export-areas] wrote {files:,} area files ({total / 1e6:.1f} MB)")
    export_days(cfg, out)


def export_days(cfg: Config, out: str) -> None:
    """Worldwide daily dot samples for the zoomed-out map (see module docstring). The sample is
    random but repeatable (rows ordered by a hash of position and time), so it is spread evenly over
    the day's fires; the header keeps the real totals so the site can estimate counts in view."""
    out_dir = Path(out)
    index = json.loads((out_dir / "index.json").read_text("utf-8"))
    ddir = out_dir / "days"
    shutil.rmtree(ddir, ignore_errors=True)
    con = duck_connect()
    hsrc = f"read_parquet('{(cfg.processed / 'hotspots').as_posix()}/*/*/*.parquet', hive_partitioning=true)"
    years = [y for (y,) in con.execute(f"SELECT DISTINCT year FROM {hsrc} ORDER BY 1").fetchall()]
    sat_code = {v: i for i, v in enumerate(SATS)}
    total, files = 0, 0
    for year in years:
        counts = {str(d)[:10]: (int(n), int(m)) for d, n, m in con.execute(
            f"SELECT acq_date, count(*), count(*) FILTER (WHERE satellite IN ('Terra', 'Aqua')) FROM {hsrc} "
            f"WHERE year = {int(year)} GROUP BY 1").fetchall()}
        # one month at a time: a whole VIIRS-era year does not fit the memory cap in one window sort
        d = pd.concat([con.execute(
            f"SELECT latitude, longitude, frp, acq_date, acq_time, satellite, confidence FROM {hsrc} "
            f"WHERE year = {int(year)} AND month(acq_date) = {mon} "
            f"QUALIFY row_number() OVER (PARTITION BY acq_date ORDER BY hash(latitude, longitude, acq_time, satellite)) <= {DAY_SAMPLE}"
        ).df() for mon in range(1, 13)], ignore_index=True)
        d["acq_date"] = pd.to_datetime(d["acq_date"]).dt.strftime("%Y-%m-%d")
        (ddir / str(year)).mkdir(parents=True, exist_ok=True)
        for day, p in d.groupby("acq_date"):
            p = p.sort_values("acq_time")
            conf = p["confidence"].astype(str).str.lower()
            conf_code = np.where(conf.str[0] == "l", 201, np.where(conf.str[0] == "n", 202, np.where(conf.str[0] == "h", 203,
                                 pd.to_numeric(conf, errors="coerce").fillna(0).clip(0, 100)))).astype(np.uint8)
            n_all, n_modis = counts[day]
            path = ddir / str(year) / f"{day}.bin"
            with open(path, "wb") as fh:
                fh.write(np.array([len(p), n_all, n_modis, 0], np.uint32).tobytes())
            cols = [np.round(p["latitude"].to_numpy() * 1e5).astype(np.int32),
                    np.round(p["longitude"].to_numpy() * 1e5).astype(np.int32),
                    p["frp"].to_numpy(np.float32),
                    pd.to_numeric(p["acq_time"], errors="coerce").fillna(0).to_numpy(np.uint16),
                    p["satellite"].map(sat_code).to_numpy(np.uint8), conf_code]
            with open(path, "ab") as fh:
                for col in cols:
                    data = np.ascontiguousarray(col).tobytes()
                    fh.write(data)
                    pad = (-len(data)) % 4
                    if pad:
                        fh.write(bytes(pad))
            total += path.stat().st_size
            files += 1
        print(f"[export-days] {year}: {d['acq_date'].nunique()} days", flush=True)
    con.close()
    index["day_sample"] = {"cap": DAY_SAMPLE, "files": files}
    (out_dir / "index.json").write_text(json.dumps(index, separators=(",", ":")), "utf-8")
    print(f"[export-days] wrote {files:,} day files ({total / 1e6:.1f} MB)")
