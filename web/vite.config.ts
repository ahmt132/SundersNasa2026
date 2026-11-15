import { cpSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// When the data is served from Cloudflare R2 (VITE_DATA_URL is set), the 4.8 GB data folder in
// public/ is left out of the page build: Cloudflare Pages accepts at most 20,000 files of 25 MB
// each. Everything else in public/ (_headers, icons) is still copied.
function publicWithoutData(): Plugin {
  return {
    name: "public-without-data",
    apply: "build",
    closeBundle() {
      const pub = resolve(__dirname, "public");
      for (const name of readdirSync(pub)) {
        if (name === "data") continue;
        cpSync(resolve(pub, name), resolve(__dirname, "dist", name), { recursive: true });
      }
    },
  };
}

// base "./" makes every URL relative, so the built page works from the domain root or a sub-folder.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const remoteData = Boolean(process.env.VITE_DATA_URL || env.VITE_DATA_URL);
  return {
    base: "./",
    plugins: remoteData ? [react(), publicWithoutData()] : [react()],
    server: { port: 5173, strictPort: true },
    build: { chunkSizeWarningLimit: 2000, copyPublicDir: !remoteData },
  };
});
