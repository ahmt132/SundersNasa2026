// Drives the loading screen that index.html shows before the app starts (#boot). The bar follows
// the real bytes downloaded (see onLoadProgress in api.ts); the screen fades out once the first
// view is complete - data loaded and the map drawn - so the site does not appear piece by piece.
import { useEffect, useRef } from "react";
import { onLoadProgress } from "../api";

interface Props {
  stage: string; // what is happening now, shown under the bar
  done: boolean;
}

export function BootScreen({ stage, done }: Props) {
  const shown = useRef(3); // percent; never moves backwards

  useEffect(() => {
    const root = document.getElementById("boot");
    if (!root || done) return;
    const fill = root.querySelector<HTMLElement>(".boot-fill");
    const status = root.querySelector<HTMLElement>(".boot-status");
    return onLoadProgress((p) => {
      // Downloads fill the bar to 95%; the last 5% is drawing the map.
      const pct = p.expected > 0 ? Math.min(95, Math.max(3, (p.received / p.expected) * 95)) : 3;
      shown.current = Math.max(shown.current, pct);
      if (fill) fill.style.width = `${shown.current.toFixed(1)}%`;
      if (status) status.textContent = `${stage}… ${Math.round(shown.current)}%`;
    });
  }, [stage, done]);

  useEffect(() => {
    if (!done) return;
    const root = document.getElementById("boot");
    if (!root) return;
    const fill = root.querySelector<HTMLElement>(".boot-fill");
    const status = root.querySelector<HTMLElement>(".boot-status");
    if (fill) fill.style.width = "100%";
    if (status) status.textContent = "Ready";
    root.setAttribute("aria-busy", "false");
    const fade = window.setTimeout(() => root.classList.add("done"), 150);
    const remove = window.setTimeout(() => root.remove(), 700);
    return () => { window.clearTimeout(fade); window.clearTimeout(remove); };
  }, [done]);

  return null;
}
