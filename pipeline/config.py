"""Configuration loading. Everything tunable lives in config/pipeline.toml."""
from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from pathlib import Path

import os

import duckdb

# DuckDB's default is 80 % of RAM. On a 16 GB laptop that pushes Windows into paging (the pagefile
# grew to 26 GB and the run slowed to hours), so the pipeline caps it; larger sorts spill to temp
# files instead. Override with BURNCAL_DUCKDB_MEMORY, e.g. "10GB".
DUCKDB_MEMORY = os.environ.get("BURNCAL_DUCKDB_MEMORY", "6GB")


def duck_connect(database: str = ":memory:") -> duckdb.DuckDBPyConnection:
    """DuckDB connection with the pipeline's memory cap applied."""
    con = duckdb.connect(database)
    con.execute(f"SET memory_limit = '{DUCKDB_MEMORY}'")
    return con

# Internal series names. "modis" always means Terra + Aqua combined.
MODIS_SATS = ("Terra", "Aqua")
SAT_TO_SERIES = {
    "Terra": "terra",
    "Aqua": "aqua",
    "SNPP": "viirs_snpp",
    "NOAA20": "viirs_n20",
    "NOAA21": "viirs_n21",
}
SERIES = ("modis", "terra", "aqua", "viirs_snpp", "viirs_n20", "viirs_n21")
METRICS = ("count", "celldays")


@dataclass(frozen=True)
class Region:
    id: str
    name: str
    bbox: tuple[float, float, float, float]  # west, south, east, north
    firms_countries: tuple[str, ...] = ()  # names used by FIRMS country-year files


@dataclass(frozen=True)
class Config:
    root: Path
    raw: Path
    processed: Path
    reports: Path
    zips: tuple[Path, ...]
    presets: dict
    cell_per_deg: int
    fine_per_deg: int
    tile_per_deg: int
    modis_min_confidence: int
    viirs_keep_confidence: tuple[str, ...]
    include_nonveg_types: bool
    viirs_era_start: str
    overlap_start: str
    overlap_end: str
    terra_fit_start: str
    terra_fit_end: str
    min_pairs: int
    max_fit_points: int
    methods: tuple[str, ...]
    viirs_priority: tuple[str, ...]
    seed: int
    snap_days: int = 60
    nominal_start: dict[str, str] = field(default_factory=dict)
    regions: dict[str, Region] = field(default_factory=dict)

    @property
    def cells_per_tile(self) -> int:
        return self.cell_per_deg // self.tile_per_deg


def _deg_label(v: float, pos: str, neg: str) -> str:
    return f"{abs(v):g}°{pos if v > 0 else neg if v < 0 else ''}"


def world_blocks(deg: float) -> dict[str, Region]:
    """Regular lon/lat blocks covering the globe. Id like 'w030e_30n' = west edge 30E, south edge 30N."""
    out = {}
    lat = -90.0
    while lat < 90:
        lon = -180.0
        while lon < 180:
            w, s = lon, lat
            rid = f"w{abs(int(w)):03d}{'e' if w >= 0 else 'w'}_{abs(int(s)):02d}{'n' if s >= 0 else 's'}"
            name = (f"Block {_deg_label(s, 'N', 'S')}–{_deg_label(s + deg, 'N', 'S')}, "
                    f"{_deg_label(w, 'E', 'W')}–{_deg_label(w + deg, 'E', 'W')}")
            out[rid] = Region(rid, name, (w, s, w + deg, s + deg))
            lon += deg
        lat += deg
    return out


def _per_degree(deg: float, label: str) -> int:
    n = round(1.0 / deg)
    if n < 1 or abs(n * deg - 1.0) > 1e-9:
        raise ValueError(f"{label}={deg} must divide one degree exactly (e.g. 1.0, 0.5, 0.1, 0.05)")
    return n


def load_config(path: str | Path = "config/pipeline.toml") -> Config:
    path = Path(path).resolve()
    with open(path, "rb") as fh:
        raw = tomllib.load(fh)
    root = path.parent.parent

    g, c, k = raw["grid"], raw["cleaning"], raw["calibration"]
    cell = _per_degree(g["cell_deg"], "cell_deg")
    fine = _per_degree(g["fine_deg"], "fine_deg")
    tile = _per_degree(g["tile_deg"], "tile_deg")
    if fine % cell or cell % tile:
        raise ValueError("grids must nest: fine_deg divides cell_deg, cell_deg divides tile_deg")

    regions = {}
    world = raw.get("world", {})
    if world.get("block_deg"):
        deg = float(world["block_deg"])
        if 180 % deg or 360 % deg:
            raise ValueError("world.block_deg must divide 180")
        regions.update(world_blocks(deg))
    for rid, r in raw.get("regions", {}).items():
        w, s, e, n = (float(v) for v in r["bbox"])
        if not (-180 <= w < e <= 180 and -90 <= s < n <= 90):
            raise ValueError(f"region {rid}: bbox must be west,south,east,north with west<east, south<north")
        regions[rid] = Region(rid, r.get("name", rid), (w, s, e, n), tuple(r.get("firms_countries", ())))

    presets = {pid: Region(pid, v.get("name", pid), tuple(float(x) for x in v["bbox"]))
               for pid, v in raw.get("presets", {}).items()}
    p = raw.get("paths", {})
    return Config(
        root=root,
        raw=root / p.get("raw", "data/raw"),
        processed=root / p.get("processed", "data/processed"),
        zips=tuple(root / z for z in p.get("zips", [])),
        presets=presets,
        reports=root / p.get("reports", "reports"),
        cell_per_deg=cell,
        fine_per_deg=fine,
        tile_per_deg=tile,
        modis_min_confidence=int(c["modis_min_confidence"]),
        viirs_keep_confidence=tuple(v.lower()[0] for v in c["viirs_keep_confidence"]),
        include_nonveg_types=bool(c["include_nonveg_types"]),
        viirs_era_start=k["viirs_era_start"],
        overlap_start=k["overlap_start"],
        overlap_end=k.get("overlap_end", ""),
        terra_fit_start=k["terra_fit_start"],
        terra_fit_end=k["terra_fit_end"],
        min_pairs=int(k["min_pairs"]),
        max_fit_points=int(k["max_fit_points"]),
        methods=tuple(k["methods"]),
        viirs_priority=tuple(k["viirs_priority"]),
        seed=int(k["seed"]),
        snap_days=int(raw.get("coverage", {}).get("snap_days", 60)),
        nominal_start=dict(raw.get("coverage", {}).get("nominal_start", {})),
        regions=regions,
    )
