"""Import FIRMS archive-download zips (DL_FIRE_*.zip) into data/raw/<region>/.

FIRMS "Archive Download" requests arrive as zips named DL_FIRE_<source>_<request>.zip:
  M-C61   MODIS Collection 6.1          SV-C2   VIIRS S-NPP 375 m
  J1V-C2  VIIRS NOAA-20 375 m           J2V-C2  VIIRS NOAA-21 375 m
  LS      Landsat 30 m (not part of the MODIS/VIIRS harmonization; skipped)
Each zip holds fire_archive_*.csv (standard processing) and usually fire_nrt_*.csv (recent days).

Every row is routed to each configured region whose bbox contains it, so one request
covering several regions, or a region split over several requests, both work. Rows that
fall in no region are counted and the extent of the data is printed, so a missing region
can be added to config/pipeline.toml. A folder downloaded from Google Drive may contain
zips inside zips; those are unpacked to a temporary folder first.
"""
from __future__ import annotations

import io
import shutil
import tempfile
import zipfile
from pathlib import Path

from .config import Config

SKIP_SOURCES = {"LS": "Landsat 30 m is not part of the MODIS/VIIRS record"}


def _source(name: str) -> str:
    stem = Path(name).stem  # DL_FIRE_SV-C2_848633
    parts = stem.split("_")
    return parts[2] if len(parts) >= 4 and parts[0] == "DL" else "?"


def _route_csv(raw: io.BufferedReader, label: str, cfg: Config, out_dirs: dict, stats: dict) -> None:
    header = raw.readline()
    if b"latitude" not in header.lower():
        print(f"[import] {label}: not a FIRMS CSV, skipped")
        return
    writers: dict[str, io.BufferedWriter] = {}
    boxes = [(rid, r.bbox) for rid, r in cfg.regions.items()]
    lat_min = lon_min = 1e9
    lat_max = lon_max = -1e9
    n = outside = 0
    try:
        for line in raw:
            parts = line.split(b",", 2)
            try:
                lat, lon = float(parts[0]), float(parts[1])
            except (ValueError, IndexError):
                continue
            n += 1
            lat_min, lat_max = min(lat_min, lat), max(lat_max, lat)
            lon_min, lon_max = min(lon_min, lon), max(lon_max, lon)
            hit = False
            for rid, (w, s, e, nn) in boxes:
                if s <= lat < nn and w <= lon < e:
                    if rid not in writers:
                        path = out_dirs[rid] / f"zip_{label}"
                        writers[rid] = open(path.with_suffix(".part"), "wb")
                        writers[rid].write(header)
                    writers[rid].write(line if line.endswith(b"\n") else line + b"\n")
                    stats.setdefault(rid, 0)
                    stats[rid] += 1
                    hit = True
            outside += not hit
    except BaseException:
        for f in writers.values():
            f.close()
            Path(f.name).unlink(missing_ok=True)
        raise
    for rid, f in writers.items():
        f.close()
        Path(f.name).replace(Path(f.name).with_suffix(".csv"))
    extent = f"lon {lon_min:.2f}..{lon_max:.2f}, lat {lat_min:.2f}..{lat_max:.2f}" if n else "empty"
    print(f"[import] {label}: {n:,} rows ({extent}); in a region: {', '.join(writers) or 'none'}; outside all regions: {outside:,}")
    stats["_outside"] = stats.get("_outside", 0) + outside


def _walk_zip(path: Path, cfg: Config, out_dirs: dict, stats: dict, tmp: Path) -> None:
    source = _source(path.name)
    if source in SKIP_SOURCES:
        print(f"[import] {path.name}: skipped ({SKIP_SOURCES[source]})")
        return
    with zipfile.ZipFile(path) as zf:
        for member in zf.infolist():
            if member.is_dir():
                continue
            name = Path(member.filename).name
            if name.lower().endswith(".zip"):
                inner = tmp / name
                with zf.open(member) as src, open(inner, "wb") as dst:
                    shutil.copyfileobj(src, dst, 1 << 20)
                _walk_zip(inner, cfg, out_dirs, stats, tmp)
                inner.unlink()
            elif name.lower().endswith(".csv"):
                label = f"{path.stem}_{Path(name).stem}.csv"
                with zf.open(member) as src:
                    _route_csv(io.BufferedReader(src, 1 << 20), label, cfg, out_dirs, stats)


def run(cfg: Config, folder: str) -> dict:
    root = Path(folder)
    if not root.exists():
        raise SystemExit(f"{root} does not exist")
    out_dirs = {rid: cfg.raw / rid for rid in cfg.regions}
    for d in out_dirs.values():
        d.mkdir(parents=True, exist_ok=True)
    stats: dict = {}
    files = sorted(p for p in root.rglob("*") if p.is_file() and p.suffix.lower() in (".zip", ".csv"))
    if not files:
        raise SystemExit(f"no .zip or .csv files under {root}")
    with tempfile.TemporaryDirectory(dir=cfg.processed.parent if cfg.processed.parent.exists() else None) as tmp:
        for path in files:
            if path.suffix.lower() == ".zip":
                _walk_zip(path, cfg, out_dirs, stats, Path(tmp))
            else:
                with open(path, "rb") as src:
                    _route_csv(io.BufferedReader(src, 1 << 20), path.name, cfg, out_dirs, stats)
    outside = stats.pop("_outside", 0)
    print("[import] rows per region:", {k: f"{v:,}" for k, v in stats.items()}, f"| outside every region: {outside:,}")
    if outside:
        print("[import] Rows outside every region are not used. Add a [regions.<id>] entry covering them if they matter.")
    return stats
