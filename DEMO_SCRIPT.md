# 90-second demo script

Live site: https://sunders.earth

Story: **Canada, June 2023.** The 2023 Canadian wildfire season was one of the most widely
reported fire events of the last decade (smoke reached New York in June 2023). In this
project's data, a box over Quebec shows it plainly once the two sensors are put on one scale.

Every number on this page was read from the site on 15 Nov 2026 (data to 13 Nov 2026). If
the data is rebuilt, check them again before presenting.

**Before you start:** open these two tabs and let them load:
1. https://sunders.earth
2. https://sunders.earth/?sel=region:quebec&mode=anomaly (the quick area "Quebec, Canada (2023 fires)")

---

| Time | On screen | Say |
|---|---|---|
| 0:00–0:12 | Tab 1: world map, red VIIRS and yellow MODIS dots, 7-day view. | "Two NASA satellite systems watch for fires. MODIS since 2000, VIIRS since 2012. Here is the last week: hundreds of thousands of detections." (Read the exact VIIRS and MODIS counts off the left panel, under "Fires on the map"; they change daily.) |
| 0:12–0:27 | In the left panel, point at the VIIRS and MODIS counts side by side, then open the "MODIS vs VIIRS" tab under the map. | "The problem: VIIRS has sharper eyes, so for the same fires it reports **about four times more** hotspots than MODIS. Put them on one chart and you get a fake jump that's an instrument change, not a change in burning." |
| 0:27–0:42 | Open the "Burning calendar" tab under the map (whole world); each square shows its value. | "Our pipeline converts VIIRS into MODIS units, region by region and month by month. We tested it on years it never saw: the 4-times gap shrinks to **half a percent or less**, with a correlation of about 0.99." |
| 0:42–1:05 | Switch to tab 2 (Quebec, "Compared with usual"). Point at June 2023, bright orange. | "Here's what one consistent scale lets you see. This box over Quebec: June 2023 had **11 times** its usual June. Of all fire activity here in four years, **81%** happened in 2023 alone." |
| 1:05–1:15 | Hover the June 2023 square (the tooltip shows the likely range), then open "Analysis period & downloads" and point at "Calendar CSV" / "Calendar Excel". | "Every month carries an uncertainty band, and the whole calendar downloads as a CSV with the band, the raw counts and the method used." |
| 1:15–1:30 | Draw a rectangle anywhere (e.g. California), let the calendar update. | "Draw any area on Earth and you get its burning calendar instantly — all computed in your browser from NASA FIRMS data. One fire record, one unit." |

---

## Backup lines if asked

- **"How do you know it works?"** Leave-one-year-out: each year is hidden, the model is fitted
  on the rest and predicts the hidden year. Over ~2,300 block-months per satellite the bias
  is +0.2% to +0.5% (VALIDATION.md).
- **"What's the catch?"** One block in one month can still be off by about 15%, and small
  drawn areas more (−23% for the Quebec box's 2023 total). We show this openly
  (LIMITATIONS.md).
- **"Why only 2022–2026?"** That is the data loaded for the demo. The pipeline already
  handles the full 2000–today record, including the Terra-only years before Aqua.
