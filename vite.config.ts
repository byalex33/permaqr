import { fileURLToPath } from "node:url";
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL("./web", import.meta.url));
const outDir = fileURLToPath(new URL("./dist/client", import.meta.url));

export default defineConfig({
  plugins: [preact()],
  root,
  publicDir: "public",
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./web/index.html", import.meta.url)),
        app: fileURLToPath(new URL("./web/app/index.html", import.meta.url)),
      },
    },
  },
});
