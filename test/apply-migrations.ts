import { applyD1Migrations, env } from "cloudflare:test";

type MigrationList = Parameters<typeof applyD1Migrations>[1];

// Test-only binding injected by vitest.config.ts. It is not part of the Worker Env.
const migrations = (env as Env & { TEST_MIGRATIONS: MigrationList }).TEST_MIGRATIONS;
if (!migrations?.length) {
  throw new Error("TEST_MIGRATIONS binding is empty");
}
await applyD1Migrations(env.DB, migrations);
