# RestroPulse — Landing Page

Marketing site for RestroPulse (landing + pricing + login), with **plans and
images served from MongoDB** so content changes never require a code deploy.

Built on the RestroPulse Electric Lavender design system.

## How it works

```
public/index.html   The whole site (single file). Paints instantly with
                    embedded defaults, then hydrates from the API.
server/index.js     Express: serves the page + two API routes.
server/db.js        MongoDB connection (MONGODB_URI).
seed/plans.json     Editable source of truth for plans & settings.
seed/seed.js        Writes plans.json + sample images into MongoDB.
scripts/set-asset.js  Upload/replace any image in MongoDB.
```

MongoDB collections:

| Collection | Contents |
|---|---|
| `settings` | One doc (`_id: "landing"`): currency symbol, demo URL, yearly discount |
| `plans` | One doc per pricing plan (`id`, `name`, `monthlyPrice`, `features[]`, `order`, `active`, `featured`, `badge`) |
| `assets` | One doc per image (`key`, `contentType`, `data` base64) |
| `pages` | One doc per full HTML page (`slug`, `title`, `html`, `contentType`, `active`) — a whole page served straight from the DB |

API:

- `GET /api/config/plans` → `{ success, data: { currencySymbol, adminDemoUrl, yearlyMonthsCharged, plans } }`
- `GET /api/assets/:key` → the image binary
- `GET /api/assets` → list of stored image keys
- `GET /pages/:slug` → renders a full HTML page stored in MongoDB
- `GET /api/pages` → list of stored pages (metadata, no html)
- `GET /api/pages/:slug` → one page as JSON (includes `html`, for editing)

If MongoDB is down (or the file is opened directly), the page silently falls
back to the defaults embedded in `index.html` — it never breaks.

## Run it

```bash
npm install
cp .env.example .env        # set MONGODB_URI (local or Atlas)
npm run seed                # load plans + sample images into MongoDB
npm start                   # http://localhost:3005
```

## Making changes (no code needed)

**Change a price / plan feature** — either:
- Edit directly in MongoDB Compass / Atlas UI (`plans` collection), refresh the page; or
- Edit `seed/plans.json` and run `npm run seed` (upserts, safe to re-run).

**Hide a plan**: set `active: false`. **Reorder**: change `order`.
**Change the yearly discount**: `settings.yearlyMonthsCharged` (10 = pay 10 months, get 12).

**Change / add images**:

```bash
npm run set-asset -- dashboard ./screenshots/admin-v2.png
npm run set-asset -- pillar-content ./photos/content.jpg
```

Image slots the page already uses:

| Key | Where it appears |
|---|---|
| `dashboard` | Replaces the CSS dashboard mock in the hero (upload a real admin-v2 screenshot) |
| `pillar-content` | Top of the Content Engine card |
| `pillar-ordering` | Top of the Online Ordering card |
| `pillar-growth` | Top of the Growth & CRM card |

Slots are optional — if a key has no image in MongoDB, the page keeps its
default look. To add a new slot, add `<img data-asset="your-key">` in
`index.html` and upload with `set-asset`.

**Store a whole HTML page in MongoDB** — a complete document served straight
from the DB at `/pages/<slug>` (no code deploy to change it):

```bash
# any .html file → a `pages` document (slug + title auto-derived)
npm run set-page -- landing ./seed/pages/landing.html
# then open http://localhost:3005/pages/landing
```

Every `.html` file dropped in `seed/pages/` is also loaded by `npm run seed`
(slug = filename, title = its `<title>` tag). `seed/pages/landing.html` ships
by default. Hide a page with `active: false`; re-uploading the same slug
replaces it.

**Change copy/headlines**: edit `public/index.html` (plain HTML).
**Change colors**: the CSS variables at the top of `index.html`
(Electric Lavender tokens — keep in sync with `apps/web/components/v2/theme.ts`).

## Demo login

The login form accepts any email/password and opens the live admin demo
(`settings.adminDemoUrl`). To wire real auth later, point the form at
`POST /api/auth/login` on the main RestroPulse API.
