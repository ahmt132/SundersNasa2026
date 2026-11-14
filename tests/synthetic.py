"""MOCK DATA - FOR TESTS ONLY. Nothing in this file is real fire data.

Generates FIRMS-shaped CSV files for two imaginary regions so the pipeline can be
exercised end to end without a FIRMS download. The numbers have no physical meaning;
they only reproduce the structure the pipeline must cope with:
  - Terra from 2000-11-01, Aqua from 2002-07-04, S-NPP 2012-01-20 .. 2020-01-31,
    NOAA-20 from 2018-04-01, everything ending mid-month on 2020-03-15
  - VIIRS reports several pixels per fire, MODIS at most a couple
  - low-confidence rows, non-vegetation types, rows outside the bbox,
    exact duplicates, and NRT files that overlap the standard-processing files
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

MOCK_REGIONS = {
    "mock_a": {"name": "MOCK region A (synthetic)", "bbox": [10.0, 0.0, 13.0, 3.0], "peak": 8},
    "mock_b": {"name": "MOCK region B (synthetic)", "bbox": [20.0, 0.0, 22.0, 2.0], "peak": 2},
}
END = pd.Timestamp("2020-03-15")
SP_END = pd.Timestamp("2019-12-31")       # standard processing stops here
NRT_START = pd.Timestamp("2019-12-01")    # NRT files overlap SP for one month on purpose
STARTS = {
    "Terra": pd.Timestamp("2000-11-01"),
    "Aqua": pd.Timestamp("2002-07-04"),
    "SNPP": pd.Timestamp("2012-01-20"),
    "NOAA20": pd.Timestamp("2018-04-01"),
}
SNPP_END = pd.Timestamp("2020-01-31")
#           detection rate, mean extra pixels, position jitter (deg)
DETECT = {"Terra": (0.30, 0.0, 0.005), "Aqua": (0.60, 0.4, 0.005),
          "SNPP": (2.50, 2.5, 0.004), "NOAA20": (2.50, 2.5, 0.004)}


def _events(rng: np.random.Generator, bbox, peak_month: int) -> pd.DataFrame:
    days = pd.date_range("2000-11-01", END, freq="D")
    w, s, e, n = (int(v) for v in bbox)
    frames = []
    for tx in range(w, e):
        for ty in range(s, n):
            season = np.exp(2.2 * (np.cos(2 * np.pi * (days.month - peak_month) / 12) - 1))
            year_factor = {y: rng.lognormal(0, 0.35) for y in range(2000, 2021)}
            lam = rng.uniform(0.6, 3.0) * season * np.array([year_factor[y] for y in days.year])
            idx = np.repeat(np.arange(len(days)), rng.poisson(lam))
            frames.append(pd.DataFrame({
                "date": days[idx],
                "lat": ty + rng.uniform(0.02, 0.98, idx.size),
                "lon": tx + rng.uniform(0.02, 0.98, idx.size),
                "intensity": rng.lognormal(0, 0.5, idx.size),
            }))
    return pd.concat(frames, ignore_index=True)


def _detections(rng: np.random.Generator, events: pd.DataFrame, sat: str) -> pd.DataFrame:
    rate, extra, jitter = DETECT[sat]
    ev = events[events["date"] >= STARTS[sat]]
    if sat == "SNPP":
        ev = ev[ev["date"] <= SNPP_END]
    seen = ev[rng.random(len(ev)) < 1 - np.exp(-rate * ev["intensity"].to_numpy())]
    pixels = 1 + rng.poisson(extra * seen["intensity"].to_numpy())
    idx = np.repeat(np.arange(len(seen)), pixels)
    modis = sat in ("Terra", "Aqua")
    out = pd.DataFrame({
        "latitude": np.round(seen["lat"].to_numpy()[idx] + rng.normal(0, jitter, idx.size), 5),
        "longitude": np.round(seen["lon"].to_numpy()[idx] + rng.normal(0, jitter, idx.size), 5),
        "acq_date": seen["date"].to_numpy()[idx],
        "acq_time": rng.integers(0, 24, idx.size) * 100 + rng.integers(0, 60, idx.size),
        "sat": sat,
        "frp": np.round(rng.lognormal(2.0, 0.8, idx.size), 1),
        "daynight": rng.choice(["D", "N"], idx.size, p=[0.8, 0.2]),
        "type": rng.choice([0, 2], idx.size, p=[0.98, 0.02]),
    })
    if modis:
        out["confidence"] = np.where(rng.random(idx.size) < 0.12, rng.integers(0, 30, idx.size),
                                     rng.integers(30, 101, idx.size)).astype(str)
    else:
        out["confidence"] = rng.choice(["l", "n", "h"], idx.size, p=[0.1, 0.8, 0.1])
    return out


def _firms_frame(det: pd.DataFrame, proc: str, sensor: str) -> pd.DataFrame:
    """Shape detections like a FIRMS CSV (archive and NRT flavours differ on purpose)."""
    df = pd.DataFrame({"latitude": det["latitude"], "longitude": det["longitude"]})
    bright = "brightness" if sensor == "MODIS" else "bright_ti4"
    df[bright] = 330.0
    df["scan"], df["track"] = 1.0, 1.0
    df["acq_date"] = pd.to_datetime(det["acq_date"]).dt.strftime("%Y-%m-%d")
    if proc == "SP":
        df["acq_time"] = det["acq_time"].to_numpy()                        # plain integer, e.g. 34
    else:
        df["acq_time"] = det["acq_time"].map(lambda v: f"{v:04d}")         # zero padded, e.g. 0034
    if sensor == "MODIS":
        df["satellite"] = det["sat"] if proc == "SP" else det["sat"].str[0]  # Terra/Aqua vs T/A
        df["instrument"] = "MODIS"
        df["version"] = "6.1" if proc == "SP" else "6.1NRT"
    else:
        df["satellite"] = det["sat"].map({"SNPP": "N", "NOAA20": "N20"})
        df["instrument"] = "VIIRS"
        df["version"] = "2" if proc == "SP" else "2.0NRT"
    df["confidence"] = det["confidence"].to_numpy()
    df["frp"] = det["frp"].to_numpy()
    df["daynight"] = det["daynight"].to_numpy()
    if proc == "SP":
        df["type"] = det["type"].to_numpy()
    return df


def reference_clean(labelled: pd.DataFrame, bbox, modis_min_conf: int = 30) -> pd.DataFrame:
    """Independent pandas implementation of the cleaning rules, to check the DuckDB ingest against."""
    w, s, e, n = bbox
    df = labelled[(labelled["longitude"] >= w) & (labelled["longitude"] < e)
                  & (labelled["latitude"] >= s) & (labelled["latitude"] < n)]
    modis = df["sat"].isin(["Terra", "Aqua"])
    conf_num = pd.to_numeric(df["confidence"], errors="coerce")
    df = df[(modis & (conf_num >= modis_min_conf)) | (~modis & df["confidence"].isin(["n", "h"]))]
    sp_max = df[df["proc"] == "SP"].groupby("sat")["acq_date"].max()
    cutoff = df["sat"].map(sp_max)
    df = df[~((df["proc"] == "NRT") & (df["acq_date"] <= cutoff))]
    df = df.assign(rlat=df["latitude"].round(4), rlon=df["longitude"].round(4))
    return df.drop_duplicates(["sat", "acq_date", "acq_time", "rlat", "rlon"])


def write_mock_project(root: Path, seed: int = 7) -> dict:
    """Write config + raw CSVs under `root`. Returns the labelled detections per region."""
    rng = np.random.default_rng(seed)
    labelled = {}
    for rid, spec in MOCK_REGIONS.items():
        raw_dir = root / "data" / "raw" / rid
        raw_dir.mkdir(parents=True)
        events = _events(rng, spec["bbox"], spec["peak"])
        parts = []
        for sensor, sats, code in (("MODIS", ("Terra", "Aqua"), "M-C61"),
                                   ("VIIRS", ("SNPP",), "SV-C2"), ("VIIRS", ("NOAA20",), "J1V-C2")):
            det = pd.concat([_detections(rng, events, s) for s in sats], ignore_index=True)
            sp = det[det["acq_date"] <= SP_END]
            nrt = det[det["acq_date"] >= NRT_START]
            sp = pd.concat([sp, sp.sample(min(300, len(sp)), random_state=seed)], ignore_index=True)  # exact duplicates
            _firms_frame(sp, "SP", sensor).to_csv(raw_dir / f"fire_archive_{code}_mock.csv", index=False)
            _firms_frame(nrt, "NRT", sensor).to_csv(raw_dir / f"fire_nrt_{code}_mock.csv", index=False)
            parts += [sp.assign(proc="SP"), nrt.assign(proc="NRT")]
        labelled[rid] = pd.concat(parts, ignore_index=True)

    regions = "\n".join(
        f'[regions.{rid}]\nname = "{spec["name"]}"\nbbox = {spec["bbox"]}\n' for rid, spec in MOCK_REGIONS.items()
    )
    (root / "config").mkdir()
    (root / "config" / "pipeline.toml").write_text(
        f"""# MOCK configuration generated by tests/synthetic.py
[paths]
raw = "data/raw"
processed = "data/processed"
reports = "reports"
[grid]
cell_deg = 0.1
fine_deg = 0.05
tile_deg = 1.0
[cleaning]
modis_min_confidence = 30
viirs_keep_confidence = ["n", "h"]
include_nonveg_types = false
[calibration]
viirs_era_start = "2012-01"
overlap_start = "2012-01"
overlap_end = ""
terra_fit_start = "2003-01"
terra_fit_end = "2011-12"
min_pairs = 8
max_fit_points = 2000
methods = ["theilsen", "qmap", "ratio"]
viirs_priority = ["viirs_snpp", "viirs_n20", "viirs_n21"]
seed = 1
[coverage]
snap_days = 60
[coverage.nominal_start]
terra = "2000-11-01"
aqua = "2002-07-04"
viirs_snpp = "2012-01-20"
viirs_n20 = "2018-04-01"
{regions}""",
        "utf-8",
    )
    return labelled
