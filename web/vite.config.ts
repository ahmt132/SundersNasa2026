import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" makes every URL relative, so the built site works from the domain root or any
// sub-folder of a GoDaddy account (public_html/ or public_html/<folder>/).
export default defineConfig({
  base: "./",
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: { chunkSizeWarningLimit: 2000 },
});
