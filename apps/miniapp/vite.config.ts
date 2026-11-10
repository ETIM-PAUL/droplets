import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Reached through a tunnel for on-device testing: ngrok, or a free Cloudflare quick tunnel.
const allowedHosts = [".ngrok-free.app", ".ngrok-free.dev", ".ngrok.app", ".ngrok.dev", ".trycloudflare.com"];
// One tunnel serves both: /api goes to the local RailKit API.
const proxy = { "/api": { target: "http://localhost:8787", rewrite: (p: string) => p.replace(/^\/api/, "") } };

export default defineConfig({
  plugins: [react()],
  // Two pages: the app (and the landing page it shows in a browser), and /admin, which no one else downloads.
  build: { rollupOptions: { input: { main: fileURLToPath(new URL("index.html", import.meta.url)), admin: fileURLToPath(new URL("admin.html", import.meta.url)) } } },
  // Read VITE_* settings from the repo-root .env. Vite only exposes VITE_-prefixed values to the browser.
  envDir: "../..",
  server: { allowedHosts, proxy },
  // `vite build && vite preview` serves a handful of files instead of hundreds of dev modules,
  // which keeps a free tunnel under its request limit.
  preview: { port: 5173, allowedHosts, proxy },
});
