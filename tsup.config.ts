import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli/index.tsx", "src/tui/index.tsx"],
  format: ["esm"],
  target: "es2022",
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: false
});
