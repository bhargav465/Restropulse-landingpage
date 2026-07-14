/* RestroGrade deep-analysis pipeline — ported from
   bhargav465/RESTROGRADECLAUSDETEST (app/api/analyze/route.ts) into our
   Express/Node stack.

   Real data sources:
     - Google Places API (New) v1  (GOOGLE_MAPS_API_KEY) — base restaurant
       details + up to 60 nearby competitors within 7km.
     - Anthropic Claude (ANTHROPIC_API_KEY) — strategic analysis + competitor
       enhancements + cuisine classification (one call), and Swiggy/Zomato
       delivery-benchmark estimates (a second, optional call).

   Model policy (see claude-api skill): default to claude-opus-4-8 with adaptive
   thinking. The source used sonnet/haiku; to cut per-scan cost you can lower
   ANALYSIS_MODEL / BENCHMARK_MODEL below to "claude-sonnet-5" / "claude-haiku-4-5".

   Produces the exact `finalData` report shape RestroGrade stores. Persisted to
   the `reports` collection; no auth/subscription logic (anonymous reports). */

const crypto = require("crypto");
const Anthropic = require("@anthropic-ai/sdk");
const { connect } = require("./db");

// Owner choice: Opus 4.6 (adaptive thinking) does the heavy strategic analysis;
// Sonnet 5 writes the lighter Swiggy/Zomato benchmark. Override via env.
const ANALYSIS_MODEL = process.env.RESTROGRADE_ANALYSIS_MODEL || "claude-opus-4-6";
const BENCHMARK_MODEL = process.env.RESTROGRADE_BENCHMARK_MODEL || "claude-sonnet-5";

function getAnthropic() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}
function getGoogleKey() {
  return process.env.GOOGLE_MAPS_API_KEY;
}

/* Stage-labeled error carrying a user-safe message + HTTP status. */
class StageError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "StageError";
    this.status = status;
  }
}

/* Robust LLM-JSON parser: extract the outermost {...} and escape raw control
   chars inside string literals (LLMs frequently emit unescaped newlines). */
function parseLlmJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new StageError("AI returned no JSON — please try again.", 502);
  const s = m[0];
  let out = "", inStr = false, esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) { esc = false; out += ch; continue; }
      if (ch === "\\") { esc = true; out += ch; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { out += "\\r"; continue; }
      if (ch === "\t") { out += "\\t"; continue; }
      out += ch;
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  try { return JSON.parse(out); }
  catch { throw new StageError("AI response was malformed (possibly truncated) — please try again.", 502); }
}

/* Tolerant name lookup for AI-returned maps keyed by restaurant name. */
function buildNameLookup(map) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const normalized = {};
  for (const [k, v] of Object.entries(map || {})) normalized[norm(k)] = v;
  return name => (map && map[name]) != null ? map[name] : normalized[norm(name)];
}

function getDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

const EXCLUDED_TYPES = ["lodging", "hotel", "motel", "campground", "rv_park"];
const EXCLUDED_NAME_PATTERN = /\b(lodge|lodging|hotel|motel|resort|inn|hostel|dharamshala|guest\s*house|paying\s*guest|pg)\b/i;

// Threat Score: Rating (40%) + Review volume (30%) + Proximity (30%) = max 100
function calculateThreatScore(rating, totalRatings, distanceKm) {
  const ratingScore = (rating / 5) * 40;
  const reviewScore = Math.min(30, (Math.log10(Math.max(1, totalRatings)) / 4) * 30);
  const proximityScore = Math.max(0, 30 * (1 - distanceKm / 7));
  return Math.min(100, Math.round(ratingScore + reviewScore + proximityScore));
}

// Same-cuisine threat: Proximity (35) + Rating (25) + Reviews (20) + Cuisine match (20)
function calculateSameCuisineThreatScore(rating, totalRatings, distanceKm, isSameCuisine) {
  const proximityScore = distanceKm <= 0.5 ? 35 : distanceKm <= 1 ? 32 : distanceKm <= 2 ? 27 :
    distanceKm <= 3 ? 20 : distanceKm <= 5 ? 12 : Math.max(0, 5 - distanceKm);
  const ratingScore = (rating / 5) * 25;
  const reviewScore = Math.min(20, (Math.log10(Math.max(1, totalRatings)) / 4) * 20);
  const cuisineBonus = isSameCuisine ? 20 : 0;
  return Math.min(100, Math.round(proximityScore + ratingScore + reviewScore + cuisineBonus));
}

/* ---------- Places API (New) helpers ---------- */
const PLACES_SEARCH_FIELDS = [
  "places.id", "places.displayName", "places.shortFormattedAddress", "places.rating",
  "places.userRatingCount", "places.location", "places.types", "places.priceLevel", "places.photos",
].join(",");

const PRICE_LEVEL_MAP = {
  PRICE_LEVEL_FREE: 0, PRICE_LEVEL_INEXPENSIVE: 1, PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3, PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

async function placesTextSearch(body, fieldMask) {
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": getGoogleKey(),
      "X-Goog-FieldMask": fieldMask,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    if (res.status === 403) {
      throw new StageError('Places API (New) request denied — enable "Places API (New)" on the Google Cloud project and allow it on the GOOGLE_MAPS_API_KEY.', 503);
    }
    throw new StageError(`Restaurant search failed (Places API: ${(data && data.error && data.error.status) || res.status}).`, 502);
  }
  return data;
}

function toLegacyPlace(p) {
  return {
    name: (p.displayName && p.displayName.text) || "",
    vicinity: p.shortFormattedAddress || "",
    rating: p.rating || 0,
    user_ratings_total: p.userRatingCount || 0,
    geometry: { location: { lat: (p.location && p.location.latitude) || 0, lng: (p.location && p.location.longitude) || 0 } },
    types: p.types || [],
    price_level: PRICE_LEVEL_MAP[p.priceLevel] != null ? PRICE_LEVEL_MAP[p.priceLevel] : 0,
    photos: p.photos || [],
  };
}

async function getCoordinates(address) {
  const data = await placesTextSearch({ textQuery: address, pageSize: 1 }, "places.location");
  const loc = data.places && data.places[0] && data.places[0].location;
  if (!loc) throw new StageError(`Could not locate "${address}" on Google Maps. Please check the restaurant name and city.`, 502);
  return { lat: loc.latitude, lng: loc.longitude };
}

async function getNearbyRestaurants(lat, lng) {
  const radius = 7000;
  const allResults = [];
  let pageToken;
  for (let page = 0; page < 3; page++) {
    const body = {
      textQuery: "restaurants", includedType: "restaurant", pageSize: 20,
      locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius } },
    };
    if (pageToken) body.pageToken = pageToken;
    const data = await placesTextSearch(body, `${PLACES_SEARCH_FIELDS},nextPageToken`);
    allResults.push(...(data.places || []).map(toLegacyPlace));
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return allResults;
}

async function getBaseRestaurantDetails(name, city) {
  const findData = await placesTextSearch(
    { textQuery: `${name}, ${city}`, pageSize: 1 },
    "places.id,places.displayName,places.rating,places.userRatingCount,places.location"
  ).catch(() => null);

  const found = findData && findData.places && findData.places[0];
  if (!found || !found.id) return null;

  const location = found.location ? { lat: found.location.latitude, lng: found.location.longitude } : undefined;

  const detailRes = await fetch(`https://places.googleapis.com/v1/places/${found.id}`, {
    headers: {
      "X-Goog-Api-Key": getGoogleKey(),
      "X-Goog-FieldMask": "displayName,rating,userRatingCount,websiteUri,googleMapsUri,nationalPhoneNumber,regularOpeningHours,photos,reviews,editorialSummary,businessStatus,formattedAddress,addressComponents",
    },
  });
  const d = detailRes.ok ? await detailRes.json() : null;

  if (!d) {
    return {
      name: (found.displayName && found.displayName.text) || name,
      rating: found.rating || 0, totalRatings: found.userRatingCount || 0,
      website: null, phone: null, hasHours: false, hoursText: null, photoCount: 0, ownerPhotoCount: 0,
      hasMenu: false, reviewCount: found.userRatingCount || 0, recentReviews: [],
      ownerRespondsToReviews: false, businessStatus: "OPERATIONAL", location,
    };
  }

  const addressComponents = d.addressComponents || [];
  const byType = t => (addressComponents.find(c => (c.types || []).includes(t)) || {}).longText;
  const zone = byType("sublocality_level_1") || byType("sublocality") || byType("neighborhood") || byType("locality") || null;

  const recentReviews = (d.reviews || []).slice(0, 5);
  const ownerResponds = recentReviews.length > 0;

  return {
    name: (d.displayName && d.displayName.text) || (found.displayName && found.displayName.text) || name,
    rating: d.rating || 0, totalRatings: d.userRatingCount || 0,
    website: d.websiteUri || null, phone: d.nationalPhoneNumber || null,
    hasHours: !!(d.regularOpeningHours && d.regularOpeningHours.weekdayDescriptions && d.regularOpeningHours.weekdayDescriptions.length),
    hoursText: (d.regularOpeningHours && d.regularOpeningHours.weekdayDescriptions) || null,
    photoCount: (d.photos && d.photos.length) || 0, ownerPhotoCount: 0,
    hasMenu: !!(d.websiteUri || d.googleMapsUri), reviewCount: d.userRatingCount || 0,
    recentReviews: recentReviews.map(r => ({ rating: r.rating, text: r.text && r.text.text && r.text.text.substring(0, 200), time: r.relativePublishTimeDescription })),
    ownerRespondsToReviews: ownerResponds, businessStatus: d.businessStatus || "OPERATIONAL",
    editorialSummary: (d.editorialSummary && d.editorialSummary.text) || null, location,
    googleUrl: d.googleMapsUri || null, zone, formattedAddress: d.formattedAddress || null,
  };
}

async function fetchWebsiteSEO(websiteUrl, restaurantName, city) {
  const defaultChecks = {
    domain: { usingCustomDomain: { pass: false, note: "No website found" }, cleanUrl: { pass: false, note: "No website to check" } },
    headline: { exists: { pass: false, note: "No website to check" }, includesServiceArea: { pass: false, note: "No website to check" }, includesKeywords: { pass: false, note: "No website to check" } },
    metadata: { descriptionExists: { pass: false, note: "No meta description found" }, descriptionLength: { pass: false, note: "No meta description found" }, descriptionIncludesArea: { pass: false, note: "No meta description found" } },
    websiteUrl,
  };
  if (!websiteUrl) return defaultChecks;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(websiteUrl, { signal: controller.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; RestoRankBot/1.0)" } });
    clearTimeout(timeout);
    if (!res.ok) return defaultChecks;
    const html = await res.text();
    const htmlLower = html.toLowerCase();
    let hostname = "";
    try { hostname = new URL(websiteUrl).hostname; } catch (e) {}
    const thirdPartyDomains = ["zomato.com", "swiggy.com", "yelp.com", "facebook.com", "instagram.com", "tripadvisor.com", "justdial.com", "google.com"];
    const isCustomDomain = !thirdPartyDomains.some(dn => hostname.includes(dn));
    const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const h1Text = h1Match ? h1Match[1].replace(/<[^>]+>/g, "").trim() : "";
    const cityLower = city.toLowerCase();
    const nameLower = restaurantName.toLowerCase();
    const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
    const metaDesc = descMatch ? descMatch[1].trim() : "";
    return {
      domain: {
        usingCustomDomain: { pass: isCustomDomain, note: isCustomDomain ? `Custom domain: ${hostname}` : `Using third-party: ${hostname}` },
        cleanUrl: { pass: !websiteUrl.includes("?") && !websiteUrl.includes("#") && websiteUrl.length < 80, note: websiteUrl.length < 80 ? "Clean, short URL" : "URL could be shorter and cleaner" },
      },
      headline: {
        exists: { pass: !!h1Text, note: h1Text ? `H1 found: "${h1Text.substring(0, 60)}${h1Text.length > 60 ? "..." : ""}"` : "No H1 headline found on homepage" },
        includesServiceArea: { pass: h1Text.toLowerCase().includes(cityLower), note: h1Text.toLowerCase().includes(cityLower) ? `H1 includes "${city}"` : `H1 does not mention "${city}" — add your city for local SEO` },
        includesKeywords: { pass: h1Text.toLowerCase().includes(nameLower) || htmlLower.includes(nameLower), note: h1Text.toLowerCase().includes(nameLower) ? "Brand name found in H1" : "Consider adding your brand name to the H1" },
      },
      metadata: {
        descriptionExists: { pass: !!metaDesc, note: metaDesc ? `Meta description found (${metaDesc.length} chars)` : "No meta description — add one for better search results" },
        descriptionLength: { pass: metaDesc.length >= 120 && metaDesc.length <= 160, note: metaDesc.length >= 120 && metaDesc.length <= 160 ? "Description length is optimal (120-160 chars)" : metaDesc.length > 0 ? `Description is ${metaDesc.length} chars — aim for 120-160 chars` : "No description to check" },
        descriptionIncludesArea: { pass: metaDesc.toLowerCase().includes(cityLower), note: metaDesc.toLowerCase().includes(cityLower) ? `Description includes "${city}"` : `Description doesn't mention "${city}" — add it for local search` },
      },
      websiteUrl,
    };
  } catch (e) { return defaultChecks; }
}

/* Run a Claude call with adaptive thinking, streaming; return the text block. */
async function claudeJson(model, maxTokens, system, userContent, useThinking) {
  const client = getAnthropic();
  const params = { model, max_tokens: maxTokens, system, messages: [{ role: "user", content: userContent }] };
  if (useThinking) params.thinking = { type: "adaptive" };
  const stream = client.messages.stream(params);
  const msg = await stream.finalMessage();
  const textBlock = msg.content.find(b => b.type === "text");
  return textBlock ? textBlock.text : "{}";
}

/* ---------- Main pipeline ---------- */
async function analyze(name, city) {
  if (!process.env.GOOGLE_MAPS_API_KEY) throw new StageError("Maps service not configured — set GOOGLE_MAPS_API_KEY.", 503);
  if (!process.env.ANTHROPIC_API_KEY) throw new StageError("AI service not configured — set ANTHROPIC_API_KEY.", 503);

  const baseDetails = await getBaseRestaurantDetails(name, city);
  let baseLocation;
  if (baseDetails && baseDetails.location) baseLocation = baseDetails.location;
  else { try { baseLocation = await getCoordinates(`${name}, ${city}`); } catch (e) { baseLocation = await getCoordinates(city); } }

  const places = await getNearbyRestaurants(baseLocation.lat, baseLocation.lng);
  if (!places || places.length === 0) throw new StageError("No restaurants found near this location. Please check the restaurant name and city.", 400);

  const filteredPlaces = places.filter(place => {
    const types = place.types || [];
    const placeName = place.name || "";
    if (types.some(t => EXCLUDED_TYPES.includes(t))) return false;
    if (EXCLUDED_NAME_PATTERN.test(placeName)) return false;
    return true;
  });
  if (filteredPlaces.length === 0) throw new StageError("No restaurants found near this location (only lodges/hotels were found).", 400);

  const mapped = filteredPlaces.map(place => {
    const distance = getDistanceKm(baseLocation.lat, baseLocation.lng, place.geometry.location.lat, place.geometry.location.lng);
    const placeTypes = place.types || [];
    const threatScore = calculateThreatScore(place.rating || 0, place.user_ratings_total || 0, distance);
    return {
      name: place.name, address: place.vicinity, rating: place.rating || 0, totalRatings: place.user_ratings_total || 0,
      distanceKm: Number(distance.toFixed(2)), lat: place.geometry.location.lat, lng: place.geometry.location.lng,
      cuisine: placeTypes.filter(t => !["point_of_interest", "establishment"].includes(t)).slice(0, 3),
      foodCuisine: "Multi-cuisine", averagePrice: place.price_level ? place.price_level * 200 : 400,
      threatScore, sameCuisineThreatScore: 0, photoCount: (place.photos && place.photos.length) || 0, priceLevel: place.price_level || 0,
    };
  });

  const topCompetitors = [...mapped].sort((a, b) => b.threatScore - a.threatScore).slice(0, 5);
  const newHighRatedRestaurants = mapped.filter(r => r.rating > 3.5 && r.totalRatings < 120).slice(0, 5);
  const within5km = mapped.filter(r => r.distanceKm <= 5);

  const seoPromise = fetchWebsiteSEO((baseDetails && baseDetails.website) || null, name, city);

  // ---- AI ANALYSIS (strategic report + competitor enhancements + cuisine classification) ----
  const aiText = await claudeJson(
    ANALYSIS_MODEL, 16000,
    "You are a senior restaurant competitive intelligence strategist with 15+ years of experience in the Indian food & beverage market. You write detailed, highly specific, and actionable analyses that restaurant owners can immediately act on. Every insight must be tied to actual data provided. Respond with raw valid JSON only — no markdown fences, no commentary. Inside JSON string values, write line breaks as the two characters \\n, never raw line breaks.",
    `
Analyze the competitive landscape for a restaurant and produce a comprehensive intelligence report.

Restaurant: ${name}
City: ${city}

Top Competitors (with their data):
${JSON.stringify(topCompetitors)}

All nearby restaurants within 5km (for cuisine classification):
${JSON.stringify(within5km.map(r => ({ name: r.name, rating: r.rating, reviews: r.totalRatings })))}

Return STRICT JSON with these fields:

{
  "baseRestaurantCuisine": "The PRIMARY food cuisine type of ${name} - e.g. Biryani, North Indian, South Indian, Chinese, Pizza, Italian, Cafe, Fast Food, etc.",
  "executiveSummary": {
    "overview": "A 3-4 sentence high-level overview of the competitive landscape.",
    "keyFindings": ["6 specific data-backed findings — each referencing actual competitor data"],
    "immediateThreats": "2-3 sentences naming specific competitors and why they are a threat right now.",
    "growthOpportunities": "2-3 sentences about the biggest untapped opportunities.",
    "recommendation": "A clear, prioritized 2-3 sentence recommendation.",
    "actionPlan": [
      { "priority": 1, "action": "Specific action title", "detail": "2-3 sentences on exactly what to do and how", "impact": "High/Medium/Low", "timeframe": "Immediate/1-2 weeks/1 month/3 months" }
    ]
  },
  "finalStrategicVerdict": "3-4 paragraphs covering position/risks, biggest opportunity, operational improvements, and a 90-day roadmap.",
  "yourKeywordCluster": {
    "primary": ["8-10 primary SEO/brand keywords for ${name} in ${city}"],
    "positive": ["8-10 positive sentiment keywords"],
    "negative": ["6-8 negative keywords to monitor"],
    "longTail": ["8-10 long-tail phrases (4-6 words)"],
    "trending": ["6-8 trending keywords in ${city}"],
    "competitor": ["6-8 keywords competitors rank for that ${name} should target"]
  },
  "competitorKeywordClusters": [ { "restaurant": "competitor name", "keywords": ["8-10 keywords"] } ],
  "competitorEnhancements": [
    {
      "restaurant": "competitor name",
      "strengths": ["5 specific strengths based on their rating/review data"],
      "weaknesses": ["5 specific weaknesses ${name} can exploit"],
      "sentimentLabel": "Positive/Negative/Mixed",
      "sentimentScore": 0.0,
      "whatTheyDoBetter": ["4-5 specific things this competitor outperforms ${name} on"],
      "whereYouWin": ["4-5 specific areas where ${name} has or can build an advantage"],
      "pricingInsight": "1-2 sentences on their likely pricing tier vs ${name}",
      "marketingEdge": "1-2 sentences on their marketing angle or owned segment"
    }
  ],
  "cuisineClassification": { "restaurant name 1": "Biryani", "restaurant name 2": "Pizza" }
}

CRITICAL RULES for cuisineClassification:
- Classify EVERY restaurant from the "nearby restaurants within 5km" list above, using the EXACT name as the key.
- Use SPECIFIC food cuisine types (Biryani, North Indian, South Indian, Chinese, Pizza, Italian, Continental, Mughlai, Tandoori, Cafe/Coffee, Fast Food, Burger, Street Food, Seafood, Bakery/Desserts, Japanese, Thai, Korean, Mexican, Arabian/Lebanese, Ice Cream, Multi-cuisine, Vegetarian, BBQ/Grill, Kebab). Never generic labels.
OTHER RULES:
- actionPlan exactly 5 items ordered by priority; keyFindings exactly 6 items; every insight names actual restaurants; finalStrategicVerdict is 3-4 paragraphs.
`,
    false // adaptive thinking OFF (owner choice) — analysis is grounded in the Google data, keeps scans ~40-70s
  );
  const aiParsed = parseLlmJson(aiText);

  const cuisineMap = aiParsed.cuisineClassification || {};
  const lookupCuisine = buildNameLookup(cuisineMap);
  const baseRestaurantCuisine = aiParsed.baseRestaurantCuisine || "Multi-cuisine";

  mapped.forEach(r => { r.foodCuisine = lookupCuisine(r.name) || "Multi-cuisine"; });
  mapped.forEach(r => {
    const isSameCuisine = r.foodCuisine.toLowerCase() === baseRestaurantCuisine.toLowerCase();
    r.sameCuisineThreatScore = calculateSameCuisineThreatScore(r.rating, r.totalRatings, r.distanceKm, isSameCuisine);
  });

  const sameCuisineNearby = mapped
    .filter(r => r.distanceKm <= 5 && r.foodCuisine.toLowerCase() === baseRestaurantCuisine.toLowerCase())
    .sort((a, b) => b.sameCuisineThreatScore - a.sameCuisineThreatScore).slice(0, 8);

  const cuisineAgg = {};
  within5km.forEach(r => {
    const foodCuisine = r.foodCuisine || cuisineMap[r.name] || "Multi-cuisine";
    if (!cuisineAgg[foodCuisine]) {
      cuisineAgg[foodCuisine] = { cuisine: foodCuisine, count: 0, totalVotes: 0, withPhotos: 0, totalRatingSum: 0, avgRating: 0, highestRating: 0, highestRatingName: "", lowestRating: 5, lowestRatingName: "", mostReviews: 0, mostReviewsName: "", restaurants: [] };
    }
    const c = cuisineAgg[foodCuisine];
    c.count++; c.totalVotes += r.totalRatings; if (r.photoCount > 0) c.withPhotos++;
    c.totalRatingSum += r.rating; c.avgRating = Number((c.totalRatingSum / c.count).toFixed(1));
    if (r.rating > c.highestRating) { c.highestRating = r.rating; c.highestRatingName = r.name; }
    if (r.rating < c.lowestRating && r.rating > 0) { c.lowestRating = r.rating; c.lowestRatingName = r.name; }
    if (r.totalRatings > c.mostReviews) { c.mostReviews = r.totalRatings; c.mostReviewsName = r.name; }
    c.restaurants.push({ name: r.name, rating: r.rating, reviews: r.totalRatings, distanceKm: r.distanceKm });
  });
  Object.values(cuisineAgg).forEach(c => c.restaurants.sort((a, b) => b.rating - a.rating || b.reviews - a.reviews));
  const cuisineBreakdown = Object.values(cuisineAgg).sort((a, b) => b.totalVotes - a.totalVotes).slice(0, 10);

  topCompetitors.forEach(comp => {
    const e = (aiParsed.competitorEnhancements || []).find(x => x.restaurant === comp.name);
    if (e) { comp.strengths = e.strengths; comp.weaknesses = e.weaknesses; comp.sentimentLabel = e.sentimentLabel; comp.sentimentScore = e.sentimentScore; comp.whatTheyDoBetter = e.whatTheyDoBetter; comp.whereYouWin = e.whereYouWin; }
  });

  const avgScore = Math.round(topCompetitors.reduce((s, c) => s + c.threatScore, 0) / topCompetitors.length) || 0;

  const baseReviews = (baseDetails && baseDetails.totalRatings) || 0;
  const baseRating = (baseDetails && baseDetails.rating) || 0;
  const allReviewCounts = mapped.map(r => r.totalRatings).sort((a, b) => a - b);
  const totalReviewsInArea = allReviewCounts.reduce((s, v) => s + v, 0);
  const reviewPercentile = Math.round((allReviewCounts.filter(c => c <= baseReviews).length / Math.max(1, allReviewCounts.length)) * 100);
  const allRatings = mapped.map(r => r.rating).sort((a, b) => a - b);
  const ratingPercentile = Math.round((allRatings.filter(r => r <= baseRating).length / Math.max(1, allRatings.length)) * 100);
  const negativeReviewCount = (baseDetails && baseDetails.recentReviews ? baseDetails.recentReviews.filter(r => r.rating <= 2).length : 0);

  const googleProfileChecks = {
    websiteAvailable: { pass: !!(baseDetails && baseDetails.website), note: (baseDetails && baseDetails.website) ? `Website found: ${new URL(baseDetails.website).hostname}` : "No website linked on Google Business Profile" },
    googlePageUpdated: { pass: (baseDetails && baseDetails.businessStatus) === "OPERATIONAL", note: (baseDetails && baseDetails.businessStatus) === "OPERATIONAL" ? "Business is marked as operational on Google" : `Business status: ${(baseDetails && baseDetails.businessStatus) || "Unknown"}` },
    seoOptimised: { pass: baseReviews >= 50 && baseRating >= 3.5, note: baseReviews >= 50 && baseRating >= 3.5 ? `${baseReviews} reviews and ${baseRating} rating help local SEO` : `Only ${baseReviews} reviews — more reviews will improve search ranking` },
    timingsUpdated: { pass: !!(baseDetails && baseDetails.hasHours), note: (baseDetails && baseDetails.hasHours) ? "Business hours are listed on Google" : "No business hours found — add them to improve visibility" },
    ownerPhotosAdded: { pass: ((baseDetails && baseDetails.photoCount) || 0) >= 5, note: (baseDetails && baseDetails.photoCount) ? `${baseDetails.photoCount} photos found on profile` : "No photos found — add quality photos to attract customers" },
    respondingToReviews: { pass: !!(baseDetails && baseDetails.ownerRespondsToReviews), note: (baseDetails && baseDetails.ownerRespondsToReviews) ? "Owner appears active in responding to reviews" : "No owner responses found — respond to reviews to build trust" },
    menuAvailable: { pass: !!(baseDetails && (baseDetails.website || baseDetails.googleUrl)), note: (baseDetails && baseDetails.website) ? "Menu likely accessible via website" : "Add a website with your menu for better conversion" },
    contactInfoComplete: { pass: !!(baseDetails && baseDetails.phone), note: (baseDetails && baseDetails.phone) ? `Phone number listed: ${baseDetails.phone}` : "No phone number found — add contact info to your profile" },
  };

  const compositeScore = (rating, reviews) => (rating / 5) * 50 + Math.min(50, (Math.log10(Math.max(1, reviews)) / 4) * 50);
  const allWithBase = [
    { name, rating: baseRating, reviews: baseReviews, isBase: true, compositeScore: compositeScore(baseRating, baseReviews) },
    ...mapped.filter(r => r.distanceKm <= 5).map(r => ({ name: r.name, rating: r.rating, reviews: r.totalRatings, isBase: false, compositeScore: compositeScore(r.rating, r.totalRatings) })),
  ].sort((a, b) => b.compositeScore - a.compositeScore);
  const baseRank = allWithBase.findIndex(r => r.isBase) + 1;
  const competitorRanking = {
    rank: baseRank, total: allWithBase.length, competitorsAbove: baseRank - 1,
    topRanked: allWithBase.slice(0, Math.max(10, baseRank + 2)).map((r, i) => ({ rank: i + 1, name: r.name, rating: r.rating, reviews: r.reviews, isBase: r.isBase })),
  };

  const searchQueries = [
    `Best ${baseRestaurantCuisine} in ${city}`, `Top restaurants in ${city}`, `Best ${baseRestaurantCuisine} near me ${city}`,
    `${baseRestaurantCuisine} restaurants ${city}`, `Best restaurants in ${city}`, `Best restaurants to order online ${city}`,
  ];
  const scoreSort = (a, b) => compositeScore(b.rating, b.totalRatings) - compositeScore(a.rating, a.totalRatings);
  const sameCuisineSorted = [...mapped].filter(r => r.foodCuisine.toLowerCase() === baseRestaurantCuisine.toLowerCase() && r.distanceKm <= 5).sort(scoreSort);
  const allSorted = [...mapped].filter(r => r.distanceKm <= 5).sort(scoreSort);
  const firstToken = name.toLowerCase().split(" ")[0].toLowerCase();
  const searchRankings = searchQueries.map(query => {
    const isCuisineQuery = query.toLowerCase().includes(baseRestaurantCuisine.toLowerCase());
    const pool = isCuisineQuery ? sameCuisineSorted : allSorted;
    const top = pool[0];
    const baseInPool = pool.findIndex(r => r.name.toLowerCase().includes(firstToken));
    return { query, topResult: top ? { name: top.name, rating: top.rating, reviews: top.totalRatings } : null, baseRanked: baseInPool >= 0, basePosition: baseInPool >= 0 ? baseInPool + 1 : null, totalResults: pool.length, inMapPack: baseInPool >= 0 && baseInPool < 3 };
  });

  // ---- Delivery benchmark (optional enrichment) ----
  const sameCuisineTop10 = [...mapped].filter(r => r.foodCuisine.toLowerCase() === baseRestaurantCuisine.toLowerCase() && r.distanceKm <= 5).sort((a, b) => b.totalRatings - a.totalRatings).slice(0, 10);
  const [deliveryText, seoChecks] = await Promise.all([
    claudeJson(BENCHMARK_MODEL, 2048,
      "You are a food delivery platform analyst with deep knowledge of Swiggy and Zomato restaurant listings in India. Provide realistic benchmark estimates. Always respond with valid JSON only.",
      `
Provide Swiggy & Zomato delivery platform benchmark estimates for these restaurants.

Base restaurant: ${name} (${baseRestaurantCuisine}, ${city})
- Google Rating: ${baseRating}, Reviews: ${baseReviews}, Photos: ${(baseDetails && baseDetails.photoCount) || 0}

Same-cuisine competitors in ${city}:
${sameCuisineTop10.map((r, i) => `${i + 1}. ${r.name} - Rating: ${r.rating}, Reviews: ${r.totalRatings}, Photos: ${r.photoCount}`).join("\n")}

Return STRICT JSON:
{ "deliveryBenchmarks": [ { "name": "restaurant name (EXACT, start with ${name} first)", "isBase": true, "images": 0, "zomatoRating": 0, "swiggyRating": 0, "topDishes": ["dish 1","dish 2","dish 3"], "totalItems": 0, "itemsAbove4Rating": 0 } ] }
RULES: First entry MUST be "${name}" with isBase true; include all ${sameCuisineTop10.length} competitors after; higher Google rating/reviews = higher platform ratings; totalItems 25-150; itemsAbove4Rating 30-50% of totalItems; images = Google photo count + 5-20.
`,
      false).catch(() => "{}"),
    seoPromise,
  ]);
  let deliveryParsed = { deliveryBenchmarks: [] };
  if (deliveryText && deliveryText !== "{}") { try { deliveryParsed = parseLlmJson(deliveryText); } catch (e) {} }
  const deliveryBenchmarks = (deliveryParsed.deliveryBenchmarks || []).map(b => {
    if (b.isBase) return Object.assign({}, b, { address: city });
    const match = sameCuisineTop10.find(r => r.name === b.name);
    return Object.assign({}, b, { address: (match && match.address) || city });
  });

  return {
    restaurantName: name,
    restaurantCity: city,
    restaurantZone: (baseDetails && baseDetails.zone) || null,
    restaurantAddress: (baseDetails && baseDetails.formattedAddress) || null,
    generatedAt: new Date().toISOString(),
    executiveSummary: aiParsed.executiveSummary,
    googleProfileChecks,
    seoChecks,
    deliveryBenchmarks,
    competitorRanking,
    searchRankings,
    reviewMetrics: { totalReviews: baseReviews, totalReviewsInArea, estimatedNegativeReviews: negativeReviewCount, reviewPercentile, ratingPercentile, rating: baseRating, totalCompetitors: mapped.length },
    yourKeywordCluster: aiParsed.yourKeywordCluster,
    competitorKeywordClusters: aiParsed.competitorKeywordClusters,
    competitorAnalysis: { topCompetitors, sameCuisineNearby, newHighRatedRestaurants, cuisineBreakdown, baseRestaurantCuisine, overallThreatLevel: avgScore >= 70 ? "High" : avgScore >= 45 ? "Moderate" : "Low", averageThreatScore: avgScore },
    finalStrategicVerdict: aiParsed.finalStrategicVerdict,
  };
}

/* Run the analysis and persist to the `reports` collection. */
async function runAndStore(name, city) {
  const data = await analyze(name, city);
  const reportId = crypto.randomUUID();
  const db = await connect();
  await db.collection("reports").insertOne({ reportId, restaurantName: name, restaurantCity: city, data, createdAt: new Date() });
  return { reportId, data };
}

module.exports = { analyze, runAndStore, StageError };
