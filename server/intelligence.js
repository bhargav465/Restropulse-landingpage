/* Restaurant Intelligence API (spec §4).
   Mounted by server/index.js; shares the same MongoDB connector and the
   { success, data | error } envelope. All computation is deterministic from
   the seeded `directory` corpus — no external APIs in v1 (see SEAM notes). */
const express = require("express");
const crypto = require("crypto");
const { connect } = require("./db");

const router = express.Router();

/* ---------- Report computation (deterministic) ----------
   Hand-computed fixtures (verify if you change the formulas):
   • Spice Garden (rating 4.3, 1871 reviews, desc✓, attr 9, photo 120, aiK 1):
       googleSearch ≈ 89, websiteStrength ≈ 85, aiVisibility 33,
       onlineVisibility ≈ 74, extraGuests round(1871*0.184)=344.
   • Curry Leaf (rating 3.6, 92 reviews, desc✓, attr 2, photo 8, aiK 0):
       googleSearch ≈ 44, websiteStrength ≈ 40, aiVisibility 0,
       onlineVisibility ≈ 32, extraGuests round(92*0.184)=17→clamped to 20. */

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function completeness01(attrs = {}) {
  const desc = attrs.descriptionFilled ? 1 : 0;
  const attr = Math.min((attrs.attributeCount || 0) / 12, 1);
  const photo = Math.min((attrs.photoCount || 0) / 150, 1);
  return desc * 0.34 + attr * 0.33 + photo * 0.33;
}

function googleSearchScore(r) {
  const ratingC = (r.rating / 5) * 40;
  const reviewC = Math.min(Math.log10((r.reviewCount || 0) + 1) / Math.log10(3000), 1) * 40;
  const completeC = completeness01(r.attrs) * 20;
  return Math.round(ratingC + reviewC + completeC);
}

function websiteStrengthScore(r) {
  return Math.round(completeness01(r.attrs) * 100);
}

function aiVisibilityScore(r) {
  return Math.round((clamp(r.aiFoundCount || 0, 0, 3) / 3) * 100);
}

function band(score) {
  return score >= 70 ? "good" : score >= 40 ? "warn" : "bad";
}

function buildReport(subject, areaDocs, avgSpendRaw) {
  const avgSpend = clamp(Math.round(avgSpendRaw || 500), 50, 5000);

  const googleSearch = googleSearchScore(subject);
  const websiteStrength = websiteStrengthScore(subject);
  const aiVisibility = aiVisibilityScore(subject);
  const onlineVisibility = Math.round(
    0.45 * googleSearch + 0.25 * aiVisibility + 0.30 * websiteStrength
  );

  // Competitor ranking: same area, by googleSearch desc.
  const ranked = areaDocs
    .map(r => ({
      slug: r.slug, name: r.name, rating: r.rating,
      reviewCount: r.reviewCount, score: googleSearchScore(r)
    }))
    .sort((a, b) => b.score - a.score || b.reviewCount - a.reviewCount);
  const position = ranked.findIndex(r => r.slug === subject.slug) + 1;
  const below = Math.max(0, position - 1);

  // Revenue projection (spec §4). extraGuests proxy from reviewCount.
  const extraGuests = clamp(Math.round((subject.reviewCount || 0) * 0.184), 20, 2000);
  const extraRevenueMonth = extraGuests * avgSpend;
  const extraRevenueYear = extraRevenueMonth * 12;
  // ASSUMPTION: implied growth % scales with the visibility gap (opportunity),
  // clamped to a conservative 8–35% band.
  const growthPct = clamp(Math.round((100 - googleSearch) * 0.35), 8, 35);

  // Profile checklist.
  const checklist = [
    { label: "Rating 4.0 or higher", pass: subject.rating >= 4.0 },
    { label: "At least 50 reviews", pass: (subject.reviewCount || 0) >= 50 },
    { label: "Description filled in", pass: !!(subject.attrs && subject.attrs.descriptionFilled) },
    { label: "Profile attributes added", pass: (subject.attrs && subject.attrs.attributeCount || 0) >= 5 }
  ];

  // AI visibility test — 3 templated local queries.
  const cat = subject.category || "restaurants";
  const area = subject.area || "your area";
  const queries = [
    `Best ${cat} in ${area}`,
    `Where to eat in ${area} for a date`,
    `Top rated restaurants in ${area}`
  ];
  const foundK = clamp(subject.aiFoundCount || 0, 0, 3);
  const aiQueries = queries.map((q, i) => ({ query: q, found: i < foundK }));
  const aiAvgPosition = foundK > 0 ? position : null;

  // To-do list — templated from the failing rows + category + area keywords.
  const topName = ranked[0] ? ranked[0].name : "the top-ranked spot";
  const todos = [];
  if (!checklist[0].pass)
    todos.push(`Launch a review-generation push — a steady stream of 5-star reviews is the fastest way to clear 4.0 and close the gap on ${topName}.`);
  if (!checklist[1].pass)
    todos.push(`Ask every guest for a Google review; you're under the 50-review line diners filter by in ${area}.`);
  if (!checklist[2].pass)
    todos.push(`Write a keyword-rich profile description featuring "${cat}" and "${area}" — it's blank today, so search and AI skip you.`);
  if (!checklist[3].pass)
    todos.push(`Fill in profile attributes (dine-in, delivery, outdoor seating, reservations) so you appear in filtered "${cat} in ${area}" searches.`);
  // Always-on, keyword-rich recommendations to pad to exactly 5.
  const filler = [
    `Post ${area}-specific dishes and fresh photos monthly so AI assistants surface you for "${cat} in ${area}".`,
    `Reply to every recent review within 24 hours — response rate is a ranking signal that ${topName} is already using.`,
    `Add your top 3 signature ${cat} dishes as menu highlights with photos to win the "best ${cat} in ${area}" query.`,
    `Publish accurate hours, price level, and booking links so first-time diners near ${area} convert instead of bouncing.`,
    `Run a monthly offer for ${area} regulars and feature it on your profile to lift repeat visits and fresh reviews.`
  ];
  for (const f of filler) { if (todos.length >= 5) break; todos.push(f); }
  const todoList = todos.slice(0, 5);

  return {
    scores: {
      onlineVisibility: { value: onlineVisibility, band: band(onlineVisibility) },
      googleSearch: { value: googleSearch, band: band(googleSearch) },
      aiVisibility: { value: aiVisibility, band: band(aiVisibility) },
      websiteStrength: { value: websiteStrength, band: band(websiteStrength) }
    },
    competitors: { position, total: ranked.length, below, ranking: ranked },
    revenue: {
      avgSpend, extraGuests,
      extraRevenueMonth, extraRevenueYear, growthPct
    },
    checklist,
    todos: todoList,
    ai: { queries: aiQueries, score: foundK, total: 3, avgPosition: aiAvgPosition }
  };
}

/* ---------- Simple in-memory rate limiter (best-effort on serverless).
   SEAM: swap for a durable store (Upstash/Mongo TTL) if abuse appears. */
const hits = new Map();
function rateLimited(ip, max = 10, windowMs = 60000) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < windowMs);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > max;
}
function clientIp(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket && req.socket.remoteAddress || "unknown";
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ---------- Routes ---------- */

// GET /api/directory/search?q=
router.get("/api/directory/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (q.length < 2) return res.json({ success: true, data: [] });
    const db = await connect();
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const rows = await db.collection("directory")
      .find({ $or: [{ name: rx }, { area: rx }] })
      .project({ _id: 0, slug: 1, name: 1, area: 1, city: 1, rating: 1, reviewCount: 1, category: 1, priceLevel: 1 })
      .limit(6)
      .toArray();
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(503).json({ success: false, error: "Database unavailable" });
  }
});

// POST /api/intelligence/scan  { slug, avgSpend }
router.post("/api/intelligence/scan", async (req, res) => {
  try {
    const { slug, avgSpend } = req.body || {};
    if (!slug) return res.status(400).json({ success: false, error: "slug required" });
    const db = await connect();
    const subject = await db.collection("directory").findOne({ slug });
    if (!subject) return res.status(404).json({ success: false, error: "Restaurant not found" });
    const areaDocs = await db.collection("directory").find({ area: subject.area }).toArray();
    const report = buildReport(subject, areaDocs, avgSpend);
    const scanId = crypto.randomUUID();
    const restaurant = {
      slug: subject.slug, name: subject.name, area: subject.area, city: subject.city,
      address: subject.address, rating: subject.rating, reviewCount: subject.reviewCount,
      category: subject.category, priceLevel: subject.priceLevel, description: subject.description
    };
    await db.collection("scans").insertOne({
      scanId, restaurantSlug: subject.slug, avgSpend: report.revenue.avgSpend,
      status: "done", report, restaurant, createdAt: new Date()
    });
    res.json({ success: true, data: { scanId, restaurant, report } });
  } catch (err) {
    res.status(503).json({ success: false, error: "Database unavailable" });
  }
});

// GET /api/intelligence/scan/:scanId
router.get("/api/intelligence/scan/:scanId", async (req, res) => {
  try {
    const db = await connect();
    const scan = await db.collection("scans").findOne(
      { scanId: req.params.scanId },
      { projection: { _id: 0 } }
    );
    if (!scan) return res.status(404).json({ success: false, error: "Scan not found" });
    res.json({
      success: true,
      data: {
        scanId: scan.scanId, restaurant: scan.restaurant, report: scan.report,
        unlocked: !!scan.unlockedBy
      }
    });
  } catch (err) {
    res.status(503).json({ success: false, error: "Database unavailable" });
  }
});

// POST /api/leads  { name, phone, email, multipleLocations, consent, scanId, source }
router.post("/api/leads", async (req, res) => {
  try {
    if (rateLimited(clientIp(req)))
      return res.status(429).json({ success: false, error: "Too many requests, try again shortly" });
    const b = req.body || {};
    const name = (b.name || "").trim();
    const email = (b.email || "").trim();
    if (name.length < 2) return res.status(422).json({ success: false, error: "Name is required" });
    if (!EMAIL_RE.test(email)) return res.status(422).json({ success: false, error: "A valid email is required" });
    if (b.consent !== true) return res.status(422).json({ success: false, error: "Consent is required" });

    const db = await connect();
    const leadId = crypto.randomUUID();
    // NOTE: never store passwords. Leads = identity + contact only.
    await db.collection("leads").insertOne({
      leadId, name, phone: (b.phone || "").trim(), email,
      multipleLocations: !!b.multipleLocations, consent: true,
      scanId: b.scanId || null, restaurantSlug: b.restaurantSlug || null,
      source: b.source === "email-me-report" ? "email-me-report" : "intelligence-gate",
      createdAt: new Date(),
      ip: clientIp(req), userAgent: (req.headers["user-agent"] || "").slice(0, 300)
    });
    if (b.scanId) {
      await db.collection("scans").updateOne({ scanId: b.scanId }, { $set: { unlockedBy: leadId } });
    }
    res.json({ success: true, data: { ok: true } });
  } catch (err) {
    res.status(503).json({ success: false, error: "Database unavailable" });
  }
});

// POST /api/events/login  { email }  — email + timestamp only. No passwords.
router.post("/api/events/login", async (req, res) => {
  try {
    const email = ((req.body && req.body.email) || "").trim();
    if (!EMAIL_RE.test(email)) return res.status(422).json({ success: false, error: "email required" });
    const db = await connect();
    await db.collection("login_events").insertOne({
      email, at: new Date(), page: "login", success: true
    });
    res.json({ success: true, data: { ok: true } });
  } catch (err) {
    res.status(503).json({ success: false, error: "Database unavailable" });
  }
});

module.exports = { router, buildReport };
