# PermaQR

Your QR code stopped working because you stopped paying.

PermaQR is an open-source dynamic QR code app you host yourself. It runs on [Cloudflare’s free tier](https://developers.cloudflare.com/workers/platform/pricing/), on your domain. A printed code keeps resolving after a trial ends, and you can change the destination whenever you want.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/byalex33/permaqr)

[Source on GitHub](https://github.com/byalex33/permaqr) · MIT licensed

## What it looks like

![PermaQR landing page](docs/screenshots/landing.png)

![Dashboard](docs/screenshots/dashboard.png)

![QR designer](docs/screenshots/designer.png)

![Scan analytics](docs/screenshots/analytics.png)

## Features

- **Short-code redirects.** `GET /menu` reads KV first and answers `302`. A scan (time, country, device, OS, referrer host) is written with `ctx.waitUntil`, so the hop does not wait on the database.
- **One admin.** Create, edit, pause, and delete codes. Custom slugs. The short code stays put; the destination is what you change.
- **QR designer.** Foreground and background, dot and corner styles, error correction, quiet zone, optional centre logo, live preview.
- **Print files.** SVG, a 2048 px PNG, and a letter-size PDF.
- **Analytics.** Total scans, a chart over time, top countries, devices. No cookies. No IP stored.
- **Export and import.** JSON or CSV of every code and redirect, so you are not locked in.
- **Fallback page.** A plain message for paused or unknown codes. You can edit the wording.
- **Optional Cloudflare Access.** Password is the default. If you set a team domain and an Access audience tag, a verified Access JWT is also accepted.

There is no AI in this project.

## Quick start

Requirements: Node.js 22+, a Cloudflare account.

**Deploy with the button** at the top of this file. Cloudflare clones the repo, asks for `ADMIN_PASSWORD`, creates the D1 database and KV namespace, builds the app, and deploys it. After the first deploy, open `/login`.

**Or from your machine:**

```sh
git clone https://github.com/byalex33/permaqr.git
cd permaqr
npm install
npx wrangler login
printf '%s' "$(openssl rand -base64 24)" | npx wrangler secret put ADMIN_PASSWORD
npm run deploy
```

`npm run deploy` builds the UI, applies D1 migrations to the remote database named by the `DB` binding, then runs `wrangler deploy`.

Copy `.dev.vars.example` to `.dev.vars` if you want to run it locally first:

```sh
cp .dev.vars.example .dev.vars
npm run dev
```

Open [http://localhost:8787](http://localhost:8787). The password is whatever you put in `.dev.vars`.

## Self-hosting

### Cloudflare resources

Names match [`wrangler.jsonc`](wrangler.jsonc).

| Resource | Wrangler name | Purpose |
| --- | --- | --- |
| Worker | `permaqr` | Redirects, API, and static UI |
| D1 binding | `DB` | Codes, scans, fallback message |
| D1 database name | `permaqr` | The database created for that binding |
| KV binding | `CODES` | Hot cache for redirect lookups |
| Secret | `ADMIN_PASSWORD` | Dashboard password |
| Static assets | `ASSETS` (`./dist/client`) | Landing page and dashboard |

Placeholder ids in the config (`database_id`, KV `id`) are defaults so the [Deploy to Cloudflare](https://developers.cloudflare.com/workers/platform/deploy-buttons/) button can provision real resources and rewrite them. Wrangler 4.45+ can also create a missing KV namespace, D1 database, or R2 bucket on deploy.

Optional vars, commented in `wrangler.jsonc`:

- `CF_ACCESS_TEAM_DOMAIN` — for example `your-team.cloudflareaccess.com`
- `CF_ACCESS_AUD` — the Access application’s audience tag

Both must be set. PermaQR checks the JWT signature against your team’s Access certs. The `Cf-Access-Authenticated-User-Email` header alone is not trusted.

### Manual setup

1. Install dependencies: `npm install`
2. Log in: `npx wrangler login`
3. Create the database if you are not using automatic provisioning:

   ```sh
   npx wrangler d1 create permaqr
   npx wrangler kv namespace create CODES
   ```

   Paste the printed `database_id` and KV `id` into `wrangler.jsonc`. Keep `binding` as `DB` and `CODES`, and keep `migrations_dir` as `migrations`.

4. Set the password (this creates a Worker version, so do it before or after the first deploy):

   ```sh
   npx wrangler secret put ADMIN_PASSWORD
   ```

5. Apply migrations and deploy:

   ```sh
   npm run deploy
   ```

   To apply migrations on their own:

   ```sh
   npx wrangler d1 migrations apply DB --remote
   ```

   The name `DB` is the binding, not a guess at the database id. That still works if you rename the database during the deploy-button flow.

6. Attach a domain you own (Workers dashboard, or a `routes` entry with `custom_domain`). Print `https://qr.yourdomain.com/menu`, not a host you might abandon.

Local migrations:

```sh
npx wrangler d1 migrations apply DB --local
```

### Free tier, honestly

A personal or small-business set of codes fits Cloudflare’s free plan: Workers requests, D1 rows, and KV reads all have daily limits. A scan is one KV read and one D1 write. Check the current [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/), and [KV](https://developers.cloudflare.com/kv/platform/pricing/) limits before you put a code on a stadium poster.

Redirect responses are `Cache-Control: no-store`, so a destination edit is the next scan, not a cached 302.

### Routes

| Path | Who |
| --- | --- |
| `/` | Landing page, or the dashboard if you already have a session |
| `/site` | Landing page, even when you are signed in |
| `/login`, `/app` | Dashboard |
| `/api/*` | JSON API, password or Access |
| `/:slug` | 302, or the fallback page |
| `/health` | `{ "ok": true, "name": "permaqr" }` |

### Export format

JSON (version 1) includes the fallback message and every code: slug, title, destination, paused, QR style, timestamps. CSV is `slug,title,destination,paused,created_at`. Scan rows are not in the export. Import with **Import** on the dashboard, or `POST /api/import?format=json|csv&mode=merge|replace`.

## Development

```sh
npm test          # vitest, Workers runtime
npm run typecheck
npm run dry-run   # vite build + wrangler deploy --dry-run
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Roadmap

- Bulk sheet of QR codes as one PDF
- Rollups so very high scan volume does not grow the scans table forever
- More than one admin, if password-plus-Access is not enough
- A webhook when a code crosses a scan count
- Per-code schedules (publish the new destination at a time)

Not planned: accounts hosted by this project, or anything that phones home.

## License

[MIT](LICENSE) © 2026 Alex
