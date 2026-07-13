# Handover — MongoDB `pages` + Vercel deployment

_Last updated: 2026-07-12_

## 1. What was asked

Store a marketing landing page (`restropulse-landing.html`) **in MongoDB** and
serve it from there, then **deploy it to Vercel**.

## 2. What was built

A new capability on top of the existing landing-page app (which already served
`plans`, `settings`, and `assets` from MongoDB): a **`pages` collection** that
holds complete HTML documents and serves them straight from the DB, plus a
Vercel serverless deployment.

### New MongoDB collection: `pages`

| Field | Meaning |
|---|---|
| `slug` | unique key, e.g. `landing` (URL is `/pages/<slug>`) |
| `title` | from the HTML `<title>` |
| `html` | the full HTML document |
| `contentType` | `text/html; charset=utf-8` |
| `active` | hide a page with `false` |
| `updatedAt` | timestamp |

Unique index on `slug`.

### New routes (in `server/index.js`)

- `GET /pages/:slug` — renders the stored HTML from the DB (human-facing)
- `GET /api/pages` — lists stored pages (metadata only, no HTML)
- `GET /api/pages/:slug` — one page as JSON (includes `html`, for editing)
- `GET /` — redirects (302) to `/pages/landing` **when no static
  `public/index.html` is served** (i.e. on Vercel). Local dev is unaffected —
  `express.static` still serves `public/index.html` at `/` there.

### Tooling

- `scripts/set-page.js` + `npm run set-page -- <slug> <file.html> [title]` —
  upsert any HTML file as a page.
- `npm run seed` now also loads every `seed/pages/*.html` into `pages`
  (slug = filename, title = `<title>`). Ships `seed/pages/landing.html`.

### Vercel wiring

- `api/index.js` — serverless entrypoint; `module.exports = require("../server/index.js")`.
- `server/index.js` — only calls `app.listen()` when run directly
  (`require.main === module`); otherwise exports the Express `app`.
- `vercel.json` — rewrites every path to the single function:
  `{ "rewrites": [{ "source": "/(.*)", "destination": "/api/index" }] }`.
- No static `public/**` is bundled to Vercel; the site root is served from the
  DB via the `/` → `/pages/landing` redirect.

## 3. Live deployment

- **Production URL:** https://restropulse-landingpage.vercel.app
- **Vercel project:** `restropulse-landingpage` (team `bhargavs-projects-2af70bcc`,
  project id `prj_TySGe4aPs8ATW9WcMCPm28E2H5I6`), region `iad1`, serverless (LAMBDAS).
- **Dashboard:** https://vercel.com/bhargavs-projects-2af70bcc/restropulse-landingpage
- Deployed via the Vercel MCP `deploy_to_vercel` tool (no CLI/token used).

Verified live:
| Route | Result |
|---|---|
| `/` | 302 → `/pages/landing` → 200 HTML |
| `/pages/landing` | 200 · `text/html` · 46,495 B (from MongoDB) |
| `/api/pages` | lists `landing` |
| `/api/config/plans` | plans from MongoDB (₹299 / 1299 / 4999) |

## 4. MongoDB (Atlas)

- **Cluster:** `cluster0.y1kon8h.mongodb.net` (shared dev cluster)
- **Database:** `restropulse-dev`
- **Collections in use:** `settings`, `plans`, `assets`, `pages`
- `pages` currently holds one doc: `slug: "landing"`.
- Connection string lives in a **gitignored** `.env` locally, and in Vercel
  **Production** env vars. Never committed.

## 5. Config required for the app to work

Two things, both outside the code:

1. **Env vars** — `MONGODB_URI` and `DB_NAME=restropulse-dev`.
   - Locally: `.env` (gitignored). `server/db.js` reads `DB_NAME` (not
     `MONGODB_DB_NAME`).
   - Vercel: must be set on the **Production** environment. Env changes only
     apply to **new** deployments.
2. **Atlas Network Access** — must allow Vercel's rotating IPs, i.e.
   `0.0.0.0/0` (Network Access → Add IP Address).

## 6. Debugging notes (what went wrong, so it's not re-hit)

- The deployed site initially returned `503 Database unavailable` on every DB
  route. Root cause: the env vars were **not on the Production environment**, so
  the function had no `MONGODB_URI` at all.
- A temporary standalone `GET /api/debug` function was deployed to confirm this
  (`{"hasUri":false,...}`), then removed once fixed. It masked the password and
  reported `hasUri` / `dbName` / the driver error.
- The Vercel MCP `deploy_to_vercel` tool **cannot set env vars** — they must be
  set in the dashboard.
- When passing `server/index.js` to the deploy tool, use **base64 encoding**;
  hand-transcribing a UTF-8 file with template literals/quotes caused a
  corrupted upload once.

## 7. Git state

- **Repo:** https://github.com/bhargav465/Restropulse-landingpage
- **Branch:** `feat/mongodb-pages-vercel` (commit `d0dc291`)
- **Base:** `main` (commit `f31c72a`) — had to be pushed too; the remote was
  empty before this work.
- **PR:** #1 — https://github.com/bhargav465/Restropulse-landingpage/pull/1
- 8 files changed, +1231/−4. `.env` excluded.
- ⚠️ GitHub set the **default branch to `feat/mongodb-pages-vercel`** (first
  branch pushed to an empty repo). After merging PR #1, switch default back to
  `main` in Settings → Branches.
- ⚠️ Commit author is auto-detected `Yellapragada@Divyas-MacBook-Air.local`
  (no git identity configured). Amend + force-push if correct attribution
  matters.

## 8. Outstanding / next steps

- [ ] Merge PR #1 and reset the default branch to `main`.
- [ ] (Optional but recommended) Connect the repo to **Vercel Git integration**
      so every push auto-deploys with the Production env vars already set — no
      more manual `deploy_to_vercel` calls or base64 payloads.
- [ ] **Security:** the Atlas dev password is now in shell history / this
      session. Rotate it before pointing at anything real. `0.0.0.0/0` leaves
      the cluster open to all IPs — fine for a demo, not for production data.
- [ ] To add more pages later: drop an `.html` in `seed/pages/` and re-seed, or
      `npm run set-page -- <slug> <file.html>`.

## 9. How to run locally

```bash
npm install
cp .env.example .env          # set MONGODB_URI + DB_NAME
npm run seed                  # loads plans, assets, and pages/*.html
npm start                     # http://localhost:3005
# → http://localhost:3005/pages/landing
```
