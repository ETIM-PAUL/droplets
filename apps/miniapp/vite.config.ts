import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Read VITE_* settings from the repo-root .env. Vite only exposes VITE_-prefixed values to the browser.
  envDir: "../..",
  server: {
    // Lets the dev server be reached through an ngrok tunnel for on-device testing.
    allowedHosts: [".ngrok-free.app", ".ngrok-free.dev", ".ngrok.app", ".ngrok.dev"],
    // One tunnel serves both: /api goes to the local RailKit API.
    proxy: { "/api": { target: "http://localhost:8787", rewrite: (p) => p.replace(/^\/api/, "") } },
  },
});
