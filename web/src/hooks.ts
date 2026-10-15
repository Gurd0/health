// Small React hooks shared by the pages.
import { useEffect, useState } from "react";

const PHONE = "(max-width: 600px)";

/** True on narrow screens; charts use a smaller layout there. */
export function usePhone() {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE).matches);
  useEffect(() => {
    const mq = window.matchMedia(PHONE);
    const on = () => setPhone(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}

const sessionStore = new Map<string, unknown>();

/** useState that survives leaving and returning to a page (until reload), e.g. the chosen date range. */
export function useSessionState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => (sessionStore.has(key) ? (sessionStore.get(key) as T) : initial));
  useEffect(() => { sessionStore.set(key, value); }, [key, value]);
  return [value, setValue] as const;
}

export type Theme = "auto" | "light" | "dark";

/** Colour theme, saved in localStorage; "auto" follows the OS. index.html applies it before first paint. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    try { return (localStorage.getItem("hr-theme") as Theme) || "auto"; } catch { return "auto"; }
  });
  useEffect(() => {
    try { localStorage.setItem("hr-theme", theme); } catch { /* storage blocked */ }
    if (theme === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);
  return [theme, setTheme] as const;
}

export type Route = { page: "overview" } | { page: "training" } | { page: "runs" } | { page: "run"; id: string } | { page: "gear" };
export type Page = Route["page"];

function parseHash(): Route {
  const parts = location.hash.slice(1).split("?")[0].split("/").filter(Boolean);
  if (parts[0] === "runs") return { page: "runs" };
  if (parts[0] === "training") return { page: "training" };
  if (parts[0] === "gear") return { page: "gear" };
  if (parts[0] === "run" && parts[1]) return { page: "run", id: decodeURIComponent(parts[1]) };
  return { page: "overview" };
}

/** The page from the URL hash: #/overview, #/training, #/runs, #/run/<id>, #/gear. */
export function useHashRoute() {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const on = () => { setRoute(parseHash()); window.scrollTo(0, 0); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export const runHref = (id: string) => "#/run/" + encodeURIComponent(id);
