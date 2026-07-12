/* Seeds MongoDB with landing-page data:
     settings  — currency, demo URL, yearly discount
     plans     — one document per pricing plan
     assets    — [SAMPLE] placeholder images (skipped if a real one exists)
   Run: npm run seed  (requires MONGODB_URI in .env or env) */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { connect } = require("../server/db");

/* [SAMPLE] lavender placeholder SVG so the image pipeline works out of the box.
   Replace with real photos via: npm run set-asset -- <key> <file> */
function placeholderSvg(label) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#9D4EDD"/><stop offset=".55" stop-color="#B57EDC"/><stop offset="1" stop-color="#8B9CF7"/>
  </linearGradient></defs>
  <rect width="640" height="360" fill="url(#g)"/>
  <text x="320" y="180" font-family="sans-serif" font-size="26" font-weight="600"
        fill="#FFFFFF" text-anchor="middle" dominant-baseline="middle">${label} [SAMPLE]</text>
</svg>`;
  return Buffer.from(svg).toString("base64");
}

const SAMPLE_ASSETS = [
  { key: "pillar-content", label: "Content Engine" },
  { key: "pillar-ordering", label: "Online Ordering" },
  { key: "pillar-growth", label: "Growth & CRM" }
  /* "dashboard" intentionally not seeded — upload a real admin screenshot:
     npm run set-asset -- dashboard ./dashboard.png */
];

async function main() {
  const db = await connect();
  const { settings, plans } = JSON.parse(
    fs.readFileSync(path.join(__dirname, "plans.json"), "utf8")
  );

  // settings (single doc)
  await db.collection("settings").updateOne(
    { _id: "landing" },
    { $set: { ...settings, updatedAt: new Date() } },
    { upsert: true }
  );
  console.log("✓ settings upserted");

  // plans (upsert by id, keep _id stable)
  for (const p of plans) {
    await db.collection("plans").updateOne(
      { id: p.id },
      { $set: { ...p, updatedAt: new Date() } },
      { upsert: true }
    );
  }
  await db.collection("plans").createIndex({ id: 1 }, { unique: true });
  await db.collection("plans").createIndex({ order: 1 });
  console.log(`✓ ${plans.length} plans upserted`);

  // sample assets — never overwrite a real upload
  await db.collection("assets").createIndex({ key: 1 }, { unique: true });
  for (const a of SAMPLE_ASSETS) {
    const existing = await db.collection("assets").findOne({ key: a.key });
    if (existing && !existing.sample) {
      console.log(`- ${a.key}: real asset exists, skipped`);
      continue;
    }
    await db.collection("assets").updateOne(
      { key: a.key },
      {
        $set: {
          key: a.key,
          contentType: "image/svg+xml",
          data: placeholderSvg(a.label),
          sample: true,
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );
    console.log(`✓ asset ${a.key} seeded ([SAMPLE] placeholder)`);
  }

  // pages — every HTML file in seed/pages/ becomes a `pages` document.
  // Slug = filename without extension; title = <title> tag (or slug).
  const pagesDir = path.join(__dirname, "pages");
  if (fs.existsSync(pagesDir)) {
    await db.collection("pages").createIndex({ slug: 1 }, { unique: true });
    const files = fs.readdirSync(pagesDir).filter(f => /\.html?$/i.test(f));
    for (const f of files) {
      const slug = f.replace(/\.html?$/i, "");
      const html = fs.readFileSync(path.join(pagesDir, f), "utf8");
      const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = m ? m[1].trim() : slug;
      await db.collection("pages").updateOne(
        { slug },
        {
          $set: {
            slug,
            title,
            html,
            contentType: "text/html; charset=utf-8",
            active: true,
            updatedAt: new Date()
          }
        },
        { upsert: true }
      );
      console.log(`✓ page "${slug}" seeded from seed/pages/${f} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB) → /pages/${slug}`);
    }
  }

  console.log("Done.");
  process.exit(0);
}

main().catch(err => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
