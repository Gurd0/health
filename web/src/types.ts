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
  // your own notes (training.duckdb)
  rpe: number | null; // effort 1-10
  feel: number | null; // 1 awful - 5 great
  note: string | null;
  shoe: string | null; // shoe id: the run's own, else the default shoe on its date
  shoeAuto: boolean; // true when the shoe comes from the default
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

// --- Training (ingest/training.py) ---

export type SessionKind = "easy" | "strides" | "long" | "tempo" | "intervals" | "recovery" | "race";
export type SessionStatus = "done" | "partial" | "missed" | "skipped" | "today" | "upcoming";
export type HrZone = "LIGHT" | "MODERATE" | "VIGOROUS" | "PEAK";

export interface Fitness {
  weekly_km: number;
  longest_km: number;
  t5: number; // 5 km-equivalent time, s
  basis: string;
  runs: number;
}

export interface Plan {
  id: string;
  name: string;
  goalKm: number;
  goalDate: string;
  goalTimeS: number | null;
  runsPerWeek: number;
  days: number[]; // 0 = Monday
  longDay: number;
  created: string;
  predictedS: number | null;
  fitness: Fitness | null;
  warnings: string[];
  paces: Record<string, [number, number]> | null;
  rebuilt: string | null;
}

export interface PlannedSession {
  date: string;
  kind: SessionKind;
  title: string;
  km: number | null;
  durS: number | null;
  paceLo: number | null;
  paceHi: number | null;
  hrZone: HrZone | null;
  hrRange: [number, number] | null;
  description: string | null;
}

export interface Verdict {
  pace: "on" | "fast" | "slow" | null;
  paceDiff: number | null; // s/km outside the range
  hr: "in" | "above" | "below" | null;
}

export interface Session extends PlannedSession {
  id: string;
  status: SessionStatus;
  runId: string | null;
  manual: boolean; // linked by hand
  edited: boolean;
  verdict: Verdict | null;
}

export interface Week {
  monday: string;
  plannedKm: number;
  doneKm: number;
  planned: number;
  done: number;
  adherence: number | null; // %
  hit: boolean | null;
  state: "past" | "current" | "future";
}

export interface Flag {
  level: "high" | "caution" | "info";
  text: string;
  action?: "rebuild" | "archive";
}

export interface Recovery {
  status: "ok" | "low" | "unknown";
  reasons: string[];
  hrv: number | null;
  hrv30: number | null;
  rhr: number | null;
  rhr30: number | null;
  sleep: number | null;
  swap?: { a: string; b: string; bDate: string } | null;
}

export interface Shoe {
  id: string;
  name: string;
  km: number;
  startKm: number;
  maxKm: number;
  retired: boolean;
  isDefault: boolean;
  runs: number;
  lastUsed: string | null;
  wear: "ok" | "warn" | "over";
}

/** GET api/training */
export interface Training {
  today: string;
  plan: Plan | null;
  sessions: Session[];
  extra: string[]; // run ids in the plan's span that match no session
  weeks: Week[];
  streak: number;
  targets: { km: number | null; runs: number | null };
  load: { start: string; load: number[]; acwr: (number | null)[] };
  runLoad: Record<string, number>;
  flags: Flag[];
  recovery: Recovery;
  shoes: Shoe[];
  zones: number[];
}

/** POST api/plans/preview */
export interface PlanPreview {
  sessions: PlannedSession[];
  weeks: { monday: string; phase: string; recovery: boolean; km: number }[];
  fitness: Fitness;
  predictedS: number;
  paces: Record<string, [number, number]>;
  warnings: string[];
}

export interface PlanInput {
  goal_km: number;
  goal_date: string;
  goal_time_s: number | null;
  runs_per_week: number;
  days: number[];
  long_day: number;
  name?: string;
}
