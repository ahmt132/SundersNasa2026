"""End-to-end tests on MOCK data (see tests/synthetic.py). No real FIRMS data is used here."""
from __future__ import annotations

import sys
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pipeline import grid, harmonize, ingest  # noqa: E402
from pipeline.config import load_config  # noqa: E402
from pipeline.transfer import fit_hierarchy, predict  # noqa: E402
from tests.synthetic import MOCK_REGIONS, reference_clean, write_mock_project  # noqa: E402


@pytest.fixture(scope="module")
def project(tmp_path_factory):
    root = tmp_path_factory.mktemp("mock_project")
    labelled = write_mock_project(root)
    cfg = load_config(root / "config" / "pipeline.toml")
    reports = ingest.run(cfg)
    grid.run(cfg)
    result = harmonize.run(cfg, figures=True)
    return {"cfg": cfg, "labelled": labelled, "ingest": reports, **result}


def _hotspots(cfg, region):
    path = (cfg.processed / "hotspots" / f"region={region}").as_posix()
    return duckdb.sql(f"SELECT * FROM read_parquet('{path}/*/*.parquet', hive_partitioning=true)").df()


def test_ingest_matches_independent_reference(project):
    cfg = project["cfg"]
    for rid, spec in MOCK_REGIONS.items():
        expected = reference_clean(project["labelled"][rid], spec["bbox"])
        got = _hotspots(cfg, rid)
        assert len(got) == len(expected)
        assert got.groupby("satellite").size().to_dict() == expected.groupby("sat").size().to_dict()
        modis = got[got["sensor"] == "MODIS"]
        assert pd.to_numeric(modis["confidence"]).min() >= 30
        assert set(got.loc[got["sensor"] == "VIIRS", "confidence"]) <= {"n", "h"}
        assert set(got["satellite"]) == {"Terra", "Aqua", "SNPP", "NOAA20"}
        # NRT rows survive only after the last standard-processing day of the same satellite
        sp_max = got[got["proc"] == "SP"].groupby("satellite")["acq_date"].max()
        nrt = got[got["proc"] == "NRT"]
        assert (nrt["acq_date"] > nrt["satellite"].map(sp_max)).all()
        assert project["ingest"][rid]["dropped_duplicates"] > 0
        assert project["ingest"][rid]["dropped_nrt_superseded_by_sp"] > 0


def test_grid_conserves_counts(project):
    cfg = project["cfg"]
    for rid in MOCK_REGIONS:
        hs = _hotspots(cfg, rid)
        daily = duckdb.sql(
            f"SELECT sum(n) AS n, sum(n_nonveg) AS nv FROM read_parquet("
            f"'{(cfg.processed / 'daily_grid' / f'region={rid}').as_posix()}/*/*.parquet')").df().iloc[0]
        veg = hs["type"].isna() | (hs["type"] == 0)
        assert daily["n"] == veg.sum() and daily["nv"] == (~veg).sum()
        cells = pd.read_parquet(cfg.processed / "monthly_cells" / f"region={rid}" / "data.parquet")
        tot = cells.groupby("series")["n"].sum()
        assert tot["modis"] == tot["terra"] + tot["aqua"] == veg[hs["sensor"] == "MODIS"].sum()
        assert (cells["celldays"] <= cells["n"]).all() and (cells["celldays"] >= 1).all()


def test_final_series_structure(project):
    s = project["series"]
    for rid in MOCK_REGIONS:
        r = s[s["region"] == rid].set_index("month")
        assert r.index.min() == pd.Timestamp("2000-11-01") and r.index.is_monotonic_increasing
        assert len(r) == len(pd.date_range("2000-11-01", "2020-03-01", freq="MS"))

        early = r[:"2002-07-01"]                       # Aqua absent or incomplete
        assert early["terra_only"].all() and (early["source"] == "terra").all()
        seen = early["count_terra"] > 0                # a month with no Terra detections stays 0
        assert (early.loc[seen, "h_count"] > early.loc[seen, "count_terra"]).all()
        assert (early.loc[~seen, "h_count"] == 0).all()
        assert early["count_aqua"][:"2002-06-01"].isna().all()

        modis_era = r["2002-08-01":"2012-01-01"]       # Jan 2012 stays MODIS: S-NPP month incomplete
        assert (modis_era["source"] == "modis").all()
        assert np.allclose(modis_era["h_count"], modis_era["count_modis"])
        assert np.allclose(modis_era["h_count_lo"], modis_era["h_count_hi"])

        assert (r["2012-02-01":"2020-01-01"]["source"] == "viirs_snpp").all()
        assert (r["2020-02-01":]["source"] == "viirs_n20").all()   # S-NPP ended: NOAA-20 takes over
        assert r["partial"].sum() == 1 and bool(r["partial"].iloc[-1])
        assert r["days_observed"].iloc[-1] == 15

        viirs = r[r["era"] == "viirs_transfer"]
        assert (viirs["h_count_lo"] <= viirs["h_count"]).all() and (viirs["h_count"] <= viirs["h_count_hi"]).all()
        assert viirs["h_celldays"].notna().all()


def test_validation_beats_raw_and_is_unbiased(project):
    sc = project["scores"]
    sc = sc[(sc["predictor"] == "viirs_snpp") & (sc["metric"] == "count") & (sc["region"] != "*")]
    for rid in MOCK_REGIONS:
        g = sc[sc["region"] == rid].set_index("method")
        best = g[g["selected"]].iloc[0]
        assert best["mae"] == g.drop(index="raw")["mae"].min()      # chosen by score, not by preference
        assert best["mae"] < 0.5 * g.loc["raw", "mae"]
        assert abs(best["rel_bias"]) < 0.10
        assert best["pearson_r"] > 0.9 and best["spearman_rho"] > 0.9
    assert (project["cfg"].reports / "validation_mock_a.png").exists()


def test_weights_and_cells_reproduce_the_series(project):
    cfg, s = project["cfg"], project["series"]
    for rid in MOCK_REGIONS:
        r = s[(s["region"] == rid) & (s["source"] != "modis")]
        w = pd.read_parquet(cfg.processed / "harmonized" / "tile_weights" / f"region={rid}" / "data.parquet")
        w = w[w["metric"] == "count"]
        assert np.allclose(w["raw"] * w["weight"], w["harmonized"])
        tot = w.groupby(["month", "predictor"])["harmonized"].sum()
        for row in r.itertuples():
            assert np.isclose(tot.get((row.month, row.source), 0.0), row.h_count)

        cdir = (cfg.processed / "harmonized" / "cells_monthly" / f"region={rid}").as_posix()
        cells = duckdb.sql(f"SELECT month, sum(h_count) AS h, sum(h_celldays) AS hc "
                           f"FROM read_parquet('{cdir}/*/*.parquet') GROUP BY 1").df()
        cells["month"] = pd.to_datetime(cells["month"])
        full = s[s["region"] == rid].merge(cells, on="month", how="left").fillna({"h": 0.0, "hc": 0.0})
        assert np.allclose(full["h"], full["h_count"]) and np.allclose(full["hc"], full["h_celldays"])


def test_band_covers_held_out_modis(project):
    cfg = project["cfg"]
    from pipeline.uncertainty import BandLookup

    bands = BandLookup(pd.read_parquet(cfg.processed / "harmonized" / "uncertainty.parquet"))
    rm = pd.read_parquet(cfg.reports / "loyo_region_monthly.parquet")
    rm = rm[(rm["predictor"] == "viirs_snpp") & (rm["metric"] == "count")]
    inside = []
    for rid in MOCK_REGIONS:
        method = project["meta"]["selection"]["viirs_snpp/count"]["method_by_region"][rid]
        g = rm[rm["region"] == rid]
        lo, hi = bands.band("viirs_snpp", "count", rid, g[f"pred_{method}"].to_numpy())
        inside.append((g["y"].to_numpy() >= lo) & (g["y"].to_numpy() <= hi))
    assert np.concatenate(inside).mean() > 0.75      # nominal 90 % band


@pytest.mark.parametrize("method", ["theilsen", "qmap", "ratio"])
def test_transfer_methods_recover_a_known_relation(method):
    rng = np.random.default_rng(0)
    x = rng.integers(1, 400, 600).astype(float)
    y = rng.poisson(0.25 * x).astype(float)            # MOCK relation: MODIS sees a quarter of VIIRS
    pairs = pd.DataFrame({"region": "r", "tx": 0, "ty": 0, "moy": rng.integers(1, 13, 600), "x": x, "y": y})
    model = fit_hierarchy(pairs, method, min_pairs=8, max_points=2000, seed=1)
    test = pd.DataFrame({"region": "r", "tx": 0, "ty": 0, "moy": 6, "x": [0.0, 40.0, 200.0]})
    pred, level = predict(model, test)
    assert pred[0] == 0.0 and (level >= 0).all()
    assert pred[1] == pytest.approx(10.0, rel=0.25) and pred[2] == pytest.approx(50.0, rel=0.25)


def test_static_export_matches_series(project, tmp_path):
    """The static website files must carry the same numbers as the pipeline output."""
    import json
    from pipeline import export_static

    cfg = project["cfg"]
    export_static.run(cfg, str(tmp_path / "data"))
    index = json.loads((tmp_path / "data" / "index.json").read_text("utf-8"))
    assert {r["id"] for r in index["regions"]} == set(MOCK_REGIONS)
    for r in index["regions"]:
        series = json.loads((tmp_path / "data" / "r" / r["id"] / "series.json").read_text("utf-8"))
        ref = project["series"][project["series"]["region"] == r["id"]]
        assert np.allclose(np.array(series["h_count"], float), ref["h_count"].to_numpy(), atol=1e-3)
        hot = sum(v["n"] for v in r["hot"].values())
        assert hot == len(_hotspots(cfg, r["id"]))
        # cells_h.bin: harmonized cells add up to the region series
        n = r["files"]["cells_h"]["n"]
        buf = (tmp_path / "data" / "r" / r["id"] / "cells_h.bin").read_bytes()
        off = 3 * (2 * n + (-2 * n) % 4)
        hc = np.frombuffer(buf, np.float32, n, off)
        assert np.isclose(hc.sum(), ref["h_count"].sum(), rtol=1e-4)


def test_ingest_global_reads_nested_zips_into_world_blocks(tmp_path):
    """MOCK data: a Drive-style zip holding FIRMS request zips is unpacked (Landsat skipped),
    cleaned and written per 30-degree world block."""
    import io
    import re
    import zipfile

    from pipeline import ingest_global

    root = tmp_path / "proj"
    root.mkdir()
    write_mock_project(root)
    toml = root / "config" / "pipeline.toml"
    # worldwide set-up: drop the named [regions.*] tables (each runs until the next table header)
    keep, skipping = [], False
    for line in toml.read_text().splitlines():
        if re.match(r"^\[[^\]]+\]\s*$", line):
            skipping = line.startswith("[regions.")
        if not skipping:
            keep.append(line)
    text = "\n".join(keep) + "\n"
    text = text.replace('reports = "reports"', 'reports = "reports"\nzips = ["drive"]') + "\n[world]\nblock_deg = 30\n"
    toml.write_text(text)
    cfg = load_config(toml)
    header = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight,type\n"
    rows = ["1.5,11.5,330,0.4,0.4,2024-07-01,0130,N20,VIIRS,n,2,290,3.1,N,0",
            "1.5,21.5,330,0.4,0.4,2024-07-01,0130,N20,VIIRS,h,2,290,3.1,N,0",
            "45.0,90.0,330,0.4,0.4,2024-07-01,0130,N20,VIIRS,n,2,290,3.1,N,0",
            "45.0,90.5,330,0.4,0.4,2024-07-01,0130,N20,VIIRS,l,2,290,3.1,N,0"]  # low confidence: dropped
    inner = io.BytesIO()
    with zipfile.ZipFile(inner, "w") as z:
        z.writestr("fire_archive_J1V-C2_1.csv", header + "\n".join(rows) + "\n")
    landsat = io.BytesIO()
    with zipfile.ZipFile(landsat, "w") as z:
        z.writestr("fire_archive_LS_1.csv", "latitude,longitude\n1.5,11.5\n")
    drive = root / "drive"
    drive.mkdir()
    with zipfile.ZipFile(drive / "Nasa SpaceApps 2026.zip", "w") as z:
        z.writestr("DL_FIRE_J1V-C2_1.zip", inner.getvalue())
        z.writestr("DL_FIRE_LS_1.zip", landsat.getvalue())
    report = ingest_global.run(cfg)
    assert report["rows_read"] == 4 and report["dropped_low_confidence"] == 1 and report["rows_kept"] == 3
    assert report["blocks"] == {"w000e_00n": 2, "w090e_30n": 1}
    assert not any("LS" in f for f in report["files"])


def test_missing_year_is_not_read_as_zero_fires():
    """MOCK data: a satellite with a missing year file inside its span must be 'none', not 0."""
    from pipeline.harmonize import mark_gaps, month_state

    cov = pd.DataFrame({
        "region": ["r"] * 2, "series": ["terra", "aqua"],
        "first_date": pd.to_datetime(["2003-01-01"] * 2), "last_date": pd.to_datetime(["2005-12-31"] * 2),
    })
    months = pd.date_range("2003-01-01", "2005-12-01", freq="MS")
    tiles = pd.concat([
        pd.DataFrame({"region": "r", "month": months, "series": "aqua", "count": 100.0}),
        pd.DataFrame({"region": "r", "month": months[months.year != 2004], "series": "terra", "count": 40.0}),
    ])
    st = mark_gaps(month_state(cov), tiles).set_index("month")
    assert (st.loc["2004", "s_terra"] == "none").all()
    assert (st.loc["2004", "s_modis"] == "partial").all()
    assert (st.loc["2003", "s_terra"] == "full").all() and (st.loc["2005", "s_modis"] == "full").all()
