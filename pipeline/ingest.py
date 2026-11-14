"""Stage 1 - read FIRMS CSV files, normalize, clean, deduplicate, write hotspots Parquet.

Runs inside DuckDB so that large regions (tens of millions of rows) never have to
fit in pandas memory.

Field conventions were checked on 2026-11-12 against the FIRMS attribute page
(earthdata.nasa.gov/data/tools/firms/active-fire-data-attributes-modis-viirs):
  MODIS satellite: "A" = Aqua, "T" = Terra
  VIIRS satellite: "N" = Suomi NPP, "N20" = NOAA-20, "N21" = NOAA-21
  version: plain number = standard processing; suffix NRT / RT / URT = near-real-time family
  type (standard processing only): 0 vegetation fire, 1 volcano, 2 other static land source, 3 offshore
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import duckdb

from .config import Config, Region

STAGE_COLUMNS = """
    src_file VARCHAR, sensor VARCHAR, satellite VARCHAR, proc VARCHAR,
    latitude DOUBLE, longitude DOUBLE, acq_date DATE, acq_time VARCHAR,
    daynight VARCHAR, confidence VARCHAR, frp DOUBLE, brightness DOUBLE, type TINYINT
"""


def _sql_str(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _filename_hints(name: str) -> tuple[str | None, str | None]:
    """Satellite and processing-level hints from common FIRMS / pipeline file names."""
    low = name.lower()
    sat = None
    if "j1v" in low or "jpss1" in low or "noaa20" in low or "noaa-20" in low:
        sat = "NOAA20"
    elif "j2v" in low or "jpss2" in low or "noaa21" in low or "noaa-21" in low:
        sat = "NOAA21"
    elif "sv-c" in low or "snpp" in low or "suomi" in low:
        sat = "SNPP"
    proc = None
    if "nrt" in low:
        proc = "NRT"
    elif "archive" in low or "_sp" in low:
        proc = "SP"
    return sat, proc


def _select_for_file(con: duckdb.DuckDBPyConnection, path: Path) -> str:
    """Build the SELECT that maps one FIRMS CSV onto the staging schema."""
    src = f"read_csv({_sql_str(path.as_posix())}, all_varchar=true, header=true)"
    cols = {row[0].lower(): row[0] for row in con.execute(f"DESCRIBE SELECT * FROM {src}").fetchall()}

    def col(name: str) -> str:
        return '"' + cols[name] + '"'

    for required in ("latitude", "longitude", "acq_date", "acq_time", "confidence"):
        if required not in cols:
            raise ValueError(f"{path.name}: missing required FIRMS column '{required}'")

    sat_hint, proc_hint = _filename_hints(path.name)

    # The satellite is read per row. FIRMS writes it differently per product:
    #   country / API files:  MODIS "Terra"/"Aqua" or "T"/"A"; VIIRS "N", "N20", "N21" (with a bright_ti4 column)
    #   archive-download zips: VIIRS "SNPP", "N20", "N21" with a "brightness" column (no bright_ti4)
    # so the brightness column name cannot be used to tell the sensors apart.
    if "satellite" in cols:
        s = f"upper(trim({col('satellite')}))"
        mapped = (
            f"CASE WHEN {s} IN ('T', 'TERRA') THEN 'Terra' WHEN {s} IN ('A', 'AQUA') THEN 'Aqua' "
            f"WHEN {s} IN ('N', 'NPP', 'SNPP', 'S-NPP', 'SUOMI NPP', 'SUOMI-NPP') THEN 'SNPP' "
            f"WHEN {s} IN ('N20', 'NOAA20', 'NOAA-20', 'J1', 'JPSS1', 'JPSS-1') THEN 'NOAA20' "
            f"WHEN {s} IN ('N21', 'NOAA21', 'NOAA-21', 'J2', 'JPSS2', 'JPSS-2') THEN 'NOAA21' END"
        )
    else:
        mapped = "NULL"
    sat = f"COALESCE({mapped}, {_sql_str(sat_hint) if sat_hint else 'NULL'})"
    sensor = f"CASE WHEN {sat} IN ('Terra', 'Aqua') THEN 'MODIS' WHEN {sat} IS NOT NULL THEN 'VIIRS' END"
    if "bright_ti4" in cols:
        bright = col("bright_ti4")
    elif "brightness" in cols:
        bright = col("brightness")
    else:
        bright = "NULL"

    if "version" in cols:
        proc = f"CASE WHEN regexp_matches({col('version')}, '[A-Za-z]') THEN 'NRT' ELSE 'SP' END"
    elif proc_hint:
        proc = _sql_str(proc_hint)
    else:
        # Standard-processing files carry a 'type' column, NRT files do not.
        proc = "'SP'" if "type" in cols else "'NRT'"

    type_expr = f"TRY_CAST({col('type')} AS TINYINT)" if "type" in cols else "NULL"
    frp = f"TRY_CAST({col('frp')} AS DOUBLE)" if "frp" in cols else "NULL"
    daynight = f"upper(substr(trim({col('daynight')}), 1, 1))" if "daynight" in cols else "NULL"

    return f"""
        SELECT {_sql_str(path.name)}, {sensor}, {sat}, {proc},
               TRY_CAST({col('latitude')} AS DOUBLE), TRY_CAST({col('longitude')} AS DOUBLE),
               TRY_CAST({col('acq_date')} AS DATE),
               lpad(CAST(TRY_CAST(replace({col('acq_time')}, ':', '') AS INTEGER) AS VARCHAR), 4, '0'),
               {daynight}, lower(trim({col('confidence')})), {frp},
               TRY_CAST({bright} AS DOUBLE), {type_expr}
        FROM {src}
    """


def ingest_region(con: duckdb.DuckDBPyConnection, cfg: Config, region: Region) -> dict | None:
    files = sorted((cfg.raw / region.id).glob("*.csv"))
    if not files:
        print(f"[ingest] {region.id}: no CSV files in {cfg.raw / region.id} - skipped")
        return None

    con.execute(f"CREATE OR REPLACE TEMP TABLE stage ({STAGE_COLUMNS})")
    for path in files:
        con.execute("INSERT INTO stage " + _select_for_file(con, path))

    def count(where: str = "TRUE") -> int:
        return con.execute(f"SELECT count(*) FROM stage WHERE {where}").fetchone()[0]

    report: dict = {"files": [p.name for p in files], "rows_read": count()}

    bad_sat = con.execute(
        "SELECT src_file, count(*) FROM stage WHERE satellite IS NULL GROUP BY 1"
    ).fetchall()
    if bad_sat:
        raise ValueError(
            f"{region.id}: could not identify the satellite for rows in {bad_sat}. "
            "Rename the file so it contains SNPP / NOAA20 / NOAA21, or check its 'satellite' column."
        )

    con.execute(
        "DELETE FROM stage WHERE latitude IS NULL OR longitude IS NULL OR acq_date IS NULL OR acq_time IS NULL"
    )
    report["dropped_unparseable"] = report["rows_read"] - count()

    w, s, e, n = region.bbox
    before = count()
    con.execute(
        f"DELETE FROM stage WHERE NOT (longitude >= {w} AND longitude < {e} AND latitude >= {s} AND latitude < {n})"
    )
    report["dropped_outside_bbox"] = before - count()

    before = count()
    keep_viirs = ", ".join(_sql_str(v) for v in cfg.viirs_keep_confidence)
    con.execute(
        f"""
        DELETE FROM stage WHERE NOT CASE sensor
            WHEN 'MODIS' THEN COALESCE(TRY_CAST(confidence AS DOUBLE) >= {cfg.modis_min_confidence}, FALSE)
            ELSE substr(confidence, 1, 1) IN ({keep_viirs}) END
        """
    )
    report["dropped_low_confidence"] = before - count()

    # NRT vs SP: wherever standard processing exists for a satellite, it wins.
    before = count()
    con.execute(
        """
        DELETE FROM stage USING (
            SELECT satellite, max(acq_date) AS sp_max FROM stage WHERE proc = 'SP' GROUP BY 1
        ) sp
        WHERE stage.proc = 'NRT' AND stage.satellite = sp.satellite AND stage.acq_date <= sp.sp_max
        """
    )
    report["dropped_nrt_superseded_by_sp"] = before - count()

    # Exact duplicates (overlapping downloads of the same detections).
    before = count()
    con.execute(
        """
        CREATE OR REPLACE TEMP TABLE stage AS
        SELECT * EXCLUDE (rn) FROM (
            SELECT *, row_number() OVER (
                PARTITION BY satellite, acq_date, acq_time, round(latitude, 4), round(longitude, 4)
                ORDER BY proc DESC, src_file) AS rn
            FROM stage)
        WHERE rn = 1
        """
    )
    report["dropped_duplicates"] = before - count()
    report["rows_kept"] = count()
    report["by_satellite"] = {
        f"{sat}/{proc}": {"rows": rows, "first": str(first), "last": str(last)}
        for sat, proc, rows, first, last in con.execute(
            "SELECT satellite, proc, count(*), min(acq_date), max(acq_date) FROM stage GROUP BY 1, 2 ORDER BY 1, 2"
        ).fetchall()
    }
    report["type_counts_sp"] = {
        str(t): c
        for t, c in con.execute(
            "SELECT type, count(*) FROM stage WHERE type IS NOT NULL GROUP BY 1 ORDER BY 1"
        ).fetchall()
    }

    out = cfg.processed / "hotspots" / f"region={region.id}"
    if out.exists():
        shutil.rmtree(out)  # derived output of this stage only; raw CSVs are never touched
    out.mkdir(parents=True)
    con.execute(
        f"""
        COPY (SELECT sensor, satellite, proc, latitude, longitude, acq_date, acq_time, daynight,
                     confidence, frp, brightness, type, year(acq_date) AS year
              FROM stage ORDER BY acq_date, satellite)
        TO {_sql_str(out.as_posix())} (FORMAT PARQUET, PARTITION_BY (year), COMPRESSION ZSTD)
        """
    )
    print(
        f"[ingest] {region.id}: read {report['rows_read']:,} rows from {len(files)} files, "
        f"kept {report['rows_kept']:,}"
    )
    return report


def run(cfg: Config, only: list[str] | None = None) -> dict:
    con = duckdb.connect()
    report_path = cfg.processed / "ingest_report.json"
    reports = json.loads(report_path.read_text("utf-8")) if report_path.exists() else {}
    for rid, region in cfg.regions.items():
        if only and rid not in only:
            continue
        result = ingest_region(con, cfg, region)
        if result is not None:
            reports[rid] = result
    cfg.processed.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(reports, indent=2), "utf-8")
    return reports
