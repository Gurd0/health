// Labels, colours and parsing shared by the Training and Gear pages.
import type { SessionKind, SessionStatus } from "../types";
import { fpace } from "./format";

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const KINDS: { kind: SessionKind; label: string; color: string }[] = [
  { kind: "easy", label: "Easy", color: "var(--blue)" },
  { kind: "strides", label: "Easy + strides", color: "var(--blue)" },
  { kind: "recovery", label: "Recovery", color: "var(--p1)" },
  { kind: "long", label: "Long", color: "var(--aqua)" },
  { kind: "tempo", label: "Tempo", color: "var(--orange)" },
  { kind: "intervals", label: "Intervals", color: "var(--magenta)" },
  { kind: "race", label: "Race", color: "var(--yellow)" },
];
export const kindOf = (k: SessionKind) => KINDS.find(x => x.kind === k)!;

export const STATUS: Record<SessionStatus, { label: string; color: string }> = {
  done: { label: "Done", color: "var(--aqua)" },
  partial: { label: "Partly done", color: "var(--yellow)" },
  missed: { label: "Missed", color: "var(--orange)" },
  skipped: { label: "Skipped", color: "var(--muted)" },
  today: { label: "Today", color: "var(--blue)" },
  upcoming: { label: "Planned", color: "var(--grid)" },
};

export const GOALS: [number, string][] = [[5, "5 km"], [10, "10 km"], [21.1, "Half"], [42.2, "Marathon"]];

export function goalName(km: number) {
  const g = GOALS.find(([k]) => Math.abs(k - km) < 0.15);
  return g ? (g[1] === "Half" ? "half marathon" : g[1] === "Marathon" ? "marathon" : g[1]) : km + " km";
}

/** "5:30" -> 330 s; "1:02:03" -> 3723 s; anything else -> null */
export function parseTime(s: string): number | null {
  const parts = s.trim().split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some(p => !/^\d+$/.test(p))) return null;
  const n = parts.map(Number);
  if (n.slice(1).some(x => x >= 60)) return null;
  return n.reduce((a, b) => a * 60 + b, 0);
}

export const paceRange = (lo: number | null, hi: number | null) => (lo && hi ? `${fpace(lo)}–${fpace(hi)} /km` : "");

/** "2026-10-16" -> weekday index, 0 = Monday */
export const weekdayOf = (iso: string) => (new Date(iso + "T00:00:00Z").getUTCDay() + 6) % 7;

export function addDays(iso: string, n: number) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
