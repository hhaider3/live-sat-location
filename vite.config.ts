import { createHash } from "crypto";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

/** Writes Cloudflare's _headers file. The app is one HTML file with inline code,
 * so its policy allows exactly that code by hash rather than all inline code.
 */
function securityHeaders(): Plugin {
  let outDir = "dist";
  return {
    name: "security-headers",
    apply: "build",
    configResolved(config) { outDir = config.build.outDir; },
    async closeBundle() {
      const html = await readFile(path.join(outDir, "index.html"), "utf8");
      const hashes = (tag: string) => [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "g"))]
        .map(match => `'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`).join(" ");
      const policy = [
        "default-src 'none'",
        `script-src ${hashes("script")}`,
        "worker-src blob:", // inline Web Workers
        `style-src ${hashes("style")}`,
        "img-src 'self' data: blob:",
        "connect-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join("; ");
      await writeFile(path.join(outDir, "_headers"), [
        "/*",
        `  Content-Security-Policy: ${policy}`,
        "  Strict-Transport-Security: max-age=31536000",
        "  X-Content-Type-Options: nosniff",
        "  X-Frame-Options: DENY",
        "  Referrer-Policy: strict-origin-when-cross-origin",
        "  Permissions-Policy: camera=(), microphone=(), geolocation=()",
        "",
      ].join("\n"));
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile(), securityHeaders()],
  server: {
    proxy: {
      // Orbital APIs live in the Cloudflare Worker (see worker/index.js).
      // Without the Worker, the site-hosted observed snapshot still loads.
      "/api": "http://127.0.0.1:8787",
    },
  },
});
