// Bundles a Node service (and its workspace deps) into a single ESM file: dist/index.mjs
import { build } from "esbuild";
const entry = process.argv[2] ?? "src/index.ts";
await build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist/index.mjs",
  sourcemap: true,
  // sharp is native: shipped next to the bundle by the services that use it (see their Dockerfile).
  external: ["pg-native", "sharp"],
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});
