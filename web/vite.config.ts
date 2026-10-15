import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` serves the app on :5173 and forwards api/ and oauth/ to `python -m ingest serve` on :8000.
// `npm run build` writes dist/, which the Python server serves.
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8000",
      "/oauth": "http://127.0.0.1:8000",
    },
  },
});
