// Plain-language "how to read this" texts, shown next to each result and in the guide window.
import type { ReactNode } from "react";

export type ResultTab = "calendar" | "seasonal" | "annual" | "sensors";

export const TAB_LABELS: Record<ResultTab, string> = {
  calendar: "Burning calendar",
  seasonal: "Seasonal profile",
  annual: "Year by year",
  sensors: "MODIS vs VIIRS",
};

export const GUIDES: Record<ResultTab, { title: string; body: ReactNode }> = {
  calendar: {
    title: "How to read the burning calendar",
    body: (
      <>
        <p>Every <strong>row is a year</strong> and every <strong>column is a month</strong>, so each square is one month in the area you chose.</p>
        <ul>
          <li><strong>Colour:</strong> dark purple = little fire, orange = more, bright yellow = the most fire in this area. The legend under the calendar gives the numbers.</li>
          <li><strong>Number in the square:</strong> how many fire detections that month had, in MODIS units (1.2k = 1,200).</li>
          <li><strong>Read down a column</strong> to compare the same month across years (for example, was this August worse than last August?).</li>
          <li><strong>Read along a row</strong> to see the fire season: the bright squares show when fires usually happen.</li>
          <li><strong>Striped squares</strong> are months that were only partly observed (the first and last months of the data). They look lower than they really were.</li>
        </ul>
        <p><strong>Compared with usual</strong> colours each month by how it differs from the same month in the other years: orange = more fire than usual, purple = less, grey = about normal.</p>
        <p>Hover over (or tap) any square for the exact numbers from each satellite.</p>
      </>
    ),
  },
  seasonal: {
    title: "How to read the seasonal profile",
    body: (
      <>
        <p>This shows the <strong>typical fire year</strong> for the area, month by month.</p>
        <ul>
          <li>The <strong>grey line</strong> is the usual (median) amount of fire in each month.</li>
          <li>The <strong>grey band</strong> is the normal range: half of the years fall inside it.</li>
          <li>The <strong>orange line</strong> is the most recent year. Where it rises above the band, that month burned more than usual.</li>
        </ul>
        <p>The highest point of the grey line is the area's main fire season.</p>
      </>
    ),
  },
  annual: {
    title: "How to read the year-by-year chart",
    body: (
      <>
        <p>Each <strong>bar is one year</strong>: the total fire activity in the area for that year, in MODIS units.</p>
        <ul>
          <li><strong>Bright bars</strong> are complete years (all 12 months observed) and can be compared fairly.</li>
          <li><strong>Brown bars</strong> are incomplete years (the data starts in November 2022 and ends in November 2026), so they are lower than a full year would be.</li>
          <li>A dashed trend line appears once there are at least 5 complete years.</li>
        </ul>
      </>
    ),
  },
  sensors: {
    title: "How to read the MODIS vs VIIRS chart",
    body: (
      <>
        <p>This chart shows <strong>why the site exists</strong>. Two satellite instruments watch the same fires:</p>
        <ul>
          <li><strong>Blue line, MODIS</strong> (since 2000): coarser pixels, sees fewer hotspots.</li>
          <li><strong>Pink dotted line, VIIRS</strong> (since 2012): sharper pixels, reports about four times more hotspots for the same fires.</li>
          <li><strong>Orange dashed line, harmonized:</strong> VIIRS converted into MODIS units by this project.</li>
        </ul>
        <p>If the orange line lies on top of the blue one, the conversion works. That is what lets the record continue on VIIRS alone after MODIS retires, without a false jump.</p>
        <p>The vertical axis is logarithmic in the monthly view: each grid line is ten times the one below.</p>
      </>
    ),
  },
};

/** The full guide (window opened from the top bar). */
export function FullGuide() {
  return (
    <>
      <h3>The map</h3>
      <ul>
        <li><strong>Red dots</strong> are VIIRS fire detections and <strong>yellow rings</strong> are MODIS detections, for the days chosen at the top of the left panel (the last 7 days by default). Click a dot for its details.</li>
        <li>The <strong>coloured squares</strong> under the dots are the total fire activity of the whole analysis period per grid square (1° when zoomed out, 0.1° when zoomed in).</li>
        <li>A detection is one hot satellite pixel, not one fire: a big fire gives many detections. Clouds and smoke can hide fires.</li>
      </ul>
      <h3>Choosing an area</h3>
      <p>Pick a quick area (continents and well-known fire regions) or draw your own rectangle, polygon or circle in the <strong>Area</strong> section. Everything below the map updates for that area. The × on the map label goes back to the whole world.</p>
      {(Object.keys(GUIDES) as ResultTab[]).map((k) => (
        <div key={k}>
          <h3>{TAB_LABELS[k]}</h3>
          {GUIDES[k].body}
        </div>
      ))}
    </>
  );
}
