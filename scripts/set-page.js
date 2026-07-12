/* Upload or replace a full HTML page in MongoDB (`pages` collection).
   Usage:   npm run set-page -- <slug> <path-to-html> [title]
   Example: npm run set-page -- landing ./seed/pages/landing.html
   The stored page is served at  GET /pages/<slug>  (rendered from the DB),
   listed at  GET /api/pages,  and readable as JSON at  GET /api/pages/<slug>.
   If [title] is omitted, it's taken from the HTML's <title> tag. */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { connect } = require("../server/db");

function titleFromHtml(html, fallback) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim() : fallback;
}

async function main() {
  const [slug, file, ...titleParts] = process.argv.slice(2);
  if (!slug || !file) {
    console.error("Usage: npm run set-page -- <slug> <path-to-html> [title]");
    process.exit(1);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    console.error(`Invalid slug "${slug}". Use lowercase letters, numbers and hyphens.`);
    process.exit(1);
  }
  const ext = path.extname(file).toLowerCase();
  if (ext !== ".html" && ext !== ".htm") {
    console.error(`Expected an .html file, got "${ext}".`);
    process.exit(1);
  }
  const html = fs.readFileSync(file, "utf8");
  if (Buffer.byteLength(html) > 4 * 1024 * 1024) {
    console.error("HTML larger than 4 MB — that's unusually big for a page.");
    process.exit(1);
  }
  const title = titleParts.length ? titleParts.join(" ") : titleFromHtml(html, slug);

  const db = await connect();
  await db.collection("pages").createIndex({ slug: 1 }, { unique: true });
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
  console.log(`✓ page "${slug}" set from ${file} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB) — title: "${title}"`);
  console.log(`  view at /pages/${slug}`);
  process.exit(0);
}

main().catch(err => {
  console.error("Failed:", err.message);
  process.exit(1);
});
