import fs from "node:fs";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

process.env.ADMIN_PASSWORD ??= "test-password";

const assets = path.resolve("dist/client");
fs.mkdirSync(path.join(assets, "app"), { recursive: true });
if (!fs.existsSync(path.join(assets, "index.html"))) {
  fs.writeFileSync(
    path.join(assets, "index.html"),
    `<!doctype html><title>PermaQR</title><h1>PermaQR</h1>
<p class="fine" id="fine-print">MIT licensed. One admin password. No account with us, because there is no us.</p>
<section class="hosted" id="hosted" hidden></section>
<a id="hosted-signin" hidden href="/account/login">Hosted sign-in</a>`,
  );
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
            HOSTED_MODE: "true",
            LEMONSQUEEZY_CHECKOUT_URL: "https://permaqr.lemonsqueezy.com/checkout/buy/variant-test",
            LEMONSQUEEZY_WEBHOOK_SECRET: "test-webhook-secret",
            LEMONSQUEEZY_VARIANT_ID: "42",
            TEST_MIGRATIONS: migrations,
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    include: ["test/hosted.spec.ts"],
  },
});
