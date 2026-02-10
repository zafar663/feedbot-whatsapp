// feedbot-whatsapp/index.js
const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const twilio = require("twilio");
const { MessagingResponse } = twilio.twiml;

try { require("dotenv").config(); } catch (e) {}

const PORT = process.env.PORT || 3000;
const AGROCORE_BASE = (process.env.AGROCORE_BASE || "https://agrocore-api.onrender.com").trim();
const TWILIO_ACCOUNT_SID = (process.env.TWILIO_ACCOUNT_SID || "").trim();
const TWILIO_AUTH_TOKEN  = (process.env.TWILIO_AUTH_TOKEN || "").trim();

const VERSION = "NutriPilot vSafeReply (Thin Client → AgroCore API) v0.7";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

/* ---------- ROOT HEALTH ---------- */
app.get("/", (req, res) => {
  res.status(200).send(
`Feedbot is running ✅
${VERSION}
AGROCORE_BASE=${AGROCORE_BASE}`
  );
});

/* ---------- DEBUG AGROCORE ---------- */
app.get("/debug/agrocore", async (req, res) => {
  try {
    const url = `${AGROCORE_BASE}/v1/health`;
    const r = await axios.get(url, { timeout: 15000, validateStatus: () => true });
    res.json({
      ok: true,
      agrocore_base: AGROCORE_BASE,
      health_url: url,
      status: r.status,
      data: r.data
    });
  } catch (err) {
    res.json({
      ok: false,
      agrocore_base: AGROCORE_BASE,
      error: String(err?.message || err)
    });
  }
});

/* ---------- SAFE TWILIO REPLY ---------- */
function safeReply(res, msg) {
  const twiml = new MessagingResponse();
  twiml.message(msg);
  res.set("Content-Type", "text/xml");
  return res.status(200).send(twiml.toString());
}

/* ---------- AGROCORE ANALYZE ---------- */
async function agrocoreAnalyze(text) {
  const url = `${AGROCORE_BASE}/v1/analyze`;
  const r = await axios.post(
    url,
    { locale: "US", formula_text: text },
    { timeout: 60000, validateStatus: () => true }
  );

  if (r.status >= 400) {
    throw new Error(`AgroCore analyze failed ${r.status}`);
  }
  return r.data;
}

/* ---------- WHATSAPP WEBHOOK ---------- */
app.post("/whatsapp", async (req, res) => {
  try {
    const text = (req.body?.Body || "").trim();
    if (!text) {
      return safeReply(res, `${VERSION}\nSend a feed formula as text.`);
    }

    const a = await agrocoreAnalyze(text);

    return safeReply(
      res,
`${VERSION}
✅ Text analyzed
ME: ${a?.nutrient_profile_canonical?.me ? Math.round(a.nutrient_profile_canonical.me) + " kcal/kg" : "n/a"}
CP: ${a?.nutrient_profile_canonical?.cp ? a.nutrient_profile_canonical.cp.toFixed(2) + "%" : "n/a"}`
    );
  } catch (err) {
    console.error(err);
    return safeReply(res, `${VERSION}\n⚠️ Failed: AgroCore request failed`);
  }
});

/* ---------- START ---------- */
app.listen(PORT, "0.0.0.0", () => {
  console.log(VERSION);
  console.log(`Feedbot listening on ${PORT}`);
  console.log(`AGROCORE_BASE=${AGROCORE_BASE}`);
});
