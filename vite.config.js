import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// Multi-page setup:
//   /                → AR Dashboard      (index.html → src/main.jsx)
//   /cashflow.html   → Cashflow Dashboard (cashflow.html → src/cashflow/main.tsx)
// Single dev server + single build serve both. Cashflow's /api and /auth
// calls are proxied to a working backend at dev time.
//
// Dev-only: where local dev proxies /api + /auth. Production runs on
// cfovaani.com (Replit), which serves the backend same-origin — so this proxy
// only matters during `npm run dev`. We point it at the live cfovaani.com
// backend. Override with VITE_CASHFLOW_API=http://localhost:4747 if you're
// running the cashflow-server locally for full-stack hacking.
const CASHFLOW_API = process.env.VITE_CASHFLOW_API || "https://cfovaani.com";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    // Make HMR reach the browser THROUGH an https tunnel (Cloudflare quick
    // tunnel). The page is served over wss on 443, so the HMR client must
    // connect to 443, not the dev port 5173. Without this, live updates never
    // arrive over the tunnel and every change needs a manual hard-refresh.
    hmr: { clientPort: 443, protocol: "wss" },
    // Allow tunnel hosts (Cloudflare quick tunnel, ngrok, etc.) — Vite 5
    // blocks unknown hosts by default since CVE-2025-24010. Wildcards via
    // leading "." match any subdomain.
    allowedHosts: [
      "localhost",
      ".trycloudflare.com",
      ".ngrok.io",
      ".ngrok-free.app",
      ".loca.lt",
      ".pinggy.link",
    ],
    proxy: {
      "/api":  { target: CASHFLOW_API, changeOrigin: true, secure: true },
      "/auth": { target: CASHFLOW_API, changeOrigin: true, secure: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      input: {
        main:     resolve(__dirname, "index.html"),
        cashflow: resolve(__dirname, "cashflow.html"),
      },
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          recharts: ["recharts"],
          papaparse: ["papaparse"],
        },
      },
    },
  },
});
