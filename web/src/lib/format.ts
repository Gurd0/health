// Number formatting and small statistics helpers.
import type { Series } from "../types";

/** Round to one decimal (SVG coordinates). */
export const fx = (v: number) => Math.round(v * 10) / 10;

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** 12345 -> "12 345" */
export const fint = (n: number) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");

/** Seconds per km -> "5:07" */
export function fpace(s: number) {
  let m = Math.floor(s / 60), x = Math.round(s - m * 60);
  if (x === 60) { m++; x = 0; }
  return m + ":" + (x < 10 ? "0" : "") + x;
}

/** Seconds -> "1:02:03" or "2:03" */
export function fdur(s: number) {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ":" + (m < 10 ? "0" : "") : "") + m + ":" + (x < 10 ? "0" : "") + x;
}

/** Hours -> "7 h 05 m" */
export function fhm(h: number) {
  const m = Math.round(h * 60);
  return Math.floor(m / 60) + " h " + String(m % 60).padStart(2, "0") + " m";
}

/** Hours -> "7:05" */
export function fhmShort(h: number) {
  const m = Math.round(h * 60);
  return Math.floor(m / 60) + ":" + String(m % 60).padStart(2, "0");
}

/** Seconds -> "7 h 05 m" */
export function hm(s: number) {
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h + " h " + String(m).padStart(2, "0") + " m";
}

/** +3 / −3 / ±0, optionally formatting the absolute value. */
export function signed(n: number, f?: (v: number) => string) {
  return (n > 0 ? "+" : n < 0 ? "−" : "±") + (f ? f(Math.abs(n)) : Math.abs(n));
}

export const labelCase = (s: string) => (s ? s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ") : "");

/** Mean of arr[a..b] ignoring nulls; null if there are none. */
export function mean(arr: Series, a: number, b: number): number | null {
  let s = 0, c = 0;
  for (let i = Math.max(0, a); i <= b && i < arr.length; i++) {
    const v = arr[i];
    if (v != null) { s += v; c++; }
  }
  return c ? s / c : null;
}

/** Index of the last non-null value at or before upto, or -1. */
export function latest(arr: Series, upto: number) {
  for (let i = Math.min(upto, arr.length - 1); i >= 0; i--) if (arr[i] != null) return i;
  return -1;
}

export function avg(a: Series | null | undefined): number | null {
  const v = (a || []).filter((x): x is number => x != null);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}

/** q-quantile of the non-null values (0 if there are none). */
export function quantile(vals: Series, q: number) {
  const s = vals.filter((v): v is number => v != null).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0;
}

/** Round axis ticks covering lo..hi with about n steps. */
export function niceTicks(lo: number, hi: number, n: number) {
  const span = hi - lo || 1, s0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(s0))), f = s0 / mag;
  const st = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
  const a = Math.floor(lo / st) * st, b = Math.ceil(hi / st) * st, ticks: number[] = [];
  for (let v = a; v <= b + st * 1e-6; v += st) ticks.push(+v.toFixed(6));
  return { ticks, lo: a, hi: b };
}
