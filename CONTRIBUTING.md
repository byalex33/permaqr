# Contributing to PermaQR

Thanks for looking. PermaQR is a small, self-hosted dynamic QR app. Changes should keep the redirect fast, the data exportable, and the scan log free of IP addresses.

## Setup

```sh
npm install
cp .dev.vars.example .dev.vars
# put a password in ADMIN_PASSWORD
npm run db:migrations:apply:local
npm run dev
```

The dashboard is at [http://localhost:8787/login](http://localhost:8787/login). The marketing page is at `/`.

## Checks

Run these before you open a pull request:

```sh
npm test
npm run typecheck
npm run dry-run
```

`npm test` runs Vitest inside the Workers runtime via `@cloudflare/vitest-plugin` (the current name of the Workers Vitest pool). Redirect and API tests use a local D1 database and KV namespace.

## Project map

- `src/` Worker: redirects, auth, API
- `shared/types.ts` types used by the Worker and the dashboard
- `migrations/` D1 schema
- `web/` Vite + Preact dashboard and the public landing page
- `test/` Workers runtime tests

## Privacy

Scan rows may store a timestamp, a country code, a coarse device and OS, and the referrer hostname. Do not add the connecting IP, a raw user agent, a cookie, or a full referrer URL. Login throttling may store a short-lived hash of the address, not the address itself.

## Pull requests

- Keep the diff focused. A redirect change should not restyle the landing page.
- Add or update a test when you change redirect, auth, import, or export behaviour.
- Do not commit `.dev.vars`, real Cloudflare account IDs, or screenshots of someone else's data.
- The license is MIT. By contributing, you agree that your changes are under that license.
