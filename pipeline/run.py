"""Command line entry point.

  python -m pipeline.run all                      ingest + grid + harmonize
  python -m pipeline.run ingest --regions california
  python -m pipeline.run grid
  python -m pipeline.run harmonize
  python -m pipeline.run fetch-nrt --days 14      recent data from the FIRMS area API
  python -m pipeline.run fetch-country            FIRMS yearly country files, no login (history to last full year)
  python -m pipeline.run import-zips --folder data/drive   FIRMS archive-download zips (DL_FIRE_*.zip)
  python -m pipeline.run export-static            data files for the static (GoDaddy) website
  python -m pipeline.run verify-country           check downloaded country files against the server's copy
"""
from __future__ import annotations

import argparse
from datetime import date, datetime, timedelta, timezone

from . import download, export_static, grid, harmonize, import_zips, ingest, ingest_global, nrt
from .config import load_config


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="pipeline.run", description="MODIS + VIIRS hotspot harmonization")
    parser.add_argument("command", choices=["all", "ingest", "grid", "harmonize", "fetch-nrt", "fetch-country", "verify-country", "import-zips", "export-static"])
    parser.add_argument("--config", default="config/pipeline.toml")
    parser.add_argument("--regions", nargs="*", help="region ids (default: all regions in the config)")
    parser.add_argument("--no-figures", action="store_true", help="skip validation figures")
    parser.add_argument("--days", type=int, default=14, help="fetch-nrt: how many days back from today (UTC)")
    parser.add_argument("--start", type=date.fromisoformat, help="fetch-nrt: first day (YYYY-MM-DD), overrides --days")
    parser.add_argument("--end", type=date.fromisoformat, help="fetch-nrt: last day (YYYY-MM-DD), default today UTC")
    parser.add_argument("--sources", nargs="*", default=list(nrt.NRT_SOURCES), help="fetch-nrt: FIRMS source ids")
    parser.add_argument("--sensors", nargs="*", default=["modis", "viirs-snpp", "viirs-jpss1"],
                        help="fetch-country: modis viirs-snpp viirs-jpss1 viirs-jpss2")
    parser.add_argument("--first-year", type=int, help="fetch-country: first year (default: sensor start)")
    parser.add_argument("--last-year", type=int, help="fetch-country: last year (default: current year)")
    parser.add_argument("--folder", default="data/drive", help="import-zips: folder holding DL_FIRE_*.zip files")
    parser.add_argument("--out", default="web/public/data", help="export-static: output folder")
    parser.add_argument("--keep-hotspots", action="store_true", help="export-static: reuse the detection files already exported")
    args = parser.parse_args(argv)

    cfg = load_config(args.config)
    unknown = set(args.regions or []) - set(cfg.regions)
    if unknown:
        parser.error(f"unknown region(s) {sorted(unknown)}; configured: {sorted(cfg.regions)}")

    if args.command == "import-zips":
        import_zips.run(cfg, args.folder)
        return
    if args.command == "export-static":
        export_static.run(cfg, args.out, keep_hotspots=args.keep_hotspots)
        return
    if args.command == "verify-country":
        raise SystemExit(1 if download.verify(cfg, args.regions) else 0)
    if args.command == "fetch-country":
        download.fetch(cfg, args.regions, args.sensors, args.first_year, args.last_year)
        return
    if args.command == "fetch-nrt":
        end = args.end or datetime.now(timezone.utc).date()
        start = args.start or end - timedelta(days=args.days - 1)
        nrt.fetch(cfg, args.regions, start, end, tuple(args.sources))
        return
    if args.command in ("all", "ingest"):
        if cfg.zips:  # worldwide archive-download zips (the project's Drive data)
            ingest_global.run(cfg)
        else:
            ingest.run(cfg, args.regions)
    if args.command in ("all", "grid"):
        grid.run(cfg, args.regions)
    if args.command in ("all", "harmonize"):
        # Calibration always uses every region that has gridded data (global fallback level).
        harmonize.run(cfg, figures=not args.no_figures)


if __name__ == "__main__":
    main()
