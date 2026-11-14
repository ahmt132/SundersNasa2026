import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  ApiError, DETAIL_ZOOM, calendarCsv, fetchCalendar, fetchCells, fetchPoints, fetchRegions, hotspotsCsv, saveBlob, summarize,
  type CellsResponse, type Kpis, type Meta, type MonthRow, type PointsResult, type Query, type RegionsResponse, type View,
} from "./api";
import { Calendar } from "./components/Calendar";
import { AnnualTotals, SeasonalProfile, SensorPanel } from "./components/Charts";
import { KpiStrip } from "./components/KpiStrip";
import { BASEMAPS, MapView, POINT_COLORS, type Basemap, type DrawMode, type Layers } from "./components/MapView";
import { MONTHS, fmt, monthLabel, selectionLabel } from "./lib";
import { useViewState } from "./state";

interface Data {
  months: MonthRow[];
  meta: Meta;
  kpis: Kpis;
}

const WINDOWS = [{ days: 1, label: "24 HRS" }, { days: 3, label: "3 DAYS" }, { days: 7, label: "7 DAYS" }] as const;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

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
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01",
  cal: "M3 5h18v16H3zM16 3v4M8 3v4M3 10h18",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  wide: "M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4",
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

export default function App() {
  const [view, setView] = useViewState();
  const [regions, setRegions] = useState<RegionsResponse | null>(null);
  const [data, setData] = useState<Data | null>(null);
  const [cells, setCells] = useState<CellsResponse | null>(null);
  const [points, setPoints] = useState<PointsResult>({ points: [], truncated: false, zoomIn: false });
  const [mapView, setMapView] = useState<View | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [panelOpen, setPanelOpen] = useState(true);
  const [wide, setWide] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({ area: true, period: false, kpis: true, calendar: true, charts: false });
  const [layers, setLayers] = useState<Layers>({ viirs: true, modis: true, cells: true, outlines: false, labels: true });
  const [basemap, setBasemap] = useState<Basemap>("sentinel");
  const [imagery, setImagery] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState<number>(7);
  const [windowEnd, setWindowEnd] = useState<string | null>(null);
  const [drawMode, setDrawMode] = useState<DrawMode>(null);
  const [nVerts, setNVerts] = useState(0);
  const [cursor, setCursor] = useState<{ lat: number; lon: number } | null>(null);
  const [point, setPoint] = useState({ lat: "", lon: "", km: "25" });
  const [formError, setFormError] = useState("");
  const [modal, setModal] = useState<null | "methods" | "about">(null);
  const finishRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    fetchRegions()
      .then((r) => {
        setRegions(r);
        setWindowEnd(r.last_day);
        if (!view.sel && r.regions.length) {
          const first = r.regions.find((x) => x.id === "world") ?? r.regions[0];
          setView({ sel: { type: "region", id: first.id } });
        }
      })
      .catch((e) => setError(e instanceof ApiError ? e : new ApiError(0, "error", String(e))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const query: Query | null = useMemo(
    () => (view.sel ? { sel: view.sel, from: view.from, to: view.to, metric: view.metric } : null),
    [view.sel, view.from, view.to, view.metric],
  );

  useEffect(() => {
    if (!query) return;
    let live = true;
    setLoading(true);
    fetchCalendar(query)
      .then((cal) => {
        if (!live) return;
        setData({ months: cal.months, meta: cal.meta, kpis: summarize(cal.months) });
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

  const windowStart = windowEnd ? addDays(windowEnd, -(windowDays - 1)) : null;
  useEffect(() => {
    if (!windowEnd || !windowStart) return;
    let live = true;
    fetchPoints(windowStart, windowEnd, mapView).then((r) => live && setPoints(r)).catch(() => undefined);
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowStart, windowEnd, windowEnd === regions?.last_day ? "" : mapView?.bounds.map((v) => v.toFixed(1)).join(",")]);

  const range = regions?.data_range;
  const from = view.from ?? range?.start ?? "2022-11";
  const to = view.to ?? range?.end ?? "2025-12";
  const unitShort = view.metric === "count" ? "hotspots" : "active cell-days";
  const selLabel = view.sel && regions ? selectionLabel(view.sel, regions.regions) : "";
  const footer = data
    ? `Source: NASA FIRMS, MODIS Collection 6.1 and VIIRS 375 m active fire. Area: ${selLabel}. Pipeline run ${data.meta.pipeline_run_utc.slice(0, 10)}.`
    : "";
  const nViirs = points.points.filter((p) => p.sat !== "Terra" && p.sat !== "Aqua").length;
  const nModis = points.points.length - nViirs;

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
  const exportCsv = async (kind: "calendar" | "hotspots") => {
    if (!query) return;
    flash(kind === "hotspots" ? "Preparing hotspot file…" : "Preparing calendar file…");
    try {
      const blob = kind === "calendar" ? await calendarCsv(query, selLabel) : await hotspotsCsv(query, selLabel);
      saveBlob(blob, kind === "calendar" ? `burning_calendar_${view.metric}.csv` : "hotspots.csv");
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

  // On narrow screens the panel sits below the map, so it covers none of it.
  const stacked = typeof window !== "undefined" && window.matchMedia("(max-width: 860px)").matches;
  const panelWidth = !panelOpen || stacked ? 0 : wide ? Math.round(window.innerWidth * 0.55) : 470;

  return (
    <div className={`app${panelOpen ? "" : " panel-closed"}${wide ? " wide" : ""}`}>
      <header className="topbar">
        <button type="button" className="icon-btn" aria-label={panelOpen ? "Hide side panel" : "Show side panel"} aria-expanded={panelOpen}
          onClick={() => setPanelOpen((v) => !v)}><Icon d={ICONS.menu} size={22} /></button>
        <div className="brand">
          <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
            <rect x="1" y="1" width="30" height="30" rx="4" fill="none" stroke="currentColor" strokeWidth="2" />
            {[0, 1, 2].map((r) => [0, 1, 2, 3].map((c) => (
              <rect key={`${r}${c}`} x={6 + c * 5.5} y={8 + r * 6} width="4" height="4.4" rx="0.8"
                fill="currentColor" opacity={[0.35, 0.55, 1, 0.7, 0.45, 0.9, 1, 0.6, 0.3, 0.5, 0.8, 0.4][r * 4 + c]} />
            )))}
          </svg>
          <div>
            <div className="brand-name">Burning Calendar</div>
            <div className="brand-sub">Harmonized MODIS + VIIRS active-fire record</div>
          </div>
        </div>
        <nav className="top-links" aria-label="Site">
          <button type="button" onClick={share}><Icon d={ICONS.link} /> <span>Share link</span></button>
          <button type="button" onClick={() => setModal("methods")}><Icon d={ICONS.book} /> <span>Methods</span></button>
          <button type="button" onClick={() => setModal("about")}><Icon d={ICONS.info} /> <span>Data &amp; credits</span></button>
        </nav>
      </header>

      <div className="stage">
        <MapView
          regions={regions?.regions ?? []} sel={view.sel} cells={cells} points={points.points} layers={layers}
          basemap={basemap} imagery={imagery} imageryDate={windowEnd} drawMode={drawMode} rightInset={panelWidth}
          onDrawEnd={() => setDrawMode(null)} onDrawCount={setNVerts} onSelect={(sel) => setView({ sel })}
          onPickPoint={(lat, lon) => setPoint((p) => ({ ...p, lat: lat.toFixed(4), lon: lon.toFixed(4) }))}
          onCursor={setCursor} onView={setMapView} onClear={clearArea} finishRef={finishRef}
        />

        <div className="infobar" aria-live="off" style={{ left: `calc((100% - ${panelWidth ? panelWidth + 12 : 0}px) / 2)` }}>
          <span>{cursor ? `Lat: ${cursor.lat.toFixed(3)}°, Lon: ${cursor.lon.toFixed(3)}°` : "Lat: –, Lon: –"}</span>
          <span>HOTSPOTS: {windowEnd ? `${windowStart === windowEnd ? windowEnd : `${windowStart} to ${windowEnd}`} (${windowDays} ${windowDays === 1 ? "DAY" : "DAYS"})` : "–"}</span>
        </div>

        {drawMode && (
          <div className="draw-hint" role="status" style={{ left: `calc((100% - ${panelWidth ? panelWidth + 12 : 0}px) / 2)` }}>
            {drawMode === "rect" && "Drag on the map to draw a rectangle. Esc cancels."}
            {drawMode === "poly" && <>Click to add corners ({nVerts}). Double-click or Enter to finish. <button type="button" className="link" disabled={nVerts < 3} onClick={() => finishRef.current()}>Finish</button></>}
            {drawMode === "point" && "Click the map to place the centre, or type it in the panel."}
            <button type="button" className="link" onClick={() => setDrawMode(null)}>Cancel</button>
          </div>
        )}

        {panelOpen && (
          <aside className="panel" aria-label="Analysis panel">
            <div className="panel-head">
              <Icon d={ICONS.menu} size={22} />
              <span className="panel-title">Burning calendar</span>
              <button type="button" className="icon-btn wide-btn" aria-pressed={wide} aria-label={wide ? "Narrow panel" : "Widen panel"} title={wide ? "Narrow panel" : "Widen panel"}
                onClick={() => setWide((w) => !w)}><Icon d={ICONS.wide} /></button>
              <button type="button" className="icon-btn" aria-label="Close panel" onClick={() => setPanelOpen(false)}><Icon d={ICONS.close} /></button>
            </div>

            <div className="panel-scroll">
              <div className="time-row" role="group" aria-label="Hotspots shown on the map">
                {WINDOWS.map((w) => (
                  <button key={w.days} type="button" className="round" aria-pressed={windowDays === w.days}
                    onClick={() => setWindowDays(w.days)}>{w.label}</button>
                ))}
                <label className="round cal" title="Last day of the map window">
                  <Icon d={ICONS.cal} />
                  <input type="date" aria-label="Last day of the map window" value={windowEnd ?? ""} max={regions?.last_day ?? undefined}
                    min={regions ? `${regions.data_range.start}-01` : undefined} onChange={(e) => e.target.value && setWindowEnd(e.target.value)} />
                </label>
                <div className="time-text">
                  <strong>{windowDays} {windowDays === 1 ? "DAY" : "DAYS"}</strong>
                  <span>to {windowEnd ?? "–"} UTC{windowEnd === regions?.last_day ? " (latest data)" : ""}</span>
                </div>
              </div>

              <div className="layers">
                <LayerRow on={layers.viirs} color={POINT_COLORS.viirs} kind="dot" label={`VIIRS (S-NPP, NOAA-20, NOAA-21) [375 m] · ${fmt(nViirs)}`}
                  hint="Each dot is one VIIRS 375 m detection (nominal or high confidence) in the map window. Click a dot for details."
                  onClick={() => setLayers((l) => ({ ...l, viirs: !l.viirs }))} />
                <LayerRow on={layers.modis} color={POINT_COLORS.modis} kind="ring" label={`MODIS (Aqua & Terra) [1 km] · ${fmt(nModis)}`}
                  hint="Each ring is one MODIS 1 km detection (confidence 30 or more) in the map window."
                  onClick={() => setLayers((l) => ({ ...l, modis: !l.modis }))} />
                <LayerRow on={layers.cells} color="#f98e09" kind="grid" label={`Harmonized total per ${cells?.cell_deg === 1 ? "1°" : "0.1°"} cell (analysis period)`}
                  hint="MODIS-equivalent total over the analysis period chosen below: 1-degree cells when zoomed out, 0.1-degree cells when zoomed in."
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
                {points.truncated && <p className="small">Map shows the first 200,000 detections of this window.</p>}
                {points.zoomIn && <p className="small">Detections before the last 7 days are shown for the area on screen: zoom in to a region (about 60° across or less).</p>}
              </div>

              <Section id="area" title="Area" open={open.area} onToggle={toggle}>
                <label className="field">
                  <span>Quick areas</span>
                  <select value={view.sel?.type === "region" ? view.sel.id : ""} onChange={(e) => e.target.value && setView({ sel: { type: "region", id: e.target.value } })}>
                    <option value="" disabled>Custom area</option>
                    {regions?.regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                </label>
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
                  <p className="small">Custom area: monthly values are summed over 0.1° grid cells whose centre lies inside the shape. Hotspot downloads use the exact shape.</p>
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
                      <button type="button" aria-pressed={view.from === `${Number(range.end.slice(0, 4)) - 1}-${range.end.slice(5)}` && !view.to}
                        onClick={() => setView({ from: `${Number(range.end.slice(0, 4)) - 1}-${range.end.slice(5)}`, to: null })}>Last 12 months</button>
                    </div>
                  </>
                )}
                <label className="field">
                  <span>Metric</span>
                  <select value={view.metric} onChange={(e) => setView({ metric: e.target.value as "count" | "celldays" })}>
                    <option value="count">Hotspot count</option>
                    <option value="celldays">Active cell-days (0.05°)</option>
                  </select>
                </label>
                <div className="downloads">
                  <button type="button" className="primary" disabled={!data} onClick={() => exportCsv("calendar")}>Calendar CSV</button>
                  <button type="button" disabled={!data} onClick={() => exportCsv("hotspots")}>Hotspots CSV</button>
                  <button type="button" disabled={!data} onClick={methodsNote}>Methods note</button>
                  <button type="button" onClick={share}>Copy share link</button>
                </div>
              </Section>

              {notice && <p className="notice" role="status">{notice}</p>}
              {error && (
                <div className="message" role="alert">
                  <strong>{error.code === "empty_selection" ? "No hotspots here" : error.code === "outside_coverage" ? "Outside the available regions" : "Could not load this view"}</strong>
                  <p>{error.message}</p>
                </div>
              )}
              {!data && !error && <p className="loading">Loading…</p>}

              {data && (
                <div className={loading ? "content stale" : "content"}>
                  <Section id="kpis" title="Key figures" open={open.kpis} onToggle={toggle}>
                    <KpiStrip kpis={data.kpis} unitShort={unitShort} range={`${monthLabel(data.months[0].month)} – ${monthLabel(data.months[data.months.length - 1].month)}`} />
                  </Section>
                  <Section id="calendar" title="Burning calendar" open={open.calendar} onToggle={toggle}>
                    <Calendar months={data.months} mode={view.mode} scale={view.scale} unit={data.meta.unit} footer={footer}
                      onMode={(mode) => setView({ mode })} onScale={(scale) => setView({ scale })} />
                  </Section>
                  <Section id="charts" title="Charts" open={open.charts} onToggle={toggle}>
                    <SeasonalProfile months={data.months} unitShort={unitShort} footer={footer} />
                    <AnnualTotals months={data.months} unitShort={unitShort} footer={footer} />
                    <SensorPanel months={data.months} unitShort={unitShort} footer={footer} agg={view.agg} onAgg={(agg) => setView({ agg })} />
                  </Section>
                </div>
              )}

              <p className="panel-note">
                <strong>NOTE:</strong> Active fires / thermal anomalies. Hotspots are satellite pixel detections, not individual fires; cloud and smoke hide fires.
                {regions && ` Data: ${regions.data_range.start} to ${regions.last_day ?? regions.data_range.end}.`}
              </p>
            </div>
          </aside>
        )}
      </div>

      {modal === "methods" && (
        <Modal title="Methods" onClose={() => setModal(null)}>
          <p>Both sensors are cleaned (MODIS confidence ≥ 30; VIIRS nominal or high; vegetation fires only where the type is known) and counted per month on a shared 0.1° grid.</p>
          <p>Data: the FIRMS archive downloads supplied for this project, whole world, 13 November 2022 to 13 November 2026 (standard processing, then near-real-time for the last months).</p>
          <p>VIIRS (S-NPP, NOAA-20, NOAA-21) sees roughly three to four times more hotspots than MODIS for the same fires, because its pixels are smaller. The harmonized value converts VIIRS to MODIS-equivalent units, so the record can continue on VIIRS alone once MODIS stops. The conversion is fitted per 1° tile and calendar month where MODIS and VIIRS both observed, falling back to the 30° world block and then the whole world where data is sparse. Three methods compete (Theil–Sen log-log, quantile mapping, ratio); the one with the lowest leave-one-year-out error is used for each block.</p>
          <p>The uncertainty band is the 5th–95th percentile of those held-out errors. The sensor transparency chart compares raw MODIS, raw VIIRS and the harmonized series over the overlap.</p>
          <p>Full write-up: METHODS.md in the project repository.</p>
        </Modal>
      )}
      {modal === "about" && (
        <Modal title="Data & credits" onClose={() => setModal(null)}>
          <p>{regions?.citation}</p>
          <p>We acknowledge the use of data and imagery from LANCE FIRMS operated by NASA&apos;s Goddard Space Flight Center Earth Science Data and Information System (ESDIS) with funding provided by NASA Headquarters.</p>
          <p>Daily true-colour imagery and Blue Marble: NASA EOSDIS Global Imagery Browse Services (GIBS). Background imagery: EOxCloudless by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2024), CC BY-NC-SA 4.0. Black Marble night lights: NASA EOSDIS GIBS. Streets map and place names: data © OpenStreetMap contributors and others, rendering © EOX (maps.eox.at).</p>
          <p>This is an independent NASA Space Apps Challenge project, not an official NASA product.</p>
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

