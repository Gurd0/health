// Shapes of the server's JSON (ingest/dashboard.py collect() and ingest/runs.py).

/** One value per day (or null), indexed by days since meta.t0. */
export type Series = (number | null)[];

export interface Meta {
  generated: string;
  lastSync: string | null;
  t0: string; // first day of every daily series (YYYY-MM-DD)
  today: string;
}

export type DailyKey =
  | "steps" // steps per day
  | "slH" // hours asleep (main sleep, dated by wake-up day)
  | "slS" // sleep score
  | "rhr" // resting heart rate
  | "hrv" // heart rate variability, ms
  | "spo2" // blood oxygen, %
  | "vo2" // VO2 max estimate
  | "wt" // weight, kg
  | "load" // cardio load
  | "runKm"; // km run that day

/** GET api/data */
export interface DashboardData {
  meta: Meta;
  daily: Record<DailyKey, Series>;
  runs: RunSummary[];
}

export type Point = [number, number];

export interface RunSummary {
  id: string;
  src: "watch" | "fit";
  type: "Outdoor" | "Treadmill";
  start: string; // local time, YYYY-MM-DDTHH:MM
  date: string; // local date
  dist: number; // km
  dur: number; // moving time, s
  elapsed: number; // s
  pace: number; // s per km
  hr: number | null;
  maxHr: number | null;
  elev: number | null; // m gained
  load: number | null;
  cal: number | null;
  steps: number | null;
  cad: number | null;
  vo2: number | null;
  best1k: number | null; // s
  best5k: number | null;
  best10k: number | null;
  gps: boolean;
  route: Point[] | null; // thumbnail path in a 56x40 box
  hasSeries: boolean;
  hasForm: boolean;
  zoneSecs: number[] | null; // seconds in light, moderate, vigorous, peak
}

export interface Split {
  len: number; // km (last split may be partial)
  pace: number; // s per km
  elev: number | null;
  a: number; // start, s into the run
  b: number; // end
}

export interface RunContext {
  vo2Daily: number | null;
  sleepH: number | null;
  sleepScore: number | null;
  hrv: number | null;
  hrv30: number | null;
  rhr: number | null;
  rhr30: number | null;
  weekLoad: number | null;
  monday: string | null;
  acwr: number | null; // acute : chronic workload ratio
  acwrLabel: string | null;
}

/** GET api/runs/<id>. The per-sample arrays all have n entries, step seconds apart. */
export interface RunDetail {
  id: string;
  step: number;
  n: number;
  zones: number[] | null; // heart-rate zone thresholds: [min, moderate, vigorous, peak, max]
  zoneSecs: number[] | null; // seconds in each of the four zones
  azm: number | null; // active zone minutes
  splits: Split[];
  context: RunContext | null;
  formAvg: Record<string, number | null> | null;
  d?: Series; // distance, m
  sp?: Series; // speed, m/s
  hr?: Series;
  cg?: Series | null; // cumulative elevation gain, m
  cad?: Series;
  stride?: Series;
  gct?: Series;
  vo?: Series;
  vr?: Series;
  route?: Point[]; // projected metres, one point per sample when the run has series
  kms?: [number, number, number][]; // km markers: x, y, km number
}

/** GET api/status */
export interface SyncStatus {
  auth: "ok" | "reconnect_needed" | "unknown";
  auth_error: string | null;
  last: {
    trigger: string;
    started: string;
    finished: string | null;
    result: "ok" | "error" | null;
    error: string | null;
    failed: string[];
  } | null;
  last_ok: string | null;
  running: boolean;
  next: string | null;
}
