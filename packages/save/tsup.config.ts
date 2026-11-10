import { defineConfig } from "tsup";

// @railkit/core is private to this repo, so the parts of it this SDK uses are bundled in. Its two small dependencies stay
// external and are listed in package.json, so the published package works without the rest of the repo.
export default defineConfig({
  entry: { index: "src/index.ts", payer: "src/payer.ts" },
  format: ["esm", "cjs"],
  target: "node20",
  dts: { resolve: true },
  tsconfig: "tsconfig.build.json",
  clean: true,
  sourcemap: false,
  noExternal: ["@railkit/core"],
});
