/* Upload or replace an image in MongoDB.
   Usage: npm run set-asset -- <key> <path-to-image>
   Example: npm run set-asset -- dashboard ./screenshots/admin-v2.png
   Keys used by the page: dashboard, pillar-content, pillar-ordering, pillar-growth
   (You can add new keys and reference them with <img data-asset="your-key">.) */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { connect } = require("../server/db");

const TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".gif": "image/gif"
};

async function main() {
  const [key, file] = process.argv.slice(2);
  if (!key || !file) {
    console.error("Usage: npm run set-asset -- <key> <path-to-image>");
    process.exit(1);
  }
  const ext = path.extname(file).toLowerCase();
  const contentType = TYPES[ext];
  if (!contentType) {
    console.error(`Unsupported extension "${ext}". Use: ${Object.keys(TYPES).join(", ")}`);
    process.exit(1);
  }
  const buf = fs.readFileSync(file);
  if (buf.length > 8 * 1024 * 1024) {
    console.error("Image larger than 8 MB — please compress it first.");
    process.exit(1);
  }
  const db = await connect();
  await db.collection("assets").updateOne(
    { key },
    {
      $set: {
        key,
        contentType,
        data: buf.toString("base64"),
        sample: false,
        updatedAt: new Date()
      }
    },
    { upsert: true }
  );
  console.log(`✓ asset "${key}" set from ${file} (${(buf.length / 1024).toFixed(1)} KB, ${contentType})`);
  process.exit(0);
}

main().catch(err => {
  console.error("Failed:", err.message);
  process.exit(1);
});
