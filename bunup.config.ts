import { defineConfig } from "bunup"

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  external: ["react", "@react-native-async-storage/async-storage"],
  clean: true,
})
