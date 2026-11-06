import { defineConfig } from "vite";
export default defineConfig({ base: "/apps/pilot/", build: { target: "es2022", outDir: "../dist/web", emptyOutDir: true } });
