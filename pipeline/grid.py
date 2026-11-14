"""Stage 2 - put both sensors on a common unit.

Outputs per region:
  daily_grid/     daily hotspot counts per satellite on the shared grid (default 0.1 deg)
  monthly_cells/  monthly counts and "active cell-days" per series on the shared grid
  coverage.parquet first / last acquisition date per region and satellite

Grid indices are global and integer:  ix = floor((lon + 180) * cells_per_degree),
iy = floor((lat + 90) * cells_per_degree), so cells from different regions line up.

"Active cell-days" = number of distinct (0.05 deg cell, day) pairs with at least one
detection. It is stored on the parent 0.1 deg cell so it stays additive over any area.
A cluster of VIIRS pixels inside one MODIS pixel counts once, which makes the metric
much less sensitive to pixel size than raw counts.
"""
from __future__ import annotations

import json
import shutil

import duckdb

from .config import Config

SERIES_CASE = (
    "CASE satellite WHEN 'Terra' THEN 'terra' WHEN 'Aqua' THEN 'aqua' WHEN 'SNPP' THEN 'viirs_snpp' "
    "WHEN 'NOAA20' THEN 'viirs_n20' WHEN 'NOAA21' THEN 'viirs_n21' END"
)


def _reset(path) -> str:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True)
    return path.as_posix()


def run(cfg: Config, only: list[str] | None = None) -> None:
    con = duckdb.connect()
    C, F = cfg.cell_per_deg, cfg.fine_per_deg
    use = "TRUE" if cfg.include_nonveg_types else "veg"
    done = []

    for rid in cfg.regions:
        if only and rid not in only:
            continue
        src_dir = cfg.processed / "hotspots" / f"region={rid}"
        if not src_dir.exists():
            print(f"[grid] {rid}: no hotspots Parquet - run ingest first, skipped")
            continue
        src = f"read_parquet('{src_dir.as_posix()}/*/*.parquet', hive_partitioning=true)"

        con.execute(
            f"""
            CREATE OR REPLACE TEMP TABLE h AS
            SELECT acq_date, satellite, frp, daynight,
                   (type IS NULL OR type = 0) AS veg,
                   CAST(floor((longitude + 180) * {C}) AS INTEGER) AS ix,
                   CAST(floor((latitude + 90) * {C}) AS INTEGER) AS iy,
                   CAST(floor((longitude + 180) * {F}) AS INTEGER) AS fx,
                   CAST(floor((latitude + 90) * {F}) AS INTEGER) AS fy
            FROM {src}
            """
        )

        out = _reset(cfg.processed / "daily_grid" / f"region={rid}")
        con.execute(
            f"""
            COPY (
                SELECT acq_date AS date, ix, iy, satellite,
                       CAST(count(*) FILTER (WHERE veg) AS INTEGER) AS n,
                       CAST(count(*) FILTER (WHERE NOT veg) AS INTEGER) AS n_nonveg,
                       CAST(count(*) FILTER (WHERE veg AND daynight = 'N') AS INTEGER) AS n_night,
                       sum(frp) FILTER (WHERE veg) AS frp_sum,
                       year(acq_date) AS year
                FROM h GROUP BY ALL ORDER BY date, iy, ix
            ) TO '{out}' (FORMAT PARQUET, PARTITION_BY (year), COMPRESSION ZSTD)
            """
        )

        out = _reset(cfg.processed / "monthly_cells" / f"region={rid}")
        con.execute(
            f"""
            COPY (
                WITH s AS (
                    SELECT {SERIES_CASE} AS series, * FROM h WHERE {use}
                    UNION ALL
                    SELECT 'modis' AS series, * FROM h WHERE {use} AND satellite IN ('Terra', 'Aqua')
                ),
                counts AS (
                    SELECT series, CAST(date_trunc('month', acq_date) AS DATE) AS month, ix, iy,
                           count(*) AS n, sum(frp) AS frp_sum
                    FROM s GROUP BY ALL
                ),
                active AS (
                    SELECT series, month, ix, iy, count(*) AS celldays FROM (
                        SELECT DISTINCT series, CAST(date_trunc('month', acq_date) AS DATE) AS month,
                               ix, iy, fx, fy, acq_date FROM s)
                    GROUP BY ALL
                )
                SELECT c.month, c.ix, c.iy, c.series, CAST(c.n AS INTEGER) AS n,
                       CAST(a.celldays AS INTEGER) AS celldays, c.frp_sum
                FROM counts c JOIN active a USING (series, month, ix, iy)
                ORDER BY month, series, iy, ix
            ) TO '{out}/data.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)
            """
        )
        con.execute(
            f"""
            CREATE OR REPLACE TEMP TABLE cov_{len(done)} AS
            SELECT '{rid}' AS region, {SERIES_CASE} AS series,
                   min(acq_date) AS first_date, max(acq_date) AS last_date, count(*) AS rows
            FROM h GROUP BY ALL
            """
        )
        done.append(rid)
        n_days = con.execute("SELECT count(DISTINCT acq_date) FROM h").fetchone()[0]
        print(f"[grid] {rid}: gridded {n_days:,} days with detections")

    if not done:
        return

    # Merge coverage with any regions processed in an earlier run.
    cov_path = cfg.processed / "coverage.parquet"
    union = " UNION ALL ".join(f"SELECT * FROM cov_{i}" for i in range(len(done)))
    if cov_path.exists():
        kept = ", ".join(f"'{r}'" for r in done)
        union += f" UNION ALL SELECT * FROM read_parquet('{cov_path.as_posix()}') WHERE region NOT IN ({kept})"
    con.execute(f"CREATE OR REPLACE TEMP TABLE cov AS {union}")
    con.execute(f"COPY (SELECT * FROM cov ORDER BY region, series) TO '{cov_path.as_posix()}' (FORMAT PARQUET)")

    meta = {
        "cell_per_deg": C,
        "fine_per_deg": F,
        "include_nonveg_types": cfg.include_nonveg_types,
    }
    (cfg.processed / "grid_meta.json").write_text(json.dumps(meta, indent=2), "utf-8")
