# RestroPulse — Restaurant Intelligence Scanner (Spec)

Feature spec for integrating a **Restaurant Intelligence** flow into the
landing-page site (`bhargav465/Restropulse-landingpage`, live at
https://restropulse-landingpage.vercel.app). Read `APPLY_INSTRUCTIONS.md` for
the execution order; this file is the *what*, that file is the *how*.

## 1. Product intent

A Sous-style lead-gen scanner (reference: https://ai.poweredbysous.com/en —
flow verified 2026-07-12). A restaurant owner lands on the page, searches for
their restaurant, watches a short "scanning" sequence, and gets a
**Visibility Report**. The full report is gated behind a contact form
(name + phone + email). Every submission is stored in MongoDB — that is the
"login details" capture: it builds a lead list of real restaurant owners.

Reference flow (replicate the shape, NOT the branding):

1. **Landing prompt** — one headline ("Am I visible on Google & ChatGPT?"
   equivalent), a restaurant search box with autocomplete (name, address,
   star rating per result), an "avg revenue per guest (₹)" input, one CTA.
2. **Scanning screen** — left rail checklist that ticks through stages:
   Business scan → Review sentiment → Photo quality → Local competition →
   AI search ranking, with a progress bar + "~22 seconds remaining", and an
   "Email me report" shortcut (also a lead capture). Main panel shows the
   selected restaurant card: photo, map pin, name, rating stars, review
   count, category, price level (₹₹₹), one-line description.
3. **Report page** (blurred behind the gate until the form is submitted):
   - Header: "Visibility Report" + date + restaurant identity card.
   - **Four score cards** (0–100): Online Visibility, Google Search,
     AI Visibility, Website Strength.
   - **Competitor ranking**: "You are ranked below N competitors …
     Your position: #10 of 11" — ordered list of nearby competitors with
     ratings, the subject row marked "(You)".
   - **Expected revenue growth**: Extra guests / month, Extra revenue /
     month, Extra revenue / year, footnote "*Conservative estimate: X%
     growth based on ₹Y/guest" (uses the avg-spend input).
   - **Profile checklist**: rating ≥ 4.0, ≥ 50 reviews, description filled,
     profile attributes added — pass/fail rows.
   - **To-do list**: 5 specific, keyword-rich recommendations to beat the
     competitors above.
   - **AI visibility test**: 3 realistic local queries ("Best fine dining in
     <area>", "Where to eat in <area> for a date"), each marked
     found / not-found, plus a 0/3 score and avg position.
   - **Gate modal**: "View your full report — enter your details for instant
     access", fields Name / Phone / Email, "I have multiple locations"
     checkbox, T&C consent checkbox, submit button, secondary CTA
     "Book a free strategy call".

## 2. Where it lives

The site is a single-file SPA with hash routing (`#home / #pricing / #login`)
served from the MongoDB `pages` collection on Vercel. Add one route:
**`#intelligence`**, linked from the nav ("Intelligence" item), the hero, and
the Growth pillar's "Coming soon" line (which it replaces). All styling uses
the existing Electric Lavender tokens — do NOT copy Sous's navy/indigo.
Reuse: `.aurora`, `.reveal`, `.btn-*`, `.kpi`, card patterns, the toggle
slider pattern for tabs, and the counter animation for scores.

## 3. Data model (MongoDB, additive — nothing existing changes)

| Collection | Purpose | Shape |
|---|---|---|
| `directory` | Searchable restaurant corpus for autocomplete + competitor sets | `{ slug, name, area, city, address, rating, reviewCount, category, priceLevel(1-3), description, photoAssetKey?, attrs: { descriptionFilled, attributeCount, photoCount }, sample: true }` |
| `scans` | One doc per generated report (idempotent by `scanId`) | `{ scanId (uuid), restaurantSlug, avgSpend, status: "done", report: {…computed…}, createdAt, unlockedBy?: leadId }` |
| `leads` | THE capture. One doc per gate submission | `{ leadId, name, phone, email, multipleLocations, consent: true, scanId, restaurantSlug, source: "intelligence-gate" \| "email-me-report", createdAt, ip?, userAgent? }` |
| `login_events` | Existing demo login instrumentation | `{ email, at, page: "login", success: true }` — **email + timestamp ONLY** |

**Hard rule — no plaintext credentials.** "Login details" means identity +
contact (name/phone/email) and login *events*. Never store passwords in any
form on this project (real auth stays in the main RestroPulse API with
bcrypt). The gate form must have a consent checkbox and the submit stays
disabled until checked (mirrors the reference).

Seed ~25 `[SAMPLE]` directory docs across 4–5 areas (e.g. Indiranagar,
Koramangala, HSR, Jubilee Hills) so competitor ranking has 8–12 restaurants
per area. Follow the repo convention: sample data marked `[SAMPLE]`, seeded
only via `seed/`.

## 4. API (Express, same envelope `{ success, data | error }`)

| Route | Behavior |
|---|---|
| `GET /api/directory/search?q=` | Autocomplete, max 6, case-insensitive on name+area. 2+ chars. |
| `POST /api/intelligence/scan` | Body `{ slug, avgSpend }`. Computes the full report synchronously (the 20-sec "scan" is client-side theatre), stores in `scans`, returns `{ scanId, restaurant, report }` with report fields the UI blurs until unlock. |
| `POST /api/leads` | Body `{ name, phone, email, multipleLocations, consent, scanId, source }`. Validates (name ≥ 2 chars, email regex, consent === true), inserts lead, sets `scans.unlockedBy`, returns `{ ok: true }`. Rate-limit: 10/min/IP. |
| `GET /api/intelligence/scan/:scanId` | Re-fetch a scan (report links are shareable/bookmarkable: `#intelligence/report/<scanId>`). Include `unlocked` boolean. |

### Report computation (deterministic, from seeded data — no external APIs in v1)

- `googleSearch` score: rating (40%) + log-scaled reviewCount (40%) +
  profile completeness (20%), 0–100.
- `websiteStrength`: from `attrs` (descriptionFilled, attributeCount,
  photoCount), 0–100.
- `aiVisibility`: seeded per-restaurant "found in K of 3 queries" — K/3 × 100
  with the 3 query strings templated from area + category.
- `onlineVisibility`: weighted mean of the other three (45/25/30).
- Competitor ranking: all directory docs in the same `area`, sorted by
  googleSearch score desc; subject's index = "Your position #i of N".
- Revenue projection: `extraGuests = round(reviewCount × 0.184)`
  (tune so a 1,871-review restaurant → ~344, matching the reference scale),
  `extraRevenue = extraGuests × avgSpend`, yearly ×12, footnote cites the
  implied growth %. Clamp to sane ranges.
- To-do list: 5 templated recommendations parameterized by the failing
  checklist rows + category + area keywords (v2 may swap in a Claude API
  call behind `ANTHROPIC_API_KEY` — leave a marked seam, not a dependency).

## 5. UI notes

- Scanning stage: 5 checklist items tick at 2.5–4 s intervals (CSS spinner →
  lavender check), progress bar `--grad`, "Email me report" opens the same
  gate modal with `source: "email-me-report"`.
- Score cards: reuse `.kpi` + the `data-count` counter animation; color the
  number by band (≥70 `--success`, 40–69 `--warning`, <40 `--danger`).
- Blur-gate: report sections below the fold get `filter: blur(6px);
  pointer-events: none` + the modal (reuse `.auth-card` styles) until
  `/api/leads` succeeds; then unblur with a `.reveal`-style transition.
- Competitor list rows: rank chip, name, star rating; "(You)" row uses
  `--primary-soft` background + `--primary` left bar (matches sidebar
  active-item convention).
- Print styles: `@media print` — hide nav/aurora/gate, white bg, so
  "report" is also a PDF via the browser. Add a "Download report" button
  that calls `window.print()`.
- Demo parity: with the API down, `#intelligence` still works from embedded
  fixture data for one sample restaurant (same fallback pattern as
  `RP_CONFIG`).

## 6. Acceptance criteria

1. `#intelligence` reachable from nav; search returns seeded restaurants.
2. Scan theatre runs ≤ 25 s; report renders all 7 sections.
3. Report is blurred until the gate form passes validation; submission
   creates a `leads` doc (verify in Atlas) and unblurs without reload.
4. `#intelligence/report/<scanId>` deep-link re-opens a stored report.
5. Demo login on `#login` writes a `login_events` doc (email + timestamp
   only) before the existing redirect.
6. No plaintext passwords anywhere; consent unchecked → submit disabled.
7. Works on Vercel production against Atlas; graceful 503 fallback intact.
8. Mobile (≤ 960 px): score cards 2-up, competitor list unchanged, modal
   full-width.

## 7. Explicitly out of scope (v1)

Google Places / live web scraping, real ChatGPT query testing, email
delivery of reports, auth-gated report history, multi-language. Each gets a
seam comment (`// SEAM:`) at its integration point.
