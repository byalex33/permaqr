import fs from "node:fs";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

process.env.ADMIN_PASSWORD ??= "test-password";

const assets = path.resolve("dist/client");
fs.mkdirSync(path.join(assets, "app"), { recursive: true });
if (!fs.existsSync(path.join(assets, "index.html"))) {
  fs.writeFileSync(path.join(assets, "index.html"), "<!doctype html><title>PermaQR</title><h1>PermaQR</h1>");
}
if (!fs.existsSync(path.join(assets, "app/index.html"))) {
  fs.writeFileSync(path.join(assets, "app/index.html"), "<!doctype html><title>PermaQR</title>");
}

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.resolve("migrations"));
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            ADMIN_PASSWORD: "test-password",
            TEST_MIGRATIONS: migrations,
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
