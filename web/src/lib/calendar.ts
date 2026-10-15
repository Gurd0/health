// Days are integers: the number of days since meta.t0 (UTC). Every daily series is indexed this way.
import type { Meta } from "../types";

export const DAY = 864e5;
export const MON = ["jan.", "feb.", "mars", "apr.", "mai", "juni", "juli", "aug.", "sep.", "okt.", "nov.", "des."];
const WDN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export class Calendar {
  readonly t0: number;
  readonly today: number;
  /** Yesterday: the last complete day. */
  readonly last: number;

  constructor(meta: Meta) {
    this.t0 = Date.parse(meta.t0 + "T00:00:00Z");
    this.today = this.day(meta.today);
    this.last = this.today - 1;
  }

  /** "2026-10-15" (or a longer ISO string) -> day index */
  day(iso: string) {
    return this.dayOfTime(Date.parse(iso.slice(0, 10) + "T00:00:00Z"));
  }

  /** UTC milliseconds at midnight -> day index */
  dayOfTime(ms: number) {
    return Math.round((ms - this.t0) / DAY);
  }

  date(i: number) {
    return new Date(this.t0 + i * DAY);
  }

  /** "15. okt." or "15. okt. 2026" */
  fd(i: number, year = false) {
    const x = this.date(i);
    return x.getUTCDate() + ". " + MON[x.getUTCMonth()] + (year ? " " + x.getUTCFullYear() : "");
  }

  /** "Thu 15. okt." */
  fdw(i: number, year = false) {
    return WDN[this.date(i).getUTCDay()] + " " + this.fd(i, year);
  }

  /** The Monday on or before day i. */
  monday(i: number) {
    while (this.date(i).getUTCDay() !== 1) i--;
    return i;
  }
}

/** Local date-time -> "15. okt. 20:49" */
export function fdt(iso: string | null) {
  if (!iso) return "";
  const x = new Date(iso);
  return x.getDate() + ". " + MON[x.getMonth()] + " " + String(x.getHours()).padStart(2, "0") + ":" + String(x.getMinutes()).padStart(2, "0");
}
