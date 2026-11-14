"""Fetch recent hotspots from the FIRMS area API into data/raw/<region>/.

Use this only for the most recent period; history comes from FIRMS archive downloads.

API facts checked on 2026-11-12 at https://firms.modaps.eosdis.nasa.gov/api/area/ :
  /api/area/csv/[MAP_KEY]/[SOURCE]/[west,south,east,north]/[DAY_RANGE]/[DATE]
  returns [DATE] .. [DATE + DAY_RANGE - 1];  DAY_RANGE is 1..5;
  limit 5000 transactions per 10 minutes.
The key is read from the FIRMS_MAP_KEY environment variable and is never printed.
"""
from __future__ import annotations

import csv
import io
import os
import time
import urllib.error
import urllib.request
from datetime import date, timedelta

from .config import Config

BASE = "https://firms.modaps.eosdis.nasa.gov/api"
MAX_DAY_RANGE = 5
NRT_SOURCES = ("MODIS_NRT", "VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT")
ALL_SOURCES = NRT_SOURCES + ("MODIS_SP", "VIIRS_SNPP_SP", "VIIRS_NOAA20_SP", "VIIRS_NOAA21_SP")


def _key() -> str:
    key = os.environ.get("FIRMS_MAP_KEY", "").strip()
    if not key:
        raise SystemExit("FIRMS_MAP_KEY is not set. Get a free key at https://firms.modaps.eosdis.nasa.gov/api/map_key/")
    return key


def _get(path: str, key: str) -> str:
    """GET an API path; `path` must contain the literal {key} placeholder."""
    try:
        with urllib.request.urlopen(f"{BASE}/{path.format(key=key)}", timeout=120) as resp:
            return resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"FIRMS API returned HTTP {exc.code} for {path.format(key='<MAP_KEY>')}") from None
    except urllib.error.URLError as exc:
        raise RuntimeError(f"FIRMS API unreachable for {path.format(key='<MAP_KEY>')}: {exc.reason}") from None


def availability(key: str) -> dict[str, tuple[date, date]]:
    """Date range the API currently serves per source. Returns {} if the response cannot be parsed.

    VERIFY: the column names (data_id, min_date, max_date) are from memory of the API output;
    the documentation page did not show a sample. Parsing is defensive for that reason.
    """
    text = _get("data_availability/csv/{key}/ALL", key)
    out = {}
    try:
        for row in csv.DictReader(io.StringIO(text)):
            out[row["data_id"].strip()] = (date.fromisoformat(row["min_date"]), date.fromisoformat(row["max_date"]))
    except (KeyError, ValueError, AttributeError):
        return {}
    return out


def fetch(cfg: Config, regions: list[str] | None, start: date, end: date,
          sources: tuple[str, ...] = NRT_SOURCES) -> list[str]:
    key = _key()
    avail = availability(key)
    written = []
    for rid, region in cfg.regions.items():
        if regions and rid not in regions:
            continue
        area = ",".join(f"{v:g}" for v in region.bbox)
        out_dir = cfg.raw / rid
        out_dir.mkdir(parents=True, exist_ok=True)
        for source in sources:
            if source not in ALL_SOURCES:
                raise SystemExit(f"unknown FIRMS source '{source}'. Valid: {', '.join(ALL_SOURCES)}")
            lo, hi = start, end
            if source in avail:
                lo, hi = max(lo, avail[source][0]), min(hi, avail[source][1])
            if lo > hi:
                print(f"[nrt] {rid} {source}: nothing available between {start} and {end}")
                continue
            header, rows, day = None, [], lo
            while day <= hi:
                span = min(MAX_DAY_RANGE, (hi - day).days + 1)
                text = _get(f"area/csv/{{key}}/{source}/{area}/{span}/{day.isoformat()}", key)
                lines = [ln for ln in text.splitlines() if ln.strip()]
                if lines:
                    if "latitude" not in lines[0].lower():
                        raise RuntimeError(f"FIRMS API error for {rid} {source} {day}: {lines[0][:200]}")
                    header = header or lines[0]
                    rows.extend(lines[1:])
                day += timedelta(days=span)
                time.sleep(0.25)
            if header is None:
                print(f"[nrt] {rid} {source}: API returned no data")
                continue
            path = out_dir / f"api_{source}_{lo.isoformat()}_{hi.isoformat()}.csv"
            path.write_text("\n".join([header, *rows]) + "\n", "utf-8")
            written.append(str(path))
            print(f"[nrt] {rid} {source}: {len(rows):,} rows {lo} .. {hi} -> {path.name}")
    return written
