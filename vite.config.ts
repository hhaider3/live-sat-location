import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    proxy: {
      // The TLE endpoint lives in the Cloudflare Worker (see worker/index.js).
      // `npm run dev:worker` serves it on 127.0.0.1:8787; without it, every
      // group silently falls back to simulated orbits.
      "/api": "http://127.0.0.1:8787",
    },
  },
});
