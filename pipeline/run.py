"""Command line entry point.

  python -m pipeline.run all                      ingest + grid + harmonize
  python -m pipeline.run ingest --regions california
  python -m pipeline.run grid
  python -m pipeline.run harmonize
  python -m pipeline.run export-static            data files for the static website
"""
from __future__ import annotations

import argparse

from . import export_static, grid, harmonize, ingest, ingest_global
from .config import load_config


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="pipeline.run", description="MODIS + VIIRS hotspot harmonization")
    parser.add_argument("command", choices=["all", "ingest", "grid", "harmonize", "export-static", "export-map", "export-areas"])
    parser.add_argument("--config", default="config/pipeline.toml")
    parser.add_argument("--regions", nargs="*", help="region ids (default: all regions in the config)")
    parser.add_argument("--no-figures", action="store_true", help="skip validation figures")
    parser.add_argument("--out", default="web/public/data", help="export-static: output folder")
    parser.add_argument("--keep-hotspots", action="store_true", help="export-static: reuse the detection files already exported")
    args = parser.parse_args(argv)

    cfg = load_config(args.config)
    unknown = set(args.regions or []) - set(cfg.regions)
    if unknown:
        parser.error(f"unknown region(s) {sorted(unknown)}; configured: {sorted(cfg.regions)}")

    if args.command == "export-areas":
        export_static.export_areas(cfg, args.out)
        return
    if args.command == "export-map":
        export_static.export_map(cfg, args.out)
        return
    if args.command == "export-static":
        export_static.run(cfg, args.out, keep_hotspots=args.keep_hotspots)
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
