// The loaded dashboard data, shared with every page through React context.
import { createContext, useContext } from "react";
import { Calendar } from "./lib/calendar";
import type { DailyKey, DashboardData, Meta, RunSummary, Series } from "./types";

/** A run summary plus its day index. */
export interface Run extends RunSummary {
  d: number;
}

export interface Dataset {
  meta: Meta;
  cal: Calendar;
  daily: Record<DailyKey, Series>;
  /** Oldest first. */
  runs: Run[];
  runById: Map<string, Run>;
}

export function makeDataset(data: DashboardData): Dataset {
  const cal = new Calendar(data.meta);
  const runs = data.runs
    .map(r => ({ ...r, d: cal.day(r.date) }))
    .sort((a, b) => (a.start < b.start ? -1 : 1));
  return { meta: data.meta, cal, daily: data.daily, runs, runById: new Map(runs.map(r => [r.id, r])) };
}

export const DataContext = createContext<Dataset | null>(null);

/** Reloads api/data, e.g. after saving a run note (notes and shoes are part of the run summaries). */
export const ReloadContext = createContext<() => Promise<void>>(async () => {});

export function useReload() {
  return useContext(ReloadContext);
}

export function useData(): Dataset {
  const d = useContext(DataContext);
  if (!d) throw new Error("useData() outside <DataContext.Provider>");
  return d;
}
