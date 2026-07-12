require("dotenv").config();
const express = require("express");
const path = require("path");
const { connect } = require("./db");

const app = express();
const PORT = process.env.PORT || 3005;

/* ---------- Static landing page ---------- */
app.use(express.static(path.join(__dirname, "..", "public")));

/* ---------- API: plans + settings (MongoDB) ----------
   Response envelope matches RestroPulse convention: { success, data | error }.
   The page falls back to its embedded defaults if this endpoint is down. */
app.get("/api/config/plans", async (req, res) => {
  try {
    const db = await connect();
    const settings =
      (await db.collection("settings").findOne({ _id: "landing" })) || {};
    const plans = await db
      .collection("plans")
      .find({ active: { $ne: false } })
      .sort({ order: 1 })
      .project({ _id: 0 })
      .toArray();
    res.json({
      success: true,
      data: {
        currencySymbol: settings.currencySymbol || "₹",
        adminDemoUrl:
          settings.adminDemoUrl ||
          "https://bhargav465.github.io/restropulse-v2/admin-v2/",
        yearlyMonthsCharged: settings.yearlyMonthsCharged || 10,
        plans
      }
    });
  } catch (err) {
    res.status(503).json({ success: false, error: "Database unavailable" });
  }
});

/* ---------- API: images (MongoDB `assets` collection) ----------
   Documents: { key, contentType, data (base64), updatedAt } */
app.get("/api/assets/:key", async (req, res) => {
  try {
    const db = await connect();
    const asset = await db
      .collection("assets")
      .findOne({ key: req.params.key });
    if (!asset) return res.status(404).json({ success: false, error: "Not found" });
    res.set("Content-Type", asset.contentType || "application/octet-stream");
    res.set("Cache-Control", "public, max-age=300");
    res.send(Buffer.from(asset.data, "base64"));
  } catch (err) {
    res.status(503).json({ success: false, error: "Database unavailable" });
  }
});

app.get("/api/assets", async (req, res) => {
  try {
    const db = await connect();
    const keys = await db
      .collection("assets")
      .find({}, { projection: { _id: 0, key: 1, contentType: 1, updatedAt: 1 } })
      .toArray();
    res.json({ success: true, data: keys });
  } catch (err) {
    res.status(503).json({ success: false, error: "Database unavailable" });
  }
});

/* ---------- API: full HTML pages (MongoDB `pages` collection) ----------
   Documents: { slug, title, html, contentType, active, updatedAt }
   Serve a stored page rendered from the DB (human-facing). */
app.get("/pages/:slug", async (req, res) => {
  try {
    const db = await connect();
    const page = await db
      .collection("pages")
      .findOne({ slug: req.params.slug, active: { $ne: false } });
    if (!page) return res.status(404).type("text/plain").send("Page not found");
    res.set("Content-Type", page.contentType || "text/html; charset=utf-8");
    res.set("Cache-Control", "public, max-age=300");
    res.send(page.html);
  } catch (err) {
    res.status(503).type("text/plain").send("Database unavailable");
  }
});

/* List stored pages (metadata only — no html payload). */
app.get("/api/pages", async (req, res) => {
  try {
    const db = await connect();
    const pages = await db
      .collection("pages")
      .find(
        {},
        { projection: { _id: 0, slug: 1, title: 1, active: 1, updatedAt: 1 } }
      )
      .sort({ slug: 1 })
      .toArray();
    res.json({ success: true, data: pages });
  } catch (err) {
    res.status(503).json({ success: false, error: "Database unavailable" });
  }
});

/* One page as JSON (includes the html — for editing / programmatic use). */
app.get("/api/pages/:slug", async (req, res) => {
  try {
    const db = await connect();
    const page = await db
      .collection("pages")
      .findOne({ slug: req.params.slug }, { projection: { _id: 0 } });
    if (!page) return res.status(404).json({ success: false, error: "Not found" });
    res.json({ success: true, data: page });
  } catch (err) {
    res.status(503).json({ success: false, error: "Database unavailable" });
  }
});

/* Homepage fallback: if no static public/index.html was served (e.g. on a
   serverless host where only the DB is available), send visitors to the
   MongoDB-served landing page. Runs after express.static, so local dev that
   ships public/index.html is unaffected. */
app.get("/", (req, res) => {
  res.redirect(302, "/pages/landing");
});

/* Only listen when run directly (local dev / a normal server).
   On Vercel this module is imported by api/index.js and exported as the
   serverless handler, so we must NOT call listen there. */
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`RestroPulse landing page → http://localhost:${PORT}`);
    console.log(`MongoDB: ${process.env.MONGODB_URI || "mongodb://localhost:27017"} / ${process.env.DB_NAME || "restropulse_landing"}`);
  });
}

module.exports = app;
