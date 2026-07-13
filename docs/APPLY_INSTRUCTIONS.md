# Restaurant Intelligence — Apply Instructions (runbook)

Ordered steps to implement `INTELLIGENCE_SPEC.md` on
`bhargav465/Restropulse-landingpage`. Follow top to bottom; don't reorder.
Current state you're inheriting (from the MongoDB-pages/Vercel handover):

- Live: https://restropulse-landingpage.vercel.app (Vercel project
  `restropulse-landingpage`, team `bhargavs-projects-2af70bcc`);
  `/` → `/pages/landing`, HTML served from the `pages` collection.
- Atlas: DB `restropulse-dev` on `cluster0.y1kon8h`. Collections:
  `pages`, `plans`, `settings`, `assets`.
- Vercel entry: `api/index.js` exports the Express app; `vercel.json`
  rewrites all routes to it. Env vars `MONGODB_URI` + `DB_NAME` must exist
  on **Production** and any change **requires a redeploy**.
- Git: PR #1 (`feat/mongodb-pages-vercel`, d0dc291) open against `main`.

## 0. Pre-flight (do these before writing code)

1. Merge PR #1 into `main`; set the repo's **default branch back to `main`**
   (GitHub currently defaults to the feat branch).
2. `git clone` fresh from GitHub and branch: `feat/intelligence-scanner`.
   Do NOT build on any stale local copy.
3. Copy this `docs/` set (`INTELLIGENCE_SPEC.md`, `APPLY_INSTRUCTIONS.md`,
   `NEW_SESSION_PROMPT.md`) into `docs/` in the repo — first commit.
4. Verify env: `npm install && npm run seed && npm start` against Atlas
   (`.env` from `.env.example`); confirm `GET /api/config/plans` returns 200.
5. Security debt from the handover — do now, it blocks storing real leads:
   rotate the Atlas password (it appeared in session/shell history) and
   replace Network Access `0.0.0.0/0` with Vercel + your IPs.

> DEVIATION (this build): per owner decision, we stacked on the existing
> `feat/mongodb-pages-vercel` branch (PR #1 stays open) rather than merging
> first, and **deferred** step 0.5 — building/testing against Atlas with
> `[SAMPLE]` directory data and disposable test leads only. The owner rotates
> the Atlas password + tightens Network Access before any real launch.

## 1. Data layer

1. `seed/directory.json` — ~25 `[SAMPLE]` restaurants across 4–5 areas per
   the spec shape (each area needs 8–12 for a credible ranking).
2. Extend `seed/seed.js`: upsert `directory` (unique index on `slug`,
   index on `area`), never overwrite non-sample docs. Keep it re-runnable.
3. Indexes for new collections: `scans.scanId` unique, `leads.email + createdAt`,
   `leads.scanId`, `login_events.at`.

## 2. API layer (server/, mounted in both server/index.js and api/index.js)

Implement per spec §4, in this order, each with a curl check:

1. `GET /api/directory/search?q=` — seeded results.
2. `POST /api/intelligence/scan` — full report doc; verify score math
   against 2–3 hand-computed fixtures (write these as comments).
3. `POST /api/leads` — validation (reject missing consent with 422),
   rate limit, lead insert + scan unlock.
4. `GET /api/intelligence/scan/:scanId` — stored report + `unlocked`.
5. `POST /api/events/login` — `login_events` insert (email, at). Wire the
   existing `#login` form to fire-and-forget this before its redirect.

## 3. Page layer (public/index.html → `pages` collection)

1. Rebuild the `#home` hero per spec §2a: report widget as the primary CTA
   (input + "Get my AI report" capsule, autocomplete wired to
   `/api/directory/search`), demoted secondary links, and the loss-framing
   "Who's beating you on Google" mock. Then add the §2b nudges (sticky bar
   with IntersectionObserver + localStorage dismissal, nav CTA swap,
   pillar/band links).
2. Add `#intelligence` to `PAGES` + nav; build the three screens
   (search → scanning → report) per spec §1/§5, Electric Lavender tokens
   only, reusing existing primitives. Hero submissions arrive here with the
   restaurant pre-selected and the scan auto-starting.
3. Gate modal + blur/unlock flow; deep-link `#intelligence/report/<scanId>`
   (extend the hash router to tolerate the suffix).
4. Embedded fixture fallback for one sample restaurant (API-down demo mode).
5. Print stylesheet + "Download report" button.

## 4. Gates before every commit

- `node --check` all server files; page JS extracted + `node --check`.
- Server up with Atlas: all 5 curl checks green; with Atlas blocked:
  page still renders, APIs return 503 envelope.
- Manual pass of spec §6 acceptance list (0–8), desktop + 380 px width.
- Conventional commits (`feat(intel): …`); mark guesses `ASSUMPTION:` in
  the PR description.

## 5. Ship

1. Update the `pages` collection copy of the HTML: `npm run set-page --
   landing public/index.html` (tooling from the pages handover), confirm
   `/pages/landing` serves the new markup locally.
2. PR `feat/intelligence-scanner` → `main`; merge.
3. Deploy to Vercel (existing flow). If env vars changed, redeploy —
   remember the handover lesson: 503s in prod were missing Production env
   vars, not Atlas.
4. Post-deploy verify on the live URL: run one full scan, submit the gate
   with a test lead, confirm the doc lands in Atlas `leads`, then delete
   the test lead.
5. Update this doc's "Current state" block + append a changelog line.

## Rollback

The page is data: re-run `set-page` with the previous HTML from the `pages`
doc's version history (or git) — no redeploy needed unless server routes
changed. Server rollback = revert the merge commit, redeploy.
