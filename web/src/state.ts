// View state lives in the URL query string, so any view can be shared as a link.
//   sel=region:turkiye_med | bbox:w,s,e,n | circle:lat,lon,km | poly:lon,lat;lon,lat;...
//   from=YYYY-MM  to=YYYY-MM  mode=value|anomaly  scale=log|quantile  metric=count|celldays  agg=month|year
import { useCallback, useEffect, useState } from "react";
import type { Metric, Selection } from "./api";

export interface ViewState {
  sel: Selection | null;
  from: string | null;
  to: string | null;
  mode: "value" | "anomaly";
  scale: "log" | "quantile";
  metric: Metric;
  agg: "month" | "year";
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const isMonth = (s: string | null): s is string => !!s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

function parseSel(text: string | null): Selection | null {
  if (!text) return null;
  const [kind, rest = ""] = [text.slice(0, text.indexOf(":")), text.slice(text.indexOf(":") + 1)];
  const nums = rest.split(/[,;]/).map(Number);
  if (kind === "region" && rest) return { type: "region", id: rest };
  if (nums.some((n) => !Number.isFinite(n))) return null;
  if (kind === "bbox" && nums.length === 4) return { type: "bbox", bbox: nums as [number, number, number, number] };
  if (kind === "circle" && nums.length === 3) return { type: "circle", lat: nums[0], lon: nums[1], radius_km: nums[2] };
  if (kind === "poly" && nums.length >= 6 && nums.length % 2 === 0) {
    const ring: [number, number][] = [];
    for (let i = 0; i < nums.length; i += 2) ring.push([nums[i], nums[i + 1]]);
    return { type: "polygon", ring };
  }
  return null;
}

function formatSel(sel: Selection): string {
  switch (sel.type) {
    case "region":
      return `region:${sel.id}`;
    case "bbox":
      return `bbox:${sel.bbox.map(r4).join(",")}`;
    case "circle":
      return `circle:${r4(sel.lat)},${r4(sel.lon)},${r4(sel.radius_km)}`;
    case "polygon":
      return `poly:${sel.ring.map(([x, y]) => `${r4(x)},${r4(y)}`).join(";")}`;
  }
}

export function parseState(search: string): ViewState {
  const p = new URLSearchParams(search);
  return {
    sel: parseSel(p.get("sel")),
    from: isMonth(p.get("from")) ? p.get("from") : null,
    to: isMonth(p.get("to")) ? p.get("to") : null,
    mode: p.get("mode") === "anomaly" ? "anomaly" : "value",
    scale: p.get("scale") === "quantile" ? "quantile" : "log",
    metric: p.get("metric") === "celldays" ? "celldays" : "count",
    agg: p.get("agg") === "year" ? "year" : "month",
  };
}

export function formatState(s: ViewState): string {
  const p = new URLSearchParams();
  if (s.sel) p.set("sel", formatSel(s.sel));
  if (s.from) p.set("from", s.from);
  if (s.to) p.set("to", s.to);
  if (s.mode !== "value") p.set("mode", s.mode);
  if (s.scale !== "log") p.set("scale", s.scale);
  if (s.metric !== "count") p.set("metric", s.metric);
  if (s.agg !== "month") p.set("agg", s.agg);
  // Keep the separators readable in the address bar.
  return p.toString().replace(/%3A/g, ":").replace(/%2C/g, ",").replace(/%3B/g, ";");
}

export function useViewState(): [ViewState, (patch: Partial<ViewState>) => void] {
  const [state, setState] = useState<ViewState>(() => parseState(window.location.search));

  const update = useCallback((patch: Partial<ViewState>) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      const qs = formatState(next);
      window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
      return next;
    });
  }, []);

  useEffect(() => {
    const onPop = () => setState(parseState(window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  return [state, update];
}
