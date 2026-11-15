"""Stage 1 (worldwide) - read every FIRMS archive-download zip, clean, deduplicate, and write
hotspots Parquet split by world block and year.

Input: the folders listed under [paths] zips in config/pipeline.toml, holding DL_FIRE_*.zip files
(zips inside zips are fine). Landsat zips (DL_FIRE_LS_*) are skipped: they are not part of the
MODIS/VIIRS record. Each CSV is extracted to a temporary file, read by DuckDB, and deleted.

Cleaning is the same as pipeline/ingest.py (see METHODS.md section 2):
  MODIS confidence >= cleaning.modis_min_confidence; VIIRS confidence in viirs_keep_confidence;
  near-real-time rows dropped where standard processing exists for that satellite and day;
  exact duplicates removed. The vegetation-type filter is applied later, in the grid stage.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import time
import zipfile
from pathlib import Path

import duckdb

from .config import duck_connect, Config
from .ingest import STAGE_COLUMNS, _select_for_file, _sql_str

COLS = "src_file, sensor, satellite, proc, latitude, longitude, acq_date, acq_time, daynight, confidence, frp, brightness, type"


def _zips(cfg: Config) -> list[Path]:
    found = []
    for folder in cfg.zips:
        if folder.exists():
            found += sorted(p for p in folder.rglob("*.zip"))
    if not found:
        raise SystemExit(f"no zip files in {', '.join(str(z) for z in cfg.zips)}")
    return found


def _block_expr(cfg: Config) -> str:
    """SQL giving the world-block id of a row, matching config.world_blocks()."""
    deg = next(iter(cfg.regions.values())).bbox
    size = deg[2] - deg[0]
    nx, ny = int(360 / size), int(180 / size)
    bx = f"least(greatest(CAST(floor((longitude + 180) / {size}) AS INTEGER), 0), {nx - 1})"
    by = f"least(greatest(CAST(floor((latitude + 90) / {size}) AS INTEGER), 0), {ny - 1})"
    w = f"(-180 + {bx} * {size})"
    s = f"(-90 + {by} * {size})"
    return (f"'w' || lpad(CAST(abs(CAST({w} AS INTEGER)) AS VARCHAR), 3, '0') || CASE WHEN {w} >= 0 THEN 'e' ELSE 'w' END"
            f" || '_' || lpad(CAST(abs(CAST({s} AS INTEGER)) AS VARCHAR), 2, '0') || CASE WHEN {s} >= 0 THEN 'n' ELSE 's' END")


def _csv_members(path: Path, tmp: Path):
    """Yield (label, extracted csv path) for every CSV in a zip, descending into inner zips."""
    if path.name.upper().startswith("DL_FIRE_LS_"):
        print(f"[ingest] {path.name}: skipped (Landsat is not part of the MODIS/VIIRS record)", flush=True)
        return
    with zipfile.ZipFile(path) as zf:
        for m in zf.infolist():
            name = Path(m.filename).name
            if name.lower().endswith(".zip"):
                inner = tmp / name
                with zf.open(m) as src, open(inner, "wb") as dst:
                    shutil.copyfileobj(src, dst, 1 << 22)
                yield from _csv_members(inner, tmp)
                inner.unlink()
            elif name.lower().endswith(".csv"):
                out = tmp / f"{path.stem}__{name}"
                with zf.open(m) as src, open(out, "wb") as dst:
                    shutil.copyfileobj(src, dst, 1 << 22)
                yield f"{path.stem}/{name}", out
                out.unlink()


def run(cfg: Config) -> dict:
    cfg.processed.mkdir(parents=True, exist_ok=True)
    db = cfg.processed / "stage.duckdb"
    db.unlink(missing_ok=True)
    tmp = Path(tempfile.mkdtemp(dir=cfg.processed))
    con = duck_connect(str(db))
    con.execute(f"SET temp_directory = {_sql_str((tmp / 'spill').as_posix())}")
    con.execute("SET preserve_insertion_order = false")
    con.execute(f"CREATE TABLE stage ({STAGE_COLUMNS})")
    report: dict = {"files": {}}
    t0 = time.time()
    try:
        seen = set()
        for z in _zips(cfg):
            for label, csv in _csv_members(z, tmp):
                if label in seen:  # the same request zip downloaded twice
                    print(f"[ingest] {label}: already read, skipped", flush=True)
                    continue
                seen.add(label)
                before = con.execute("SELECT count(*) FROM stage").fetchone()[0]
                sql = _select_for_file(con, csv).replace(_sql_str(csv.name), _sql_str(label), 1)
                con.execute(f"INSERT INTO stage {sql}")
                n = con.execute("SELECT count(*) FROM stage").fetchone()[0] - before
                report["files"][label] = n
                print(f"[ingest] {label}: {n:,} rows ({time.time() - t0:,.0f} s)", flush=True)

        def count(where: str = "TRUE") -> int:
            return con.execute(f"SELECT count(*) FROM stage WHERE {where}").fetchone()[0]

        report["rows_read"] = count()
        bad = con.execute("SELECT src_file, count(*) FROM stage WHERE satellite IS NULL GROUP BY 1").fetchall()
        if bad:
            raise ValueError(f"could not identify the satellite for rows in {bad}")
        con.execute("DELETE FROM stage WHERE latitude IS NULL OR longitude IS NULL OR acq_date IS NULL OR acq_time IS NULL")
        report["dropped_unparseable"] = report["rows_read"] - count()

        before = count()
        keep_viirs = ", ".join(_sql_str(v) for v in cfg.viirs_keep_confidence)
        con.execute(f"""
            DELETE FROM stage WHERE NOT CASE sensor
                WHEN 'MODIS' THEN COALESCE(TRY_CAST(confidence AS DOUBLE) >= {cfg.modis_min_confidence}, FALSE)
                ELSE substr(confidence, 1, 1) IN ({keep_viirs}) END""")
        report["dropped_low_confidence"] = before - count()

        before = count()
        con.execute("""
            DELETE FROM stage USING (
                SELECT satellite, max(acq_date) AS sp_max FROM stage WHERE proc = 'SP' GROUP BY 1
            ) sp
            WHERE stage.proc = 'NRT' AND stage.satellite = sp.satellite AND stage.acq_date <= sp.sp_max""")
        report["dropped_nrt_superseded_by_sp"] = before - count()
        print(f"[ingest] cleaning done ({time.time() - t0:,.0f} s); removing duplicates", flush=True)

        out = cfg.processed / "hotspots"
        if out.exists():
            shutil.rmtree(out)
        out.mkdir(parents=True)
        block = _block_expr(cfg)
        # Duplicates share acq_date, so removing them one year at a time gives exactly the same result
        # as one pass over everything, while the sort spills only one year to disk (the 20+ year
        # archive does not fit the temp space otherwise). Each year writes its own year=Y folders.
        years = [y for (y,) in con.execute("SELECT DISTINCT year(acq_date) FROM stage ORDER BY 1").fetchall()]
        for y in years:
            con.execute(f"""
                COPY (
                    SELECT sensor, satellite, proc, latitude, longitude, acq_date, acq_time, daynight, confidence, frp,
                           brightness, type, {block} AS region, year(acq_date) AS year
                    FROM (
                        SELECT *, row_number() OVER (
                            PARTITION BY satellite, acq_date, acq_time, round(latitude, 4), round(longitude, 4)
                            ORDER BY proc DESC, src_file) AS rn
                        FROM stage WHERE year(acq_date) = {int(y)})
                    WHERE rn = 1
                ) TO {_sql_str(out.as_posix())} (FORMAT PARQUET, PARTITION_BY (region, year), COMPRESSION ZSTD,
                                                 OVERWRITE_OR_IGNORE, FILENAME_PATTERN 'data_{int(y)}_{{i}}')""")
            print(f"[ingest] {y}: duplicates removed and written ({time.time() - t0:,.0f} s)", flush=True)
        kept = con.execute(f"SELECT count(*) FROM read_parquet('{out.as_posix()}/*/*/*.parquet')").fetchone()[0]
        report["dropped_duplicates"] = count() - kept
        report["rows_kept"] = kept
        report["by_satellite"] = {
            f"{sat}/{proc}": {"rows": rows, "first": str(first), "last": str(last)}
            for sat, proc, rows, first, last in con.execute(
                f"SELECT satellite, proc, count(*), min(acq_date), max(acq_date) "
                f"FROM read_parquet('{out.as_posix()}/*/*/*.parquet') GROUP BY 1, 2 ORDER BY 1, 2").fetchall()
        }
        report["blocks"] = {
            r: n for r, n in con.execute(
                f"SELECT region, count(*) FROM read_parquet('{out.as_posix()}/*/*/*.parquet', hive_partitioning=true) "
                "GROUP BY 1 ORDER BY 2 DESC").fetchall()
        }
    finally:
        con.close()
        db.unlink(missing_ok=True)
        shutil.rmtree(tmp, ignore_errors=True)
    (cfg.processed / "ingest_report.json").write_text(json.dumps(report, indent=2), "utf-8")
    print(f"[ingest] kept {report['rows_kept']:,} of {report['rows_read']:,} rows in {len(report['blocks'])} blocks "
          f"({time.time() - t0:,.0f} s)", flush=True)
    return report
