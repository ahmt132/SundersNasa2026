"""Download FIRMS "yearly summary by country" CSV files - no login needed.

Source (linked from the FIRMS archive download page as "Download yearly summary by country"):
  https://firms.modaps.eosdis.nasa.gov/data/country/<sensor>/<year>/<sensor>_<year>_<Country>.csv
URL pattern and availability were probed on 2026-11-12: modis 2000-2025, viirs-snpp
2012-2025, viirs-jpss1 (NOAA-20) 2018-2025; nothing for 2026 or for NOAA-21 yet.
Years that do not exist return HTTP 404 and are skipped.

Each file is streamed and only rows inside the region's bbox are written, so a
100 MB country file becomes a few MB on disk. Rows from neighbouring countries that fall
inside the bbox are NOT included (the files are per country) - list every country the
bbox touches in `firms_countries` if that matters.
"""
from __future__ import annotations

import http.client
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from .config import Config

BASE = "https://firms.modaps.eosdis.nasa.gov/data/country"
MAX_RESUMES = 40
FIRST_YEAR = {"modis": 2000, "viirs-snpp": 2012, "viirs-jpss1": 2018, "viirs-jpss2": 2023}


def _fetch_one(url: str, dest, bbox) -> tuple[str, int, int]:
    """Stream one country-year file, keeping only rows inside bbox.

    Returns (status, rows kept, bytes transferred). The FIRMS server drops long transfers
    often, and a dropped stream just ends early without an error. So the byte offset of
    the last complete line is tracked and, after a drop, the request is resumed from there
    with an HTTP Range header. The file is accepted only when the offset reaches the size
    the server reported.
    """
    if dest.exists():
        return "cached", -1, 0
    w, s, e, n = bbox
    tmp = dest.with_suffix(".part")
    offset = kept = 0
    total: int | None = None
    last_error = "stream ended early"
    try:
        with open(tmp, "wb") as out:
            for attempt in range(MAX_RESUMES):
                pending = b""
                request = urllib.request.Request(url, headers={"Range": f"bytes={offset}-"} if offset else {})
                try:
                    with urllib.request.urlopen(request, timeout=120) as resp:
                        if offset and resp.status != 206:
                            raise RuntimeError(f"server ignored the Range header (status {resp.status})")
                        if total is None:
                            length = resp.headers.get("Content-Length")
                            if length is None:
                                raise RuntimeError("server sent no Content-Length; cannot verify completeness")
                            total = int(length)
                        for line in resp:
                            if not line.endswith(b"\n"):
                                pending = line  # cut mid-line, or a final line without a newline
                                break
                            if offset == 0:
                                if b"latitude" not in line.lower():
                                    raise RuntimeError(f"unexpected content: {line[:120]!r}")
                                out.write(line)
                            else:
                                kept += _keep(line, out, w, s, e, n)
                            offset += len(line)
                except urllib.error.HTTPError as exc:
                    if exc.code == 404 and offset == 0:
                        break
                    last_error = f"HTTP {exc.code}"
                except (OSError, http.client.HTTPException) as exc:
                    last_error = str(exc) or type(exc).__name__
                if total is not None and pending and offset + len(pending) == total:
                    kept += _keep(pending + b"\n", out, w, s, e, n)  # genuine last line, no trailing newline
                    offset = total
                if total is not None and offset >= total:
                    break
                time.sleep(min(30, 3 * (attempt + 1)))
            else:
                raise RuntimeError(f"gave up after {MAX_RESUMES} resumes at {offset:,} of {total or 0:,} bytes ({last_error})")
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    if total is None:  # 404 on the first request: this year is not published
        tmp.unlink(missing_ok=True)
        return "not published", 0, 0
    tmp.replace(dest)
    return "ok", kept, offset


def _keep(line: bytes, out, w: float, s: float, e: float, n: float) -> int:
    parts = line.split(b",", 2)
    try:
        lat, lon = float(parts[0]), float(parts[1])
    except (ValueError, IndexError):
        return 0
    if s <= lat < n and w <= lon < e:
        out.write(line)
        return 1
    return 0


def _verify_one(url: str, dest, bbox) -> str:
    """Check a downloaded file against the END of the server's copy (files are sorted by date).

    Fetches only the last part of the remote file, filters it to the bbox, and requires the
    local file to end with exactly those rows. A truncated download fails this test.
    """
    w, s, e, n = bbox
    local = dest.read_bytes().splitlines()
    for suffix in (300_000, 2_000_000, 12_000_000):
        request = urllib.request.Request(url, headers={"Range": f"bytes=-{suffix}"})
        try:
            with urllib.request.urlopen(request, timeout=120) as resp:
                whole = resp.status == 200  # file smaller than the suffix: server sent all of it
                body = resp.read()
                expected = resp.headers.get("Content-Length")
                if expected is not None and len(body) != int(expected):
                    return "could not check (connection dropped)"
        except (OSError, http.client.HTTPException) as exc:
            return f"could not check ({exc})"
        lines = body.splitlines()[0 if whole else 1:]  # first line of a suffix is usually partial
        tail = []
        for line in lines:
            parts = line.split(b",", 2)
            try:
                lat, lon = float(parts[0]), float(parts[1])
            except (ValueError, IndexError):
                continue
            if s <= lat < n and w <= lon < e:
                tail.append(line)
        if tail:
            return "ok" if local[-len(tail):] == tail else "INCOMPLETE"
        if whole:
            return "ok" if len(local) <= 1 else "INCOMPLETE"
    return "could not check (no rows of this region in the last 12 MB)"


def verify(cfg: Config, regions: list[str] | None, workers: int = 6) -> int:
    """Verify every country-year file on disk. Deletes nothing; returns the number of bad files."""
    jobs = []
    for rid, region in cfg.regions.items():
        if regions and rid not in regions:
            continue
        for dest in sorted((cfg.raw / rid).glob("country_*.csv")):
            name = dest.name.removeprefix("country_")
            sensor, year = name.split("_")[:2]
            jobs.append((rid, name, f"{BASE}/{sensor}/{year}/{name}", dest, region.bbox))
    bad = unknown = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = pool.map(lambda j: _verify_one(j[2], j[3], j[4]), jobs)
        for (rid, name, *_), result in zip(jobs, results):
            if result != "ok":
                print(f"[verify] {rid} {name}: {result}", flush=True)
                bad += result == "INCOMPLETE"
                unknown += result != "INCOMPLETE"
    print(f"[verify] {len(jobs)} files checked: {len(jobs) - bad - unknown} ok, {bad} incomplete, {unknown} could not be checked")
    return bad


def fetch(cfg: Config, regions: list[str] | None, sensors: list[str], first_year: int | None,
          last_year: int | None, workers: int = 4) -> None:
    last_year = last_year or datetime.now(timezone.utc).year
    jobs = []
    for rid, region in cfg.regions.items():
        if regions and rid not in regions:
            continue
        if not region.firms_countries:
            print(f"[download] {rid}: no firms_countries in the config - skipped")
            continue
        out_dir = cfg.raw / rid
        out_dir.mkdir(parents=True, exist_ok=True)
        for sensor in sensors:
            if sensor not in FIRST_YEAR:
                raise SystemExit(f"unknown sensor '{sensor}'. Valid: {', '.join(FIRST_YEAR)}")
            for year in range(max(first_year or 0, FIRST_YEAR[sensor]), last_year + 1):
                for country in region.firms_countries:
                    name = f"{sensor}_{year}_{country}.csv"
                    jobs.append((rid, name, f"{BASE}/{sensor}/{year}/{name}", out_dir / f"country_{name}", region.bbox))

    total = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [(job, pool.submit(_fetch_one, job[2], job[3], job[4])) for job in jobs]
        failed = 0
        for (rid, name, _, _, _), fut in futures:
            try:
                status, kept, size = fut.result()
            except Exception as exc:  # one bad file must not stop the rest
                failed += 1
                print(f"[download] {rid} {name}: FAILED ({exc})", flush=True)
                continue
            total += size
            detail = f"{kept:,} rows in bbox, {size / 1e6:.1f} MB read" if status == "ok" else status
            print(f"[download] {rid} {name}: {detail}", flush=True)
    print(f"[download] done, {total / 1e6:.0f} MB transferred"
          + (f", {failed} file(s) FAILED - run the same command again to retry them" if failed else ""))
