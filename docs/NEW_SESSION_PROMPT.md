# New session prompt — paste this to start the build

---

You are working on `bhargav465/Restropulse-landingpage` — the RestroPulse
marketing site (Express + MongoDB Atlas `restropulse-dev`, page HTML served
from the `pages` collection, deployed on Vercel at
https://restropulse-landingpage.vercel.app).

Task: implement the **Restaurant Intelligence scanner** exactly as specified
in `docs/INTELLIGENCE_SPEC.md`, following the ordered runbook in
`docs/APPLY_INSTRUCTIONS.md`. Read both files fully before writing any code,
and read the repo README for the existing MongoDB conventions.

Non-negotiables:

1. Follow APPLY_INSTRUCTIONS step 0 (pre-flight) first — merge PR #1, fresh
   clone, branch `feat/intelligence-scanner`, rotate the Atlas password,
   tighten network access.
2. Additive only: `#home`, `#pricing`, `#login`, and all existing API routes
   keep working. The page must keep its API-down fallback behavior.
3. Electric Lavender design tokens only — no raw hex, no colors copied from
   the Sous reference site. Reuse the existing primitives (aurora, reveal,
   kpi cards, buttons, auth-card modal).
4. Never store passwords or any plaintext credential. Leads = name, phone,
   email, consent. Login events = email + timestamp only. Consent checkbox
   required before the gate submits.
5. Sample data is `[SAMPLE]`-marked and lives only in `seed/`.
6. Every commit passes the gates in APPLY_INSTRUCTIONS §4; conventional
   commits; label uncertainty `ASSUMPTION:` and ask the owner on product
   ambiguity instead of guessing.

Definition of done: all 8 acceptance criteria in INTELLIGENCE_SPEC §6 pass
on the live Vercel deployment, one end-to-end test lead verified in Atlas
and then deleted, docs updated per APPLY_INSTRUCTIONS §5.

---
