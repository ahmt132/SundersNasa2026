// Shared chart chrome: responsive width, tooltip, card frame with SVG/PNG export.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { saveBlob } from "./api";
import { T } from "./lib";

export function useWidth<E extends HTMLElement>(): [RefObject<E | null>, number] {
  const ref = useRef<E | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

export interface Tip {
  x: number; // px from the left of the chart body
  y: number; // px from the top of the chart body
  content: ReactNode;
}

/** Positioned inside a `position: relative` chart body; flips to stay inside it. */
export function Tooltip({ tip, width }: { tip: Tip | null; width: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 220, h: 80 });
  useEffect(() => {
    if (ref.current) setSize({ w: ref.current.offsetWidth, h: ref.current.offsetHeight });
  }, [tip]);
  if (!tip) return null;
  const left = Math.max(0, Math.min(width - size.w, tip.x + 14 + size.w > width ? tip.x - size.w - 14 : tip.x + 14));
  const top = Math.max(0, tip.y - size.h - 8 < 0 ? tip.y + 16 : tip.y - size.h - 8);
  return (
    <div ref={ref} className="tooltip" role="status" style={{ left, top }}>
      {tip.content}
    </div>
  );
}

export function TipRow({ color, dash, label, value }: { color?: string; dash?: string; label: string; value: string }) {
  return (
    <div className="tip-row">
      <span className="tip-key">
        {color && (
          <svg width="14" height="8" aria-hidden="true">
            <line x1="0" y1="4" x2="14" y2="4" stroke={color} strokeWidth="2" strokeDasharray={dash} />
          </svg>
        )}
        {label}
      </span>
      <strong>{value}</strong>
    </div>
  );
}

// ---------------------------------------------------------------- export

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function wrap(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && (line + " " + word).length > maxChars) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

/** Wrap the on-screen chart SVG with its title, subtitle and source line so the file stands alone. */
function composeSvg(svg: SVGSVGElement, title: string, subtitle: string, footer: string): { text: string; w: number; h: number } {
  const box = svg.getBoundingClientRect();
  const pad = 16;
  const w = Math.round(box.width) + pad * 2;
  const sub = wrap(subtitle, Math.floor(box.width / 6.1));
  const foot = wrap(footer, Math.floor(box.width / 5.4));
  const top = pad + 18 + sub.length * 15 + 10;
  const h = Math.round(top + box.height + 12 + foot.length * 13 + pad - 4);
  const inner = svg.cloneNode(true) as SVGSVGElement;
  inner.setAttribute("x", String(pad));
  inner.setAttribute("y", String(top));
  inner.setAttribute("width", String(box.width));
  inner.setAttribute("height", String(box.height));
  inner.removeAttribute("style");
  inner.removeAttribute("class");
  const body = new XMLSerializer().serializeToString(inner);
  const text =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="${w}" height="${h}" fill="${T.surface}"/>` +
    `<text x="${pad}" y="${pad + 12}" font-family="${T.sans}" font-size="14" font-weight="600" fill="${T.ink}">${esc(title)}</text>` +
    sub.map((l, i) => `<text x="${pad}" y="${pad + 31 + i * 15}" font-family="${T.sans}" font-size="11" fill="${T.ink2}">${esc(l)}</text>`).join("") +
    body +
    foot.map((l, i) => `<text x="${pad}" y="${top + box.height + 22 + i * 13}" font-family="${T.sans}" font-size="10" fill="${T.ink3}">${esc(l)}</text>`).join("") +
    `</svg>`;
  return { text, w, h };
}

async function exportChart(svg: SVGSVGElement, kind: "svg" | "png", name: string, title: string, subtitle: string, footer: string) {
  const { text, w, h } = composeSvg(svg, title, subtitle, footer);
  const blob = new Blob([text], { type: "image/svg+xml;charset=utf-8" });
  if (kind === "svg") return saveBlob(blob, `${name}.svg`);
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("could not rasterize the chart"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = w * 2;
    canvas.height = h * 2;
    canvas.getContext("2d")!.drawImage(img, 0, 0, w * 2, h * 2);
    const png = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    if (png) saveBlob(png, `${name}.png`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------- frame

interface FrameProps {
  title: string;
  subtitle: string;
  footer: string;
  exportName: string;
  svgRef: RefObject<SVGSVGElement | null>;
  controls?: ReactNode;
  children: ReactNode;
  hero?: boolean;
}

export function ChartFrame({ title, subtitle, footer, exportName, svgRef, controls, children, hero }: FrameProps) {
  const save = (kind: "svg" | "png") => {
    if (svgRef.current) void exportChart(svgRef.current, kind, exportName, title, subtitle, footer);
  };
  return (
    <section className={hero ? "card card-hero" : "card"} aria-label={title}>
      <header className="card-head">
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
        <div className="card-tools">
          {controls}
          <div className="seg" role="group" aria-label={`Export ${title}`}>
            <button type="button" onClick={() => save("png")}>PNG</button>
            <button type="button" onClick={() => save("svg")}>SVG</button>
          </div>
        </div>
      </header>
      {children}
      <p className="card-foot">{footer}</p>
    </section>
  );
}

export function Segmented<V extends string>({ label, value, options, onChange }: {
  label: string;
  value: V;
  options: { value: V; label: string }[];
  onChange: (v: V) => void;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Legend entry drawn inside the SVG so it survives export. Returns the width it used. */
export function LegendItem({ x, y, color, dash, label, kind = "line" }: {
  x: number; y: number; color: string; dash?: string; label: string; kind?: "line" | "rect" | "band";
}) {
  return (
    <g transform={`translate(${x},${y})`}>
      {kind === "line" && <line x1={0} y1={0} x2={18} y2={0} stroke={color} strokeWidth={2} strokeDasharray={dash} strokeLinecap="round" />}
      {kind === "rect" && <rect x={3} y={-5} width={10} height={10} rx={2} fill={color} />}
      {kind === "band" && <rect x={0} y={-5} width={18} height={10} fill={color} opacity={0.22} />}
      <text x={24} y={3.5} fontFamily={T.sans} fontSize={11} fill={T.ink2}>{label}</text>
    </g>
  );
}
export const legendWidth = (label: string) => 24 + label.length * 6.1 + 18;
