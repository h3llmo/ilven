import { defineConfig } from "vite";
export default defineConfig({
  build: {
    target: "es2022",
    outDir: "dist",
    lib: { entry: "src/index.ts", formats: ["es"], fileName: () => "ilven-plugin.js" },
  },
});
