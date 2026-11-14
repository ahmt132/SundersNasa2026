"""API tests on MOCK data (see tests/synthetic.py). No real FIRMS data is used here."""
from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
import pytest
import shapely
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from api.main import create_app  # noqa: E402
from pipeline import grid, harmonize, ingest  # noqa: E402
from pipeline.config import load_config  # noqa: E402
from tests.synthetic import write_mock_project  # noqa: E402

POLY = shapely.Polygon([(10.33, 0.41), (12.27, 0.77), (11.61, 2.63), (10.52, 1.94)])   # cuts through cells
GEOJSON = json.dumps(shapely.geometry.mapping(POLY))


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    root = tmp_path_factory.mktemp("mock_api")
    write_mock_project(root)
    cfg = load_config(root / "config" / "pipeline.toml")
    ingest.run(cfg)
    grid.run(cfg)
    result = harmonize.run(cfg, figures=False)
    return {"cfg": cfg, "series": result["series"], "client": TestClient(create_app(str(root / "config" / "pipeline.toml")))}


def _csv(text: str) -> pd.DataFrame:
    return pd.read_csv(io.StringIO(text), comment="#")


def test_region_calendar_equals_pipeline_series(env):
    r = env["client"].get("/calendar", params={"region": "mock_a"})
    assert r.status_code == 200
    months = pd.DataFrame(r.json()["months"])
    ref = env["series"][env["series"]["region"] == "mock_a"].reset_index(drop=True)
    assert len(months) == len(ref)
    assert np.allclose(months["harmonized"], ref["h_count"])
    assert np.allclose(months["modis_raw"], ref["count_modis"])
    assert np.allclose(months["viirs_snpp_raw"].astype(float), ref["count_viirs_snpp"], equal_nan=True)
    assert months.loc[0, "terra_only"] and months.iloc[-1]["partial"]
    assert r.json()["meta"]["unit"].startswith("MODIS-equivalent")

    cd = pd.DataFrame(env["client"].get("/calendar", params={"region": "mock_a", "metric": "celldays"}).json()["months"])
    assert np.allclose(cd["harmonized"], ref["h_celldays"])


def test_polygon_is_exact_point_in_polygon(env):
    """Raw counts for an irregular polygon must equal a brute-force test of every hotspot."""
    cfg = env["cfg"]
    months = pd.DataFrame(env["client"].get("/calendar", params={"geom": GEOJSON}).json()["months"])
    hs = duckdb.sql(f"SELECT * FROM read_parquet('{(cfg.processed / 'hotspots' / 'region=mock_a').as_posix()}/*/*.parquet',"
                    " hive_partitioning=true) WHERE type IS NULL OR type = 0").df()
    hs = hs[shapely.intersects_xy(POLY, hs["longitude"].to_numpy(), hs["latitude"].to_numpy())]
    assert months["modis_raw"].sum() == hs["satellite"].isin(["Terra", "Aqua"]).sum()
    assert months["viirs_snpp_raw"].sum() == (hs["satellite"] == "SNPP").sum()
    by_month = hs[hs["satellite"] == "SNPP"].groupby(pd.to_datetime(hs["acq_date"]).dt.strftime("%Y-%m")).size()
    got = months.set_index("month")["viirs_snpp_raw"]
    assert (got.reindex(by_month.index) == by_month).all()

    # the hotspot export carries weights that add up to the harmonized series
    exp = _csv(env["client"].get("/hotspots.csv", params={"geom": GEOJSON, "start": "2015-01", "end": "2016-12"}).text)
    sub = months[(months["month"] >= "2015-01") & (months["month"] <= "2016-12")]
    assert np.isclose(exp["harmonization_weight"].sum(), sub["harmonized"].sum())
    assert set(exp["sensor"]) == {"MODIS", "VIIRS"}
    assert (exp.loc[exp["sensor"] == "MODIS", "harmonization_weight"] == 0).all()      # VIIRS era
    assert (exp.loc[exp["type"] == 2, "harmonization_weight"] == 0).all()             # non-vegetation
    early = _csv(env["client"].get("/hotspots.csv", params={"geom": GEOJSON, "start": "2005-01", "end": "2005-12"}).text)
    assert (early.loc[early["type"] == 0, "harmonization_weight"] == 1).all()          # observed MODIS era


def test_bbox_circle_and_dates(env):
    c = env["client"]
    a = c.get("/calendar", params={"bbox": "10,0,13,3", "start": "2014-03", "end": "2014-08"}).json()["months"]
    assert [m["month"] for m in a] == ["2014-03", "2014-04", "2014-05", "2014-06", "2014-07", "2014-08"]
    b = c.get("/calendar", params={"region": "mock_a", "start": "2014-03", "end": "2014-08"}).json()["months"]
    assert np.allclose([m["harmonized"] for m in a], [m["harmonized"] for m in b])
    circ = c.get("/calendar", params={"lat": 1.5, "lon": 11.5, "radius_km": 60})
    assert circ.status_code == 200
    assert 0 < sum(m["harmonized"] for m in circ.json()["months"]) < sum(
        m["harmonized"] for m in c.get("/calendar", params={"region": "mock_a"}).json()["months"])


def test_summary_kpis(env):
    r = env["client"].get("/summary", params={"region": "mock_a"}).json()["kpis"]
    ref = env["series"][env["series"]["region"] == "mock_a"]
    done = ref[~ref["partial"]]
    assert r["latest_month"]["month"] == "2020-02"                       # 2020-03 is partial
    assert r["peak_month"]["moy"] == int(done.groupby("moy")["h_count"].median().idxmax()) == 8
    full = done.groupby("year")["h_count"].agg(["sum", "size"]).query("size == 12")
    assert r["record_year"]["year"] == int(full["sum"].idxmax())
    assert np.isclose(r["totals"]["harmonized"], ref["h_count"].sum())
    assert 0 <= r["latest_month"]["percentile_rank"] <= 100


def test_calendar_csv_has_notes_and_table(env):
    r = env["client"].get("/calendar.csv", params={"region": "mock_b"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    assert "attachment" in r.headers["content-disposition"]
    assert r.text.startswith("# Burning calendar") and "NASA FIRMS" in r.text
    df = _csv(r.text)
    assert {"month", "harmonized", "lo", "hi", "modis_raw", "viirs_snpp_raw", "source", "partial"} <= set(df.columns)
    assert not env["client"].get("/calendar.csv", params={"region": "mock_b", "notes": "false"}).text.startswith("#")


@pytest.mark.parametrize("params, status, code", [
    ({}, 422, "invalid_selection"),
    ({"region": "mock_a", "bbox": "10,0,13,3"}, 422, "invalid_selection"),
    ({"region": "nowhere"}, 404, "unknown_region"),
    ({"bbox": "100,40,101,41"}, 404, "outside_coverage"),
    ({"bbox": "13,0,10,3"}, 422, "invalid_selection"),
    ({"geom": "{not json"}, 422, "invalid_geometry"),
    ({"geom": '{"type":"Point","coordinates":[11,1]}'}, 422, "invalid_geometry"),
    ({"region": "mock_a", "start": "2015-13"}, 422, "invalid_date"),
    ({"region": "mock_a", "start": "2016-01", "end": "2015-01"}, 422, "invalid_date"),
    ({"region": "mock_a", "start": "1990-01", "end": "1995-12"}, 404, "no_data_in_range"),
    ({"region": "mock_a", "metric": "area"}, 422, "invalid_metric"),
    ({"lat": 1.5, "lon": 11.5}, 422, "invalid_selection"),
    ({"lat": 1.5, "lon": 11.5, "radius_km": 9000}, 422, "invalid_selection"),
    ({"bbox": "10.001,0.001,10.002,0.002", "start": "2001-01", "end": "2001-01"}, 404, "empty_selection"),
])
def test_errors(env, params, status, code):
    r = env["client"].get("/calendar", params=params)
    assert r.status_code == status, r.text
    assert r.json()["error"]["code"] == code


def test_oversized_export_is_refused(env, monkeypatch):
    import api.store

    monkeypatch.setattr(api.store, "MAX_EXPORT_ROWS", 1000)
    r = env["client"].get("/hotspots.csv", params={"region": "mock_a"})
    assert r.status_code == 413 and r.json()["error"]["code"] == "export_too_large"
    monkeypatch.setattr(api.store, "MAX_EDGE_POINTS", 10)
    r = env["client"].get("/calendar", params={"geom": json.dumps(shapely.geometry.mapping(POLY.buffer(0.013)))})
    assert r.status_code == 413 and r.json()["error"]["code"] == "selection_too_large"


def test_regions_and_health(env):
    assert env["client"].get("/health").json() == {"status": "ok"}
    r = env["client"].get("/regions").json()
    assert {x["id"] for x in r["regions"]} == {"mock_a", "mock_b"}
    assert r["data_range"] == {"start": "2000-11", "end": "2020-03"}


def test_cells_layer_adds_up(env):
    r = env["client"].get("/cells", params={"region": "mock_a", "start": "2015-01", "end": "2015-12"}).json()
    ref = env["series"][(env["series"]["region"] == "mock_a") & (env["series"]["year"] == 2015)]
    assert len(r["west"]) == len(r["south"]) == len(r["value"]) > 0
    assert np.isclose(sum(r["value"]), ref["h_count"].sum(), rtol=1e-3)
    assert min(r["west"]) >= 10 and max(r["west"]) < 13
