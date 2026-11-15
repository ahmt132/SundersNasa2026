import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  ApiError, DETAIL_ZOOM, calendarExport, fetchCalendar, fetchCells, fetchPoints, fetchRegions, hotspotsExport, saveBlob,
  type CellsResponse, type ExportFormat, type Meta, type MonthRow, type PointsResult, type Query, type RegionsResponse, type View,
} from "./api";
import { BootScreen } from "./components/BootScreen";
import { Calendar } from "./components/Calendar";
import { AnnualTotals, SeasonalProfile, SensorPanel } from "./components/Charts";
import { FullGuide, GUIDES, TAB_LABELS, type ResultTab } from "./components/Guide";
import { BASEMAPS, MapView, POINT_COLORS, type Basemap, type DrawMode, type Layers } from "./components/MapView";
import { MONTHS, fmt, monthLabel, selectionLabel } from "./lib";
import { useViewState } from "./state";

interface Data {
  months: MonthRow[];
  meta: Meta;
}

const CONTACTS = ["a.sungur2008@gmail.com", "alexcemanders32@gmail.com"];
const TEAM_PAGE = "https://www.spaceappschallenge.org/2026/find-a-team/sunders/";

const WINDOWS = [{ days: 1, label: "24 HRS" }, { days: 3, label: "3 DAYS" }, { days: 7, label: "7 DAYS" }] as const;
const MAX_RANGE_DAYS = 92; // individual detections for longer periods are too many to draw; the calendar covers those
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
/** YYYY-MM shifted by n months. */
const addMonths = (ym: string, n: number) => {
  const i = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
};

// ---------------------------------------------------------------- small pieces

function Icon({ d, size = 18 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
  );
}
const ICONS = {
  menu: "M3 6h18M3 12h18M3 18h18",
  close: "M6 6l12 12M18 6L6 18",
  link: "M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1 1M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1-1",
  book: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5",
  mail: "M4 5h16v14H4zM4 6l8 7 8-7",
  down: "M6 9l6 6 6-6",
  up: "M6 15l6-6 6 6",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01",
  cal: "M3 5h18v16H3zM16 3v4M8 3v4M3 10h18",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
};

function MonthPicker({ label, value, min, max, onChange }: { label: string; value: string; min: string; max: string; onChange: (v: string) => void }) {
  const [y0, y1] = [Number(min.slice(0, 4)), Number(max.slice(0, 4))];
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5));
  const set = (y: number, m: number) => {
    const v = `${y}-${String(m).padStart(2, "0")}`;
    onChange(v < min ? min : v > max ? max : v);
  };
  return (
    <fieldset className="month-picker">
      <legend>{label}</legend>
      <select aria-label={`${label} month`} value={month} onChange={(e) => set(year, Number(e.target.value))}>
        {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
      </select>
      <select aria-label={`${label} year`} value={year} onChange={(e) => set(Number(e.target.value), month)}>
        {Array.from({ length: y1 - y0 + 1 }, (_, i) => y0 + i).map((y) => <option key={y} value={y}>{y}</option>)}
      </select>
    </fieldset>
  );
}

function Section({ id, title, count, open, onToggle, children }: {
  id: string; title: string; count?: string; open: boolean; onToggle: (id: string) => void; children: ReactNode;
}) {
  return (
    <section className={open ? "section open" : "section"}>
      <h2>
        <button type="button" aria-expanded={open} aria-controls={`sec-${id}`} onClick={() => onToggle(id)}>
          <span>{title}{count && <span className="count"> ({count})</span>}</span>
          <Icon d={open ? ICONS.minus : ICONS.plus} size={16} />
        </button>
      </h2>
      {open && <div id={`sec-${id}`} className="section-body">{children}</div>}
    </section>
  );
}

function LayerRow({ on, color, kind, label, hint, onClick }: {
  on: boolean; color: string; kind: "dot" | "ring" | "grid" | "line"; label: string; hint: string; onClick: () => void;
}) {
  return (
    <div className="layer-row">
      <button type="button" className="layer-toggle" aria-pressed={on} onClick={onClick}>
        <span className={`swatch ${kind}`} style={{ "--c": color } as React.CSSProperties} aria-hidden="true" />
        <span className="layer-label">{label}</span>
        <span className="layer-state">{on ? "on" : "off"}</span>
      </button>
      <span className="info" title={hint} aria-label={hint} role="img"><Icon d={ICONS.info} size={16} /></span>
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        <header><h2>{title}</h2><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon d={ICONS.close} /></button></header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- app
// Layout: top bar; left = controls (map days and layers, area, period and downloads); centre = map;
// under the map = results (burning calendar and charts, each with a "how to read" guide beside it).

export default function App() {
  const [view, setView] = useViewState();
  const [regions, setRegions] = useState<RegionsResponse | null>(null);
  const [data, setData] = useState<Data | null>(null);
  const [cells, setCells] = useState<CellsResponse | null>(null);
  const [points, setPoints] = useState<PointsResult>({ points: [], total: 0, stride: 1, modis: 0, zoomIn: false });
  const [mapView, setMapView] = useState<View | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [controlsOpen, setControlsOpen] = useState(true);
  const [resultsOpen, setResultsOpen] = useState(true);
  const [tab, setTab] = useState<ResultTab>("calendar");
  const [open, setOpen] = useState<Record<string, boolean>>({ intro: true, map: true, area: true, period: false });
  const [layers, setLayers] = useState<Layers>({ viirs: true, modis: true, cells: true, labels: true });
  const [basemap, setBasemap] = useState<Basemap>("sentinel");
  const [imagery, setImagery] = useState<string | null>(null);
  // map window: any two dates (inclusive); the round buttons are shortcuts ending on the latest day
  const [windowStart, setWindowStart] = useState<string | null>(null);
  const [windowEnd, setWindowEnd] = useState<string | null>(null);
  const [rangeOpen, setRangeOpen] = useState(false);
  const [rangeDraft, setRangeDraft] = useState({ from: "", to: "" });
  const [rangeError, setRangeError] = useState("");
  const [drawMode, setDrawMode] = useState<DrawMode>(null);
  const [nVerts, setNVerts] = useState(0);
  const [cursor, setCursor] = useState<{ lat: number; lon: number } | null>(null);
  const [point, setPoint] = useState({ lat: "", lon: "", km: "25" });
  const [formError, setFormError] = useState("");
  const [modal, setModal] = useState<null | "about" | "guide" | "contact">(null);
  const finishRef = useRef<() => void>(() => undefined);
  const [pointsReady, setPointsReady] = useState(false);
  const [drawn, setDrawn] = useState(false);
  const [bootTimedOut, setBootTimedOut] = useState(false);
  useEffect(() => {
    // Never keep the loading screen up forever (for example if a map tile server is very slow).
    const t = window.setTimeout(() => setBootTimedOut(true), 30_000);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    fetchRegions()
      .then((r) => {
        setRegions(r);
        if (r.last_day) {
          setWindowEnd(r.last_day);
          setWindowStart(addDays(r.last_day, -6));
        }
        // no area in the link, or one that no longer exists: start with the whole world
        const sel = view.sel;
        if (!sel || (sel.type === "region" && !r.regions.some((x) => x.id === sel.id))) setView({ sel: { type: "region", id: "world" } });
      })
      .catch((e) => setError(e instanceof ApiError ? e : new ApiError(0, "error", String(e))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const query: Query | null = useMemo(
    () => (view.sel && regions ? { sel: view.sel, from: view.from, to: view.to, metric: view.metric } : null),
    [view.sel, view.from, view.to, view.metric, regions],
  );

  useEffect(() => {
    if (!query) return;
    let live = true;
    setLoading(true);
    fetchCalendar(query)
      .then((cal) => {
        if (!live) return;
        setData({ months: cal.months, meta: cal.meta });
        setError(null);
      })
      .catch((e) => {
        if (!live) return;
        setError(e instanceof ApiError ? e : new ApiError(0, "error", String(e)));
        setData(null);
      })
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [query]);

  // the map layer depends on what is on screen only through the detail level and the visible blocks
  const detail = mapView && mapView.zoom >= DETAIL_ZOOM ? mapView.bounds.map((v) => Math.round(v)).join(",") : "world";
  useEffect(() => {
    let live = true;
    fetchCells(view.from, view.to, view.metric, mapView).then((c) => live && setCells(c)).catch(() => undefined);
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.from, view.to, view.metric, detail]);

  const windowDays = windowStart && windowEnd ? Math.round((Date.parse(windowEnd) - Date.parse(windowStart)) / 864e5) + 1 : 0;
  const lastDay = regions?.last_day ?? null;
  const firstDay = regions ? regions.first_day ?? `${regions.data_range.start}-01` : null;
  const preset = (days: number) => {
    if (!lastDay) return;
    setWindowEnd(lastDay);
    setWindowStart(addDays(lastDay, -(days - 1)));
    setRangeOpen(false);
  };
  const applyRange = (e: FormEvent) => {
    e.preventDefault();
    const { from: a, to: b } = rangeDraft;
    if (!a || !b) return setRangeError("Choose both dates.");
    if (a > b) return setRangeError("The start date must be on or before the end date.");
    if ((firstDay && a < firstDay) || (lastDay && b > lastDay)) return setRangeError(`Data covers ${firstDay} to ${lastDay}.`);
    if ((Date.parse(b) - Date.parse(a)) / 864e5 + 1 > MAX_RANGE_DAYS)
      return setRangeError(`Choose at most ${MAX_RANGE_DAYS} days. For longer periods use the burning calendar.`);
    setRangeError("");
    setWindowStart(a);
    setWindowEnd(b);
    setRangeOpen(false);
  };
  useEffect(() => {
    if (!windowEnd || !windowStart) return;
    let live = true;
    fetchPoints(windowStart, windowEnd, mapView)
      .then((r) => { if (live) { setPoints(r); setPointsReady(true); } })
      .catch(() => live && setPointsReady(true));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowStart, windowEnd, mapView?.bounds.map((v) => v.toFixed(1)).join(",")]);

  const booting = !drawn && !bootTimedOut && !error;
  const bootStage = !regions ? "Reading the data index"
    : cells == null ? "Loading the world fire grid"
    : !pointsReady ? `Loading fire detections, ${windowDays} days`
    : !data ? "Preparing the burning calendar"
    : `Drawing ${points.total.toLocaleString("en-US")} fire detections`;

  const range = regions?.data_range;
  const from = view.from ?? range?.start ?? "2022-11";
  const to = view.to ?? range?.end ?? "2026-11";
  const last12 = range ? addMonths(range.end, -11) : null;
  const unitShort = view.metric === "count" ? "hotspots" : "active cell-days";
  const selLabel = view.sel && regions ? selectionLabel(view.sel, regions.regions) : "";
  const footer = data
    ? `Source: NASA FIRMS, MODIS Collection 6.1 and VIIRS 375 m active fire. Area: ${selLabel}. Pipeline run ${data.meta.pipeline_run_utc.slice(0, 10)}.`
    : "";
  const nModis = points.modis;
  const nViirs = points.total - points.modis;
  const groups = useMemo(() => {
    const g = new Map<string, RegionsResponse["regions"]>();
    regions?.regions.forEach((r) => g.set(r.group, [...(g.get(r.group) ?? []), r]));
    return [...g.entries()];
  }, [regions]);

  const flash = (text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice(""), 4500);
  };
  const share = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      flash("Link copied. It reopens this exact view.");
    } catch {
      flash("Copy the address bar: it already encodes this view.");
    }
  };
  const exportFile = async (kind: "calendar" | "hotspots", format: ExportFormat) => {
    if (!query) return;
    flash(kind === "hotspots" ? "Preparing hotspot file…" : "Preparing calendar file…");
    try {
      const blob = kind === "calendar" ? await calendarExport(query, selLabel, format) : await hotspotsExport(query, selLabel, format);
      saveBlob(blob, kind === "calendar" ? `burning_calendar_${view.metric}.${format}` : `hotspots.${format}`);
      flash("Download ready.");
    } catch (e) {
      flash((e as Error).message);
    }
  };
  const methodsNote = () => {
    if (!data) return;
    saveBlob(new Blob([methodsText(data, selLabel, from, to)], { type: "text/plain;charset=utf-8" }), "burning-calendar-methods.txt");
  };
  const applyPoint = (e: FormEvent) => {
    e.preventDefault();
    const lat = Number(point.lat), lon = Number(point.lon), km = Number(point.km);
    if (!point.lat || !Number.isFinite(lat) || lat < -90 || lat > 90) return setFormError("Latitude must be between −90 and 90.");
    if (!point.lon || !Number.isFinite(lon) || lon < -180 || lon > 180) return setFormError("Longitude must be between −180 and 180.");
    if (!Number.isFinite(km) || km <= 0 || km > 500) return setFormError("Radius must be between 0 and 500 km.");
    setFormError("");
    setView({ sel: { type: "circle", lat, lon, radius_km: km } });
    setDrawMode(null);
  };
  const isWorld = !view.sel || (view.sel.type === "region" && view.sel.id === "world");
  const clearArea = () => {
    setDrawMode(null);
    setView({ sel: { type: "region", id: "world" } });
  };
  const toggle = (id: string) => setOpen((o) => ({ ...o, [id]: !o[id] }));
  const startDraw = (m: DrawMode) => {
    setNVerts(0);
    setFormError("");
    setDrawMode((cur) => (cur === m ? null : m));
  };
  const period = data && data.months.length
    ? `${monthLabel(data.months[0].month)} – ${monthLabel(data.months[data.months.length - 1].month)}` : "";

  return (
    <div className={`app${controlsOpen ? "" : " controls-closed"}${resultsOpen ? "" : " results-closed"}`}>
      <BootScreen stage={bootStage} done={!booting} />
      <header className="topbar">
        <button type="button" className="icon-btn" aria-label={controlsOpen ? "Hide controls" : "Show controls"} aria-expanded={controlsOpen}
          onClick={() => setControlsOpen((v) => !v)}><Icon d={ICONS.menu} size={22} /></button>
        <div className="brand">
          <img className="mark" src="./brand/planet-logo-v2.png" alt="" width={38} height={38} />
          <div>
            <div className="brand-name">Burning Calendar</div>
            <div className="brand-sub">One fire record from two generations of NASA satellites · NASA Space Apps Challenge 2026 · team Sunders</div>
          </div>
        </div>
        <nav className="top-links" aria-label="Site">
          <button type="button" onClick={() => setModal("about")}><Icon d={ICONS.info} /> <span>About</span></button>
          <button type="button" onClick={() => setModal("guide")}><Icon d={ICONS.book} /> <span>How to read</span></button>
          <button type="button" onClick={() => setModal("contact")}><Icon d={ICONS.mail} /> <span>Contact</span></button>
          <button type="button" onClick={share}><Icon d={ICONS.link} /> <span>Share link</span></button>
        </nav>
      </header>

      <div className="workspace">
        {/* ---------------- controls (left) */}
        {controlsOpen && (
          <aside className="controls" aria-label="Controls">
            {open.intro && (
              <div className="intro">
                <button type="button" className="icon-btn intro-close" aria-label="Hide this introduction" onClick={() => toggle("intro")}><Icon d={ICONS.close} size={16} /></button>
                <p><strong>Built for the NASA Space Apps Challenge 2026</strong> by team Sunders, for the challenge <em>Harmonization of MODIS and VIIRS Hot Spots</em>.</p>
                <p>NASA&apos;s older MODIS and newer VIIRS satellites see the same fires very differently: VIIRS reports about four times more hotspots. This site converts both into one consistent unit, so fire activity can be compared across places and years.</p>
                <p className="intro-links">
                  <button type="button" className="link" onClick={() => setModal("about")}>About the project</button>
                  <button type="button" className="link" onClick={() => setModal("guide")}>How to read the site</button>
                </p>
              </div>
            )}

            <Section id="map" title="Fires on the map" open={open.map} onToggle={toggle}>
              <div className="time-row" role="group" aria-label="Days of detections shown on the map">
                {WINDOWS.map((w) => (
                  <button key={w.days} type="button" className="round"
                    aria-pressed={!rangeOpen && windowEnd === lastDay && windowDays === w.days}
                    onClick={() => preset(w.days)}>{w.label}</button>
                ))}
                <button type="button" className="round cal" aria-pressed={rangeOpen || (windowEnd !== lastDay || !WINDOWS.some((w) => w.days === windowDays))}
                  aria-expanded={rangeOpen} title="Choose two dates" aria-label="Choose two dates"
                  onClick={() => {
                    setRangeDraft({ from: windowStart ?? "", to: windowEnd ?? "" });
                    setRangeError("");
                    setRangeOpen((o) => !o);
                  }}>
                  <Icon d={ICONS.cal} />
                </button>
                <div className="time-text">
                  <strong>{windowDays} {windowDays === 1 ? "DAY" : "DAYS"}</strong>
                  <span>{windowStart === windowEnd ? windowEnd : `${windowStart} → ${windowEnd}`}{windowEnd === lastDay ? " (latest)" : ""}</span>
                </div>
              </div>
              {rangeOpen && (
                <form className="range-form" onSubmit={applyRange}>
                  <label className="field"><span>From</span>
                    <input type="date" value={rangeDraft.from} min={firstDay ?? undefined} max={lastDay ?? undefined}
                      onChange={(e) => setRangeDraft((d) => ({ ...d, from: e.target.value }))} />
                  </label>
                  <label className="field"><span>To</span>
                    <input type="date" value={rangeDraft.to} min={rangeDraft.from || firstDay || undefined} max={lastDay ?? undefined}
                      onChange={(e) => setRangeDraft((d) => ({ ...d, to: e.target.value }))} />
                  </label>
                  <button type="submit" className="primary">Show</button>
                  <button type="button" onClick={() => setRangeOpen(false)}>Cancel</button>
                  <p className="small">Any two dates between {firstDay} and {lastDay}, up to {MAX_RANGE_DAYS} days. Dates before the last 7 days are drawn for the area on screen, so zoom in to a region first.</p>
                  {rangeError && <p className="error" role="alert">{rangeError}</p>}
                </form>
              )}
              <div className="layers">
                <LayerRow on={layers.viirs} color={POINT_COLORS.viirs} kind="dot" label={`VIIRS detections · ${fmt(nViirs)}`}
                  hint="Each dot is one VIIRS 375 m detection (S-NPP, NOAA-20, NOAA-21; nominal or high confidence). Click a dot for details."
                  onClick={() => setLayers((l) => ({ ...l, viirs: !l.viirs }))} />
                <LayerRow on={layers.modis} color={POINT_COLORS.modis} kind="ring" label={`MODIS detections · ${fmt(nModis)}`}
                  hint="Each ring is one MODIS 1 km detection (Terra and Aqua; confidence 30 or more)."
                  onClick={() => setLayers((l) => ({ ...l, modis: !l.modis }))} />
                <LayerRow on={layers.cells} color="#f98e09" kind="grid" label={`Total fire per ${cells?.cell_deg === 1 ? "1°" : "0.1°"} square`}
                  hint="Harmonized (MODIS-equivalent) total over the analysis period: 1-degree squares when zoomed out, 0.1-degree squares when zoomed in."
                  onClick={() => setLayers((l) => ({ ...l, cells: !l.cells }))} />
                <LayerRow on={layers.labels} color="#ffffff" kind="line" label="Place names & borders" hint="Place names and country borders over the imagery."
                  onClick={() => setLayers((l) => ({ ...l, labels: !l.labels }))} />
                <label className="field background-pick">
                  <span>Map background</span>
                  <select value={imagery ? `img:${imagery}` : basemap} onChange={(e) => {
                    const v = e.target.value;
                    if (v.startsWith("img:")) setImagery(v.slice(4));
                    else { setImagery(null); setBasemap(v as Basemap); }
                  }}>
                    {(Object.keys(BASEMAPS) as Basemap[]).map((id) => <option key={id} value={id}>{BASEMAPS[id].label}</option>)}
                    <option value="img:VIIRS_NOAA20_CorrectedReflectance_TrueColor">Satellite image of {windowEnd ?? "the last day"} (VIIRS NOAA-20)</option>
                  </select>
                </label>
                {points.stride > 1 && (
                  <p className="small">{fmt(points.total)} detections in view: the map draws every {points.stride}th one. Zoom in to see all of them.</p>
                )}
                {points.zoomIn && <p className="small">Detections before the last 7 days are shown for the area on screen: zoom in to a region (about 60° across or less).</p>}
              </div>
            </Section>

            <Section id="area" title="Area" open={open.area} onToggle={toggle}>
              <label className="field">
                <span>Quick areas</span>
                <select value={view.sel?.type === "region" ? view.sel.id : ""} onChange={(e) => e.target.value && setView({ sel: { type: "region", id: e.target.value } })}>
                  <option value="" disabled>Custom area</option>
                  {groups.map(([group, list]) => (
                    <optgroup key={group} label={group}>
                      {list.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </optgroup>
                  ))}
                </select>
              </label>
              <div className="draw-label label">Or draw your own</div>
              <div className="seg" role="group" aria-label="Draw an area">
                <button type="button" aria-pressed={drawMode === "rect"} onClick={() => startDraw("rect")}>Rectangle</button>
                <button type="button" aria-pressed={drawMode === "poly"} onClick={() => startDraw("poly")}>Polygon</button>
                <button type="button" aria-pressed={drawMode === "point"} onClick={() => startDraw("point")}>Point + radius</button>
              </div>
              {drawMode === "point" && (
                <form className="point-form" onSubmit={applyPoint}>
                  <label className="field"><span>Latitude</span><input inputMode="decimal" value={point.lat} onChange={(e) => setPoint({ ...point, lat: e.target.value })} /></label>
                  <label className="field"><span>Longitude</span><input inputMode="decimal" value={point.lon} onChange={(e) => setPoint({ ...point, lon: e.target.value })} /></label>
                  <label className="field"><span>Radius, km</span><input inputMode="decimal" value={point.km} onChange={(e) => setPoint({ ...point, km: e.target.value })} /></label>
                  <button type="submit" className="primary">Apply</button>
                  {formError && <p className="error" role="alert">{formError}</p>}
                </form>
              )}
              <div className="selection-line">
                <span className="label">Selected</span> <span>{selLabel || "–"}</span>
                {!isWorld && <button type="button" className="clear-btn" onClick={clearArea}>Clear area</button>}
              </div>
              {data?.meta.approximate && (
                <p className="small">Custom area: monthly values are summed over 0.1° grid squares whose centre lies inside the shape. Hotspot downloads use the exact shape.</p>
              )}
            </Section>

            <Section id="period" title="Analysis period & downloads" open={open.period} onToggle={toggle}>
              {range && (
                <>
                  <div className="row">
                    <MonthPicker label="From" value={from} min={range.start} max={to} onChange={(v) => setView({ from: v === range.start ? null : v })} />
                    <MonthPicker label="To" value={to} min={from} max={range.end} onChange={(v) => setView({ to: v === range.end ? null : v })} />
                  </div>
                  <div className="seg" role="group" aria-label="Period presets">
                    <button type="button" aria-pressed={!view.from && !view.to} onClick={() => setView({ from: null, to: null })}>All years</button>
                    <button type="button" aria-pressed={view.from === last12 && !view.to} onClick={() => setView({ from: last12, to: null })}>Last 12 months</button>
                  </div>
                </>
              )}
              <label className="field">
                <span>Measure</span>
                <select value={view.metric} onChange={(e) => setView({ metric: e.target.value as "count" | "celldays" })}>
                  <option value="count">Hotspot count</option>
                  <option value="celldays">Active cell-days (0.05°)</option>
                </select>
              </label>
              <div className="downloads">
                <button type="button" className="primary" disabled={!data} onClick={() => exportFile("calendar", "csv")}>Calendar CSV</button>
                <button type="button" disabled={!data} onClick={() => exportFile("calendar", "xlsx")}
                  title="Excel workbook: opens correctly in any language version of Excel">Calendar Excel</button>
                <button type="button" disabled={!data} onClick={() => exportFile("hotspots", "csv")}>Hotspots CSV</button>
                <button type="button" disabled={!data} onClick={() => exportFile("hotspots", "xlsx")}
                  title="Excel workbook: opens correctly in any language version of Excel">Hotspots Excel</button>
                <button type="button" disabled={!data} onClick={methodsNote}>Methods note</button>
              </div>
            </Section>

            {notice && <p className="notice" role="status">{notice}</p>}
            <p className="panel-note">
              <strong>NOTE:</strong> Hotspots are satellite pixel detections of active fire, not individual fires; cloud and smoke hide fires.
              {regions && ` Data: ${regions.data_range.start} to ${regions.last_day ?? regions.data_range.end}.`}
            </p>
          </aside>
        )}

        {/* ---------------- map (centre) */}
        <main className="map-area">
          <MapView
            regions={regions?.regions ?? []} sel={view.sel} cells={cells} points={points.points} layers={layers}
            basemap={basemap} imagery={imagery} imageryDate={windowEnd} drawMode={drawMode}
            onDrawEnd={() => setDrawMode(null)} onDrawCount={setNVerts} onSelect={(sel) => setView({ sel })}
            onPickPoint={(lat, lon) => setPoint((p) => ({ ...p, lat: lat.toFixed(4), lon: lon.toFixed(4) }))}
            onCursor={setCursor} onView={setMapView} onClear={clearArea} finishRef={finishRef}
            awaitDrawn={booting && pointsReady && cells != null} onDrawn={() => setDrawn(true)}
          />
          <div className="infobar" aria-live="off">
            <span>{cursor ? `Lat ${cursor.lat.toFixed(3)}°, Lon ${cursor.lon.toFixed(3)}°` : "Lat –, Lon –"}</span>
            <span>Detections: {windowEnd ? `${windowStart === windowEnd ? windowEnd : `${windowStart} to ${windowEnd}`} (${windowDays} ${windowDays === 1 ? "day" : "days"})` : "–"}</span>
          </div>
          {drawMode && (
            <div className="draw-hint" role="status">
              {drawMode === "rect" && "Drag on the map to draw a rectangle. Esc cancels."}
              {drawMode === "poly" && <>Click to add corners ({nVerts}). Double-click or Enter to finish. <button type="button" className="link" disabled={nVerts < 3} onClick={() => finishRef.current()}>Finish</button></>}
              {drawMode === "point" && "Click the map to place the centre, or type it in the panel."}
              <button type="button" className="link" onClick={() => setDrawMode(null)}>Cancel</button>
            </div>
          )}
        </main>

        {/* ---------------- results (under the map) */}
        <section className="results" aria-label="Results for the selected area">
          <div className="results-head">
            <div className="tabs" role="tablist" aria-label="Results">
              {(Object.keys(TAB_LABELS) as ResultTab[]).map((k) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k}
                  onClick={() => { setTab(k); setResultsOpen(true); }}>{TAB_LABELS[k]}</button>
              ))}
            </div>
            <div className="results-where">
              <span className="label">Area</span> <strong>{selLabel || "–"}</strong>
              {period && <span className="results-period">{period}</span>}
            </div>
            <button type="button" className="icon-btn" aria-expanded={resultsOpen}
              aria-label={resultsOpen ? "Make the map bigger (hide results)" : "Show results"} title={resultsOpen ? "Hide results" : "Show results"}
              onClick={() => setResultsOpen((o) => !o)}><Icon d={resultsOpen ? ICONS.down : ICONS.up} /></button>
          </div>
          {resultsOpen && (
            <div className="results-body">
              {error ? (
                <div className="message" role="alert">
                  <strong>{error.code === "empty_selection" ? "No hotspots here" : error.code === "outside_coverage" ? "No fires in this area" : "Could not load this view"}</strong>
                  <p>{error.message}</p>
                </div>
              ) : !data ? (
                <p className="loading">Loading…</p>
              ) : (
                <div className={loading ? "result-grid stale" : "result-grid"}>
                  <div className="result-chart" role="tabpanel" aria-label={TAB_LABELS[tab]}>
                    {tab === "calendar" && (
                      <Calendar months={data.months} mode={view.mode} scale={view.scale} unit={data.meta.unit} footer={footer}
                        onMode={(mode) => setView({ mode })} onScale={(scale) => setView({ scale })} />
                    )}
                    {tab === "seasonal" && <SeasonalProfile months={data.months} unitShort={unitShort} footer={footer} />}
                    {tab === "annual" && <AnnualTotals months={data.months} unitShort={unitShort} footer={footer} />}
                    {tab === "sensors" && (
                      <SensorPanel months={data.months} unitShort={unitShort} footer={footer} agg={view.agg} onAgg={(agg) => setView({ agg })} />
                    )}
                  </div>
                  <aside className="result-guide" aria-label={GUIDES[tab].title}>
                    <h3>{GUIDES[tab].title}</h3>
                    {GUIDES[tab].body}
                  </aside>
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      {modal === "about" && (
        <Modal title="About this project" onClose={() => setModal(null)}>
          <img className="team-banner" src="./brand/sunders-banner.jpg" alt="Team Sunders banner" width={648} height={406} />
          <p><strong>Burning Calendar</strong> was built by team <strong>Sunders</strong> for the <strong>NASA Space Apps Challenge 2026</strong>, for the challenge <em>Harmonization of MODIS and VIIRS Hot Spots</em>.</p>
          <p>NASA satellites have watched fires from space since 2000. The older MODIS instruments (on Terra and Aqua) see the Earth in 1 km pixels; the newer VIIRS instruments (on S-NPP, NOAA-20 and NOAA-21) use 375 m pixels and report about four times more hotspots for the same fires. Put on one chart, the two records disagree, and the change of satellite looks like a change in burning.</p>
          <p>This site converts VIIRS detections into MODIS units, separately for every part of the world and season, and checks the conversion on years it was not trained on. The result is one consistent fire record that can continue on VIIRS after MODIS retires. Choose any area to see its burning calendar: when fires happen, and whether a month was unusual.</p>
          <h3>Data and credits</h3>
          <p>{regions?.citation}</p>
          <p>We acknowledge the use of data and imagery from LANCE FIRMS operated by NASA&apos;s Goddard Space Flight Center Earth Science Data and Information System (ESDIS) with funding provided by NASA Headquarters.</p>
          <p>Daily true-colour imagery and Blue Marble: NASA EOSDIS Global Imagery Browse Services (GIBS). Background imagery: EOxCloudless by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2024), CC BY-NC-SA 4.0. Black Marble night lights: NASA EOSDIS GIBS. Streets map and place names: data © OpenStreetMap contributors and others, rendering © EOX (maps.eox.at).</p>
          <p>This is an independent NASA Space Apps Challenge project, not an official NASA product.</p>
        </Modal>
      )}
      {modal === "guide" && (
        <Modal title="How to read this site" onClose={() => setModal(null)}>
          <FullGuide />
        </Modal>
      )}
      {modal === "contact" && (
        <Modal title="Contact team Sunders" onClose={() => setModal(null)}>
          <p>Questions, ideas or feedback about Burning Calendar? Write to us:</p>
          <ul className="contact-list">
            {CONTACTS.map((m) => <li key={m}><Icon d={ICONS.mail} /> <a href={`mailto:${m}`}>{m}</a></li>)}
          </ul>
          <p>Our team page on the NASA Space Apps Challenge site:</p>
          <p><a href={TEAM_PAGE} target="_blank" rel="noopener noreferrer">{TEAM_PAGE}</a></p>
        </Modal>
      )}
    </div>
  );
}

function methodsText(data: Data, selLabel: string, from: string, to: string): string {
  return [
    "Burning calendar - methods note", "",
    `Area: ${selLabel}`, `Period: ${from} to ${to}`, `Unit: ${data.meta.unit}`, "",
    "What the numbers are",
    "- Hotspots are satellite pixel detections of active fire, not individual fires.",
    "- Cleaning: MODIS confidence >= 30; VIIRS confidence nominal or high; " +
      (data.meta.include_nonveg_types ? "all detection types included." : "only presumed vegetation fires (type 0) where the type is known."),
    "- Data: FIRMS archive downloads supplied for the project, whole world, 13 Nov 2022 to 13 Nov 2026.",
    "- The harmonized value is VIIRS (S-NPP, then NOAA-20/21) converted to MODIS-equivalent units. The transfer is fitted per 1-degree tile and calendar month where both sensors observed, with fallback to the 30-degree world block and the whole world where data is sparse.",
    "- The transfer method (Theil-Sen log-log, quantile mapping, or ratio) is the one with the lowest leave-one-year-out error for the region.",
    `- Uncertainty band: ${data.meta.band}. Zero width where MODIS is observed directly.`,
    "- Partial months hold only the days observed and are flagged, not extrapolated.",
    ...(data.meta.approximate ? ["- Custom area: monthly values are summed over 0.1-degree grid cells whose centre lies inside the shape."] : []),
    "", "Limits",
    "- Cloud and smoke hide fires from both sensors. Small or short fires between overpasses are missed.",
    "- MODIS and VIIRS pass at different local times; Terra and Aqua orbits have drifted in recent years.",
    "- The conversion is statistical: single months can be off by the width of the band.",
    "", `Pipeline run ${data.meta.pipeline_run_utc}.`, data.meta.citation,
  ].join("\n");
}
