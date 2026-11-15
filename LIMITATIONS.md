# Limitations

What this project does **not** do, or does only approximately. Read this before drawing
conclusions from the site.

## About the data

1. **Hotspots are not fires.** A hotspot is one satellite pixel that was hot during one
   overpass. One large fire gives many hotspots; a small or short fire may give none.
   Counts track fire *activity*, not the number of fires or the area burned.
2. **Fires hidden from the satellites are missing.** Cloud, thick smoke, dense canopy and
   fires that burn between overpasses are not detected by either sensor. Harmonization
   cannot recover them.
3. **Only four years are loaded right now** (13 Nov 2022 – 13 Nov 2026). "Usual", "median"
   and "record" on the site compare against at most three other years of the same month.
   A "record year" here is the highest of three complete years, not a long-term record.
4. **The newest months use near-real-time (NRT) data** (MODIS from Sep 2026, VIIRS from
   Aug 2026). NRT has less quality control than standard processing and will be replaced
   when FIRMS publishes the final archive.
5. **Non-vegetation sources are removed only where FIRMS has classified them.** Volcanoes,
   gas flares and industrial heat (`type` 1–3) are dropped from standard-processing data.
   NRT rows have no type, so some of them remain in the newest months.
6. **Low-confidence detections are dropped** (MODIS confidence below 30, VIIRS "low").
   This removes 27.7 million of 250.8 million rows. It reduces false alarms but also
   removes some real small fires.

## About the harmonization

7. **The result is in MODIS units.** VIIRS is converted *down* to what MODIS would have
   seen, so the finer detail of VIIRS (small fires, exact edges) is not added to the
   harmonized numbers. The raw VIIRS points are still shown on the map.
8. **Errors are larger for small areas and single months.** About 15–16% for one 30°
   block in one month; larger for a small drawn area. In one tested case (a box over
   Quebec in 2023) the harmonized total was 23% below MODIS. Use the uncertainty band
   and prefer longer periods and bigger areas for firm statements. See VALIDATION.md.
9. **Custom areas are approximate.** A drawn shape is summed from 0.1° grid cells whose
   centre lies inside it; calibration happens on 1° tiles. Shapes much smaller than a
   tile inherit the tile's conversion factor. The site marks such results "approximate".
10. **The conversion assumes the VIIRS–MODIS relationship stays stable.** MODIS satellites
    have drifted to different overpass times in recent years, which changes what they
    see. That drift is inside the four calibration years and is not modelled.
11. **Gaps in coverage are flagged, not filled.** Partial months (the first and last months
    of the record, satellite outages) are marked on the calendar and hold only the
    days observed. They are not extrapolated.
12. **The uncertainty band covers sensor conversion only**, not the missed fires in points
    1 and 2.

## About the website

13. **Basemap licence:** the default Sentinel-2 cloudless basemap (EOX) is CC BY-NC-SA 4.0,
    fine for this non-commercial project but not for commercial reuse.
14. **Independent project.** This is a NASA Space Apps Challenge 2026 entry. It is not an
    official NASA or FIRMS product, and its numbers are not official statistics.
15. **Map display is sampled when very dense.** If more than 200,000 hotspots are in view,
    an even sample is drawn and the panel says so. The counts in the panel always use all
    data.
16. **The optional FastAPI service (`api/`) has not been updated** for the worldwide 30°
    blocks. The website does not use it.
