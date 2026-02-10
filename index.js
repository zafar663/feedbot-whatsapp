// feedbot-whatsapp/index.js
const express = require("express");
const axios = require("axios");
const twilio = require("twilio");
const { MessagingResponse } = twilio.twiml;

try { require("dotenv").config(); } catch (e) {}

const PORT = process.env.PORT || 3000;
const AGROCORE_BASE = (process.env.AGROCORE_BASE || "https://agrocore-api.onrender.com").trim();

const VERSION = "NutriPilot vSafeReply (Thin Client → AgroCore API) v0.7";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// -----------------------------
// Small retry helper (handles 429 / transient errors)
// -----------------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function axiosWithRetry(fn, { retries = 3, baseDelayMs = 800 } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fn();
      // If server replies 429/5xx, treat as retryable
      if ([429, 502, 503, 504].includes(r.status) && i < retries) {
        await sleep(baseDelayMs * Math.pow(2, i));
        continue;
      }
      return r;
    } catch (err) {
      last = err;
      if (i < retries) {
        await sleep(baseDelayMs * Math.pow(2, i));
        continue;
      }
      throw last;
    }
  }
  throw last;
}

// -----------------------------
// Root
// -----------------------------
app.get("/", (req, res) => {
  res.status(200).send(
`Feedbot is running ✅
${VERSION}
AGROCORE_BASE=${AGROCORE_BASE}`
  );
});

// -----------------------------
// Debug cache for /v1/health
// -----------------------------
let cachedHealth = null;
let cachedAt = 0;
const CACHE_MS = 30_000;

app.get("/debug/agrocore", async (req, res) => {
  try {
    const now = Date.now();
    if (cachedHealth && (now - cachedAt) < CACHE_MS) {
      return res.json({ ...cachedHealth, cached: true, cacheAgeMs: now - cachedAt });
    }

    const healthUrl = `${AGROCORE_BASE}/v1/health`;
    const r = await axiosWithRetry(
      () => axios.get(healthUrl, { timeout: 15000, validateStatus: () => true }),
      { retries: 3, baseDelayMs: 800 }
    );

    cachedHealth = {
      ok: true,
      AGROCORE_BASE,
      healthUrl,
      status: r.status,
      data: r.data
    };
    cachedAt = now;

    return res.json({ ...cachedHealth, cached: false });
  } catch (err) {
    return res.json({
      ok: false,
      AGROCORE_BASE,
      error: String(err?.message || err)
    });
  }
});

// -----------------------------
// Debug analyze (more important than /health)
// -----------------------------
app.get("/debug/analyze", async (req, res) => {
  try {
    const url = `${AGROCORE_BASE}/v1/analyze`;
    const payload = { locale: "US", formula_text: "Corn 55\nSBM 30\nOil 3\nSalt 0.3" };

    const r = await axiosWithRetry(
      () => axios.post(url, payload, { timeout: 20000, validateStatus: () => true }),
      { retries: 3, baseDelayMs: 800 }
    );

    return res.json({
      ok: r.status < 400,
      url,
      status: r.status,
      contentType: r.headers?.["content-type"] || null,
      data: r.data
    });
  } catch (err) {
    return res.json({
      ok: false,
      AGROCORE_BASE,
      error: String(err?.message || err)
    });
  }
});

// -----------------------------
// Twilio reply
// -----------------------------
function safeReply(res, msg) {
  const twiml = new MessagingResponse();
  twiml.message(msg);
  res.set("Content-Type", "text/xml");
  return res.status(200).send(twiml.toString());
}

// -----------------------------
// Analyze wrapper
// -----------------------------
async function agrocoreAnalyze(text) {
  const url = `${AGROCORE_BASE}/v1/analyze`;
  const r = await axiosWithRetry(
    () => axios.post(url, { locale: "US", formula_text: text }, { timeout: 60000, validateStatus: () => true }),
    { retries: 3, baseDelayMs: 800 }
  );

  if (r.status >= 400) throw new Error(`AgroCore analyze failed HTTP ${r.status}`);
  return r.data;
}

// -----------------------------
// WhatsApp webhook
// -----------------------------
app.post("/whatsapp", async (req, res) => {
  try {
    const text = (req.body?.Body || "").trim();
    if (!text) return safeReply(res, `${VERSION}\nSend a feed formula as text.`);

    const a = await agrocoreAnalyze(text);

    return safeReply(
      res,
`${VERSION}
✅ Text analyzed
ME: ${a?.nutrient_profile_canonical?.me ? Math.round(a.nutrient_profile_canonical.me) + " kcal/kg" : "n/a"}
CP: ${a?.nutrient_profile_canonical?.cp ? a.nutrient_profile_canonical.cp.toFixed(2) + "%" : "n/a"}`
    );
  } catch (err) {
    console.error(err?.message || err);
    return safeReply(res, `${VERSION}\n⚠️ Failed: AgroCore request failed`);
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(VERSION);
  console.log(`Feedbot listening on ${PORT}`);
  console.log(`AGROCORE_BASE=${AGROCORE_BASE}`);
});
