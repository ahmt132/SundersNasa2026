// Full-screen map: satellite basemaps, daily true-colour imagery, hotspot points, the harmonized
// grid layer, the selected area, and the drawing tools (rectangle, polygon, click-to-place point).
import {
  GeolocateControl, Map as MlMap, Marker, NavigationControl, Popup, ScaleControl, setWorkerUrl,
  type GeoJSONSource, type LngLat, type MapMouseEvent, type MapTouchEvent, type StyleSpecification,
} from "maplibre-gl";
// MapLibre 6 ships its worker as a separate file and finds it next to its own module URL.
// Bundlers move that module, so hand it the real URL of the worker file.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import type { CellsResponse, Point, RegionInfo, Selection, View } from "../api";
import { fmt, inferno, selectionRing } from "../lib";

setWorkerUrl(new URL(workerUrl, document.baseURI).href);

export type DrawMode = null | "rect" | "poly" | "point";
export type Basemap = "sentinel" | "bluemarble" | "streets" | "blackmarble";
export interface Layers { viirs: boolean; modis: boolean; cells: boolean; labels: boolean }

// Base layers. Each entry: tile URL, attribution, max native zoom.
export const BASEMAPS: Record<Basemap, { label: string; url: string; attribution: string; maxzoom: number }> = {
  sentinel: {
    label: "Sentinel-2 cloudless 2024 (10 m)",
    url: "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg",
    // CC BY-NC-SA 4.0 (non-commercial use with attribution), cloudless.eox.at/documentation/license, read 2026-11-14.
    attribution: "EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2024)",
    maxzoom: 15, // VERIFY: highest native zoom of the EOX tile service
  },
  bluemarble: {
    label: "Blue Marble",
    url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/2004-08-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg",
    attribution: "Blue Marble: NASA EOSDIS GIBS", maxzoom: 8,
  },
  streets: {
    label: "OpenStreetMap (EOX)",
    url: "https://tiles.maps.eox.at/wmts/1.0.0/osm_3857/default/g/{z}/{y}/{x}.jpg",
    attribution: "Data © OpenStreetMap contributors and others, Rendering © EOX", maxzoom: 18,
  },
  blackmarble: {
    label: "Black Marble (night lights)",
    url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png",
    attribution: "Black Marble: NASA EOSDIS GIBS", maxzoom: 8,
  },
};

// Daily corrected-reflectance (true colour) imagery from NASA GIBS. Layer names checked 2026-11-14.
const gibsUrl = (layer: string, date: string) =>
  `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`;

export const POINT_COLORS = { viirs: "#ff3b1f", modis: "#ffc21a" };

type Ring = [number, number][];
type FC = { type: "FeatureCollection"; features: object[] };
const fc = (features: object[]): FC => ({ type: "FeatureCollection", features });
const polygon = (ring: Ring, props: object = {}) => ({
  type: "Feature", properties: props, geometry: { type: "Polygon", coordinates: [[...ring, ring[0]]] },
});
const setData = (map: MlMap, id: string, data: FC) => (map.getSource(id) as GeoJSONSource | undefined)?.setData(data as never);

/** Area of a lon/lat ring on the sphere, km². */
export function ringAreaKm2(ring: Ring): number {
  const R = 6371.0088, rad = Math.PI / 180;
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length];
    s += (x2 - x1) * rad * (2 + Math.sin(y1 * rad) + Math.sin(y2 * rad));
  }
  return Math.abs((s * R * R) / 2);
}

const styleFor = (visible: Basemap): StyleSpecification => ({
  version: 8,
  sources: Object.fromEntries(Object.entries(BASEMAPS).map(([id, b]) => [
    `base-${id}`, { type: "raster", tiles: [b.url], tileSize: 256, maxzoom: b.maxzoom, attribution: b.attribution },
  ])) as StyleSpecification["sources"],
  layers: [
    { id: "bg", type: "background", paint: { "background-color": "#0b0c0e" } },
    ...Object.keys(BASEMAPS).map((id) => ({
      id: `base-${id}`, type: "raster" as const, source: `base-${id}`,
      layout: { visibility: id === visible ? ("visible" as const) : ("none" as const) },
    })),
  ],
});

interface Props {
  regions: RegionInfo[];
  sel: Selection | null;
  cells: CellsResponse | null;
  points: Point[];
  layers: Layers;
  basemap: Basemap;
  imagery: string | null;
  imageryDate: string | null;
  drawMode: DrawMode;
  onDrawEnd: () => void;
  onDrawCount: (n: number) => void;
  onSelect: (sel: Selection) => void;
  onPickPoint: (lat: number, lon: number) => void;
  onCursor: (pos: { lat: number; lon: number } | null) => void;
  onView: (view: View) => void;
  onClear: () => void;
  finishRef: { current: () => void };
  /** Filled in by the map: call it to zoom to the selected area again. */
  fitAreaRef?: { current: () => void };
  /** While true, report once the map has drawn the current points and finished loading (loading screen). */
  awaitDrawn?: boolean;
  onDrawn?: () => void;
}

export function MapView(p: Props) {
  const container = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(false);
  const modeRef = useRef<DrawMode>(null);
  const draft = useRef<Ring>([]);
  const dragStart = useRef<LngLat | null>(null);
  const props = useRef(p);
  props.current = p;
  const fitRef = useRef<() => void>(() => undefined);
  const areaMarker = useRef<Marker | null>(null);

  // ---- drawing mode follows the prop
  useEffect(() => {
    modeRef.current = p.drawMode;
    draft.current = [];
    dragStart.current = null;
    const map = mapRef.current;
    if (!map) return;
    setData(map, "draft", fc([]));
    map.getCanvas().style.cursor = p.drawMode ? "crosshair" : "";
    if (p.drawMode) map.doubleClickZoom.disable();
    else map.doubleClickZoom.enable();
  }, [p.drawMode, ready]);

  useEffect(() => {
    if (!container.current) return;
    const stacked = window.matchMedia("(max-width: 860px)").matches;
    const map = new MlMap({
      container: container.current, style: styleFor(props.current.basemap), center: [20, 15], zoom: 1.6,
      attributionControl: { compact: true }, cooperativeGestures: stacked,
    });
    mapRef.current = map;
    map.addControl(new NavigationControl({ showCompass: false }), "top-left");
    map.addControl(new GeolocateControl({ positionOptions: { enableHighAccuracy: false } }), "top-left");
    map.addControl(new ScaleControl({ unit: "metric", maxWidth: 130 }), "bottom-left");
    map.addControl(new ScaleControl({ unit: "imperial", maxWidth: 130 }), "bottom-left");

    map.on("load", () => {
      performance.mark("map-load");
      map.addSource("imagery", { type: "raster", tiles: [gibsUrl("VIIRS_NOAA20_CorrectedReflectance_TrueColor", "2025-01-01")], tileSize: 256, maxzoom: 9, attribution: "Imagery: NASA EOSDIS GIBS" });
      map.addLayer({ id: "imagery", type: "raster", source: "imagery", layout: { visibility: "none" } });
      map.addSource("labels", { type: "raster", tiles: ["https://tiles.maps.eox.at/wmts/1.0.0/overlay_bright_3857/default/g/{z}/{y}/{x}.png"], tileSize: 256, attribution: "Overlay: Data © OpenStreetMap contributors and others, Rendering © EOX" });
      for (const id of ["cells", "selection", "draft", "points"]) map.addSource(id, { type: "geojson", data: fc([]) as never });
      map.addLayer({ id: "cells", type: "fill", source: "cells", paint: { "fill-color": ["get", "color"], "fill-opacity": 0.62, "fill-antialias": false } });
      map.addLayer({ id: "labels", type: "raster", source: "labels" });
      map.addLayer({ id: "selection-fill", type: "fill", source: "selection", paint: { "fill-color": "#ffffff", "fill-opacity": 0.16 } });
      map.addLayer({ id: "selection-line", type: "line", source: "selection", paint: { "line-color": "#ffffff", "line-width": 1.6, "line-dasharray": [3, 2] } });
      map.addLayer({ id: "draft-line", type: "line", source: "draft", paint: { "line-color": "#ffffff", "line-width": 1.5, "line-dasharray": [2, 2] } });
      map.addLayer({ id: "draft-pts", type: "circle", source: "draft", filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 4, "circle-color": "#ffffff", "circle-stroke-color": "#000", "circle-stroke-width": 1.5 } });
      // MODIS: larger hollow squares-ish rings; VIIRS: smaller filled dots. Shape differs, not only colour.
      map.addLayer({ id: "points-modis", type: "circle", source: "points", filter: ["==", ["get", "s"], "MODIS"],
        paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 2.5, 8, 5, 12, 8], "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": POINT_COLORS.modis, "circle-stroke-width": 1.6 } });
      map.addLayer({ id: "points-viirs", type: "circle", source: "points", filter: ["==", ["get", "s"], "VIIRS"],
        paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 1.6, 8, 3.2, 12, 5], "circle-color": POINT_COLORS.viirs,
          "circle-stroke-color": "#3a0900", "circle-stroke-width": 0.6 } });
      setReady(true);
      report();
    });
    // tell the app what is on screen, so it loads detail only for the visible world blocks
    let viewTimer = 0;
    const report = () => {
      const b = map.getBounds();
      const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
      props.current.onView({
        bounds: [clamp(b.getWest(), -180, 180), clamp(b.getSouth(), -90, 90), clamp(b.getEast(), -180, 180), clamp(b.getNorth(), -90, 90)],
        zoom: map.getZoom(),
      });
    };
    map.on("moveend", () => {
      window.clearTimeout(viewTimer);
      viewTimer = window.setTimeout(report, 250);
    });

    const popup = new Popup({ closeButton: true, maxWidth: "260px", className: "hotspot-popup" });
    for (const layer of ["points-viirs", "points-modis"]) {
      map.on("click", layer, (e) => {
        if (modeRef.current) return;
        const f = e.features?.[0];
        if (!f) return;
        const q = f.properties as Record<string, string | number>;
        const el = document.createElement("div");
        const rows: [string, string][] = [
          ["Satellite", String(q.sat)], ["Date (UTC)", `${q.date} ${String(q.time).slice(0, 2)}:${String(q.time).slice(2)}`],
          ["FRP", `${Number(q.frp).toFixed(1)} MW`], ["Confidence", String(q.conf)],
          ["Position", `${Number(q.lat).toFixed(4)}°, ${Number(q.lon).toFixed(4)}°`],
        ];
        rows.forEach(([k, v]) => {
          const row = document.createElement("div");
          const a = document.createElement("span"), b = document.createElement("strong");
          a.textContent = k;
          b.textContent = v;
          row.append(a, b);
          el.append(row);
        });
        popup.setLngLat(e.lngLat).setDOMContent(el).addTo(map);
      });
      map.on("mouseenter", layer, () => !modeRef.current && (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", layer, () => !modeRef.current && (map.getCanvas().style.cursor = ""));
    }

    const rectRing = (a: LngLat, b: LngLat): Ring => {
      const [w, e] = [Math.min(a.lng, b.lng), Math.max(a.lng, b.lng)];
      const [s, n] = [Math.min(a.lat, b.lat), Math.max(a.lat, b.lat)];
      return [[w, s], [e, s], [e, n], [w, n]];
    };
    const down = (e: MapMouseEvent | MapTouchEvent) => {
      if (modeRef.current !== "rect") return;
      e.preventDefault();
      dragStart.current = e.lngLat;
    };
    const move = (e: MapMouseEvent | MapTouchEvent) => {
      props.current.onCursor({ lat: e.lngLat.lat, lon: e.lngLat.lng });
      if (modeRef.current === "rect" && dragStart.current) {
        setData(map, "draft", fc([polygon(rectRing(dragStart.current, e.lngLat))]));
      } else if (modeRef.current === "poly" && draft.current.length) {
        const pts = [...draft.current, [e.lngLat.lng, e.lngLat.lat] as [number, number]];
        setData(map, "draft", fc([
          { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: pts } },
          ...draft.current.map((c) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: c } })),
        ]));
      }
    };
    const up = (e: MapMouseEvent | MapTouchEvent) => {
      if (modeRef.current !== "rect" || !dragStart.current) return;
      const ring = rectRing(dragStart.current, e.lngLat);
      dragStart.current = null;
      const [w, s] = ring[0], [east, n] = ring[2];
      if (east - w > 1e-3 && n - s > 1e-3) {
        props.current.onSelect({ type: "bbox", bbox: [w, s, east, n] });
        props.current.onDrawEnd();
      } else setData(map, "draft", fc([]));
    };
    const click = (e: MapMouseEvent) => {
      if (modeRef.current === "point") {
        props.current.onPickPoint(e.lngLat.lat, e.lngLat.lng);
        return;
      }
      if (modeRef.current !== "poly") return;
      draft.current = [...draft.current, [e.lngLat.lng, e.lngLat.lat]];
      props.current.onDrawCount(draft.current.length);
      move(e);
    };
    const finish = () => {
      const ring = draft.current.filter((c, i, a) => i === 0 || Math.hypot(c[0] - a[i - 1][0], c[1] - a[i - 1][1]) > 1e-6);
      if (ring.length >= 3) props.current.onSelect({ type: "polygon", ring });
      props.current.onDrawEnd();
    };
    props.current.finishRef.current = finish;
    if (props.current.fitAreaRef) props.current.fitAreaRef.current = () => fitRef.current();
    const dbl = (e: MapMouseEvent) => {
      if (modeRef.current !== "poly") return;
      e.preventDefault();
      finish();
    };
    map.on("mousedown", down);
    map.on("mousemove", move);
    map.on("mouseup", up);
    map.on("touchstart", down);
    map.on("touchmove", move);
    map.on("touchend", up);
    map.on("click", click);
    map.on("dblclick", dbl);
    map.getCanvasContainer().addEventListener("mouseleave", () => props.current.onCursor(null));

    const key = (e: KeyboardEvent) => {
      if (!modeRef.current) return;
      if (e.key === "Escape") props.current.onDrawEnd();
      if (e.key === "Enter" && modeRef.current === "poly") finish();
    };
    window.addEventListener("keydown", key);
    let timer = 0;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        // resize() re-sets the canvas size, which wipes the WebGL drawing buffer; without a
        // redraw the map stays black until the user moves it.
        map.resize();
        map.triggerRepaint();
        fitRef.current();
      }, 150);
    });
    ro.observe(container.current);
    return () => {
      ro.disconnect();
      window.clearTimeout(timer);
      window.removeEventListener("keydown", key);
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- base layer, imagery, labels
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    for (const id of Object.keys(BASEMAPS)) map.setLayoutProperty(`base-${id}`, "visibility", id === p.basemap ? "visible" : "none");
  }, [ready, p.basemap]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    if (!p.imagery || !p.imageryDate) {
      map.setLayoutProperty("imagery", "visibility", "none");
      return;
    }
    (map.getSource("imagery") as unknown as { setTiles: (t: string[]) => void }).setTiles([gibsUrl(p.imagery, p.imageryDate)]);
    map.setLayoutProperty("imagery", "visibility", "visible");
  }, [ready, p.imagery, p.imageryDate]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const vis = (on: boolean) => (on ? "visible" : "none");
    map.setLayoutProperty("labels", "visibility", vis(p.layers.labels));
    map.setLayoutProperty("cells", "visibility", vis(p.layers.cells));
    map.setLayoutProperty("points-viirs", "visibility", vis(p.layers.viirs));
    map.setLayoutProperty("points-modis", "visibility", vis(p.layers.modis));
  }, [ready, p.layers]);

  // ---- data layers
  const cellMax = p.cells?.value.length ? p.cells.value.reduce((a, b) => Math.max(a, b), 0) : 0;
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    if (!p.cells) return void setData(map, "cells", fc([]));
    const d = p.cells.cell_deg, denom = Math.log1p(cellMax) || 1, c = p.cells;
    setData(map, "cells", fc(c.value.map((v, i) => {
      const w = c.west[i], s = c.south[i];
      return polygon([[w, s], [w + d, s], [w + d, s + d], [w, s + d]], { color: inferno(Math.log1p(v) / denom) });
    })));
  }, [ready, p.cells, cellMax]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    setData(map, "points", fc(p.points.map((q) => ({
      type: "Feature",
      properties: { s: q.sat === "Terra" || q.sat === "Aqua" ? "MODIS" : "VIIRS", sat: q.sat, date: q.date, time: q.time, frp: q.frp, conf: q.conf, lat: q.lat, lon: q.lon },
      geometry: { type: "Point", coordinates: [q.lon, q.lat] },
    }))));
  }, [ready, p.points]);

  // Report once the points set by the effect above are processed and on screen. This waits for
  // the "points" source itself, not for the whole map: map.loaded()/"idle" also wait on hidden
  // raster sources and do not fire reliably here. Two animation frames = drawn at least once.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !p.awaitDrawn) return;
    let raf = 0, cancelled = false;
    const done = () => {
      raf = requestAnimationFrame(() => { raf = requestAnimationFrame(() => !cancelled && props.current.onDrawn?.()); });
    };
    const onData = (e: { sourceId?: string; isSourceLoaded?: boolean }) => {
      if (e.sourceId === "points" && e.isSourceLoaded) { map.off("sourcedata", onData); done(); }
    };
    let loaded = false;
    try { loaded = map.isSourceLoaded("points"); } catch { loaded = false; }
    if (loaded) done();
    else map.on("sourcedata", onData);
    return () => { cancelled = true; cancelAnimationFrame(raf); map.off("sourcedata", onData); };
  }, [ready, p.awaitDrawn, p.points]);

  // ---- selection outline, area label, fit
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const full = selectionRing(p.sel ?? { type: "region", id: "world" }, p.regions);
    // the whole world is the "nothing selected" state: no outline, no label
    const isWorld = !!full && full[0][0] <= -180 && full[2][0] >= 180 && full[0][1] <= -90 && full[2][1] >= 90 && full.length === 4;
    const ring = p.sel && !isWorld ? full : null;
    setData(map, "selection", fc(ring ? [polygon(ring)] : []));
    areaMarker.current?.remove();
    areaMarker.current = null;
    if (ring) {
      // label the top-left corner, like a measuring tool, so it stays clear of the side panel
      const top = ring.reduce((a, b) => (b[1] > a[1] + 1e-9 || (Math.abs(b[1] - a[1]) <= 1e-9 && b[0] < a[0]) ? b : a));
      const el = document.createElement("div");
      el.className = "area-label";
      const text = document.createElement("span");
      text.textContent = `${fmt(Math.round(ringAreaKm2(ring) * 100) / 100)} km²`;
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "area-clear";
      clear.textContent = "×";
      clear.title = "Clear this area";
      clear.setAttribute("aria-label", "Clear this area");
      clear.addEventListener("click", (e) => {
        e.stopPropagation();
        props.current.onClear();
      });
      el.append(text, clear);
      areaMarker.current = new Marker({ element: el, anchor: "bottom-left", offset: [6, -4] }).setLngLat(top).addTo(map);
    }
    fitRef.current = () => {
      if (!ring) return;
      const lons = ring.map((c) => c[0]), lats = ring.map((c) => c[1]);
      map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
        { padding: { top: 70, bottom: 60, left: 70, right: 70 }, maxZoom: 11, duration: 500 });
    };
    fitRef.current();
  }, [ready, p.sel, p.regions]);

  return (
    <div className="map-wrap">
      <div ref={container} className="map" role="application"
        aria-label="Map. Choose an area with the tools in the side panel; every tool also works from the keyboard there." />
      {p.layers.cells && p.cells && cellMax > 0 && (
        <div className="map-legend">
          <span>Harmonized total per {p.cells.cell_deg === 1 ? "1°" : "0.1°"} cell, {p.cells.start} to {p.cells.end}</span>
          <div className="ramp" style={{ background: `linear-gradient(90deg, ${Array.from({ length: 9 }, (_, i) => inferno(i / 8)).join(",")})` }} />
          <div className="ramp-labels"><span>&gt;0</span><span>log scale</span><span>{fmt(cellMax)}</span></div>
        </div>
      )}
    </div>
  );
}
