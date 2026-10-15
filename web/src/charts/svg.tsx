// Building blocks shared by the SVG charts.
import type { KeyboardEvent, MouseEvent } from "react";
import { clamp, fx } from "../lib/format";

/** SVG path for a bar from base up to top, with rounded top corners. */
export function roundedBar(x0: number, width: number, top: number, base: number, radius: number) {
  const x1 = x0 + width, yt = Math.min(top, base - 1), r = Math.min(radius, base - yt);
  return `M${fx(x0)} ${fx(base)}V${fx(yt + r)}Q${fx(x0)} ${fx(yt)} ${fx(x0 + r)} ${fx(yt)}`
    + `H${fx(x1 - r)}Q${fx(x1)} ${fx(yt)} ${fx(x1)} ${fx(yt + r)}V${fx(base)}Z`;
}

/** SVG path through the points (no gaps). */
export const polyline = (pts: [number, number][]) => pts.map((p, i) => (i ? "L" : "M") + fx(p[0]) + " " + fx(p[1])).join("");

/** A horizontal gridline with its label on the left. */
export function GridLine({ x1, x2, y, label }: { x1: number; x2: number; y: number; label: string }) {
  return (
    <>
      <line x1={x1} x2={x2} y1={fx(y)} y2={fx(y)} style={{ stroke: "var(--grid)", strokeWidth: 1 }} />
      <text x={x1 - 6} y={fx(y + 3.5)} style={{ fontSize: 11, fill: "var(--muted)", textAnchor: "end" }}>{label}</text>
    </>
  );
}

/** Dashed vertical hover line. */
export function HoverLine({ x, y1, y2 }: { x: number; y1: number; y2: number }) {
  return <line x1={fx(x)} x2={fx(x)} y1={y1} y2={fx(y2)} style={{ stroke: "var(--text2)", strokeWidth: 1, strokeDasharray: "3 3" }} />;
}

/** Tooltip box with a bold value and a muted label, placed right of x, or left if it doesn't fit in width W. */
export function TipBox({ x, y, gap, W, value, label }: { x: number; y: number; gap: number; W: number; value: string; label: string }) {
  const w = Math.round(Math.max(value.length * 6.9, label.length * 6.1) + 20);
  const bx = x + gap + w <= W ? x + gap : Math.max(0, x - gap - w);
  return (
    <>
      <rect x={fx(bx)} y={y} width={w} height={38} rx={6} style={{ fill: "var(--tipbg)", stroke: "var(--border)", strokeWidth: 1 }} />
      <text x={fx(bx + 10)} y={y + 16} style={{ fontSize: 12, fontWeight: 600, fill: "var(--text)" }}>{value}</text>
      <text x={fx(bx + 10)} y={y + 31} style={{ fontSize: 11, fill: "var(--muted)" }}>{label}</text>
    </>
  );
}

/**
 * Mouse and keyboard scrubbing for a chart: the pointer's x (in viewBox units, W wide) picks an index;
 * arrow keys step by one (Shift + arrow by bigStep), Home/End jump to the ends.
 */
export function scrub(opts: {
  W: number;
  n: number;
  index: number;
  toIndex: (x: number) => number;
  onIndex: (i: number) => void;
  bigStep?: number;
}) {
  const { W, n, index, toIndex, onIndex, bigStep } = opts;
  return {
    tabIndex: 0,
    onMouseMove(e: MouseEvent<SVGSVGElement>) {
      const rc = e.currentTarget.getBoundingClientRect();
      if (!rc.width) return;
      const i = toIndex(((e.clientX - rc.left) / rc.width) * W);
      if (i !== index) onIndex(i);
    },
    onKeyDown(e: KeyboardEvent<SVGSVGElement>) {
      let i = index;
      const step = e.shiftKey && bigStep ? bigStep : 1;
      if (e.key === "ArrowLeft") i -= step;
      else if (e.key === "ArrowRight") i += step;
      else if (e.key === "Home") i = 0;
      else if (e.key === "End") i = n - 1;
      else return;
      e.preventDefault();
      onIndex(clamp(i, 0, n - 1));
    },
  };
}
