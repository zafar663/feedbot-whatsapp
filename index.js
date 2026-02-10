const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const twilio = require("twilio");
const { MessagingResponse } = twilio.twiml;

try { require("dotenv").config(); } catch (e) {}

const PORT = process.env.PORT || 3000;
const AGROCORE_BASE = (process.env.AGROCORE_BASE || "https://agrocore-api.onrender.com").trim();
const TWILIO_ACCOUNT_SID = (process.env.TWILIO_ACCOUNT_SID || "").trim();
const TWILIO_AUTH_TOKEN = (process.env.TWILIO_AUTH_TOKEN || "").trim();
const GIT_SHA = process.env.RENDER_GIT_COMMIT || "local";

const VERSION = "NutriPilot vSafeReply (Thin Client → AgroCore API) v0.7";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

/* ---------------- HEALTH ---------------- */

app.get("/", (req, res) => {
  res.status(200).send(
`Feedbot is running ✅
${VERSION}
Git: ${GIT_SHA}
AgroCore base: ${AGROCORE_BASE}`
  );
});

app.get("/version", (req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    git: GIT_SHA,
    agrocore_base: AGROCORE_BASE
  });
});

app.get("/debug/agrocore", async (req, res) => {
  try {
    const r = await axios.get(`${AGROCORE_BASE}/v1/health`, { timeout: 10000 });
    res.json({
      ok: true,
      agrocore_health: r.data
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/* ---------------- HELPERS ---------------- */

function safeReply(res, msg) {
  const twiml = new MessagingResponse();
  twiml.message(msg);
  res.type("text/xml");
  return res.send(twiml.toString());
}

async function downloadTwilioMedia(mediaUrl) {
  const r = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    auth: { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN },
    timeout: 60000,
    validateStatus: () => true,
  });
  if (r.status >= 400) throw new Error("Twilio media download failed");
  return Buffer.from(r.data);
}

async function agrocoreAnalyze(text) {
  const r = await axios.post(
    `${AGROCORE_BASE}/v1/analyze`,
    { locale: "US", formula_text: text },
    { timeout: 60000, validateStatus: () => true }
  );
  if (r.status >= 400) throw new Error("AgroCore analyze failed");
  return r.data;
}

/* ---------------- WHATSAPP ---------------- */

app.post("/whatsapp", async (req, res) => {
  try {
    const body = (req.body?.Body || "").trim();
    const mediaUrl0 = req.body?.MediaUrl0;

    if (!mediaUrl0) {
      const a = await agrocoreAnalyze(body);
      return safeReply(
        res,
`${VERSION}
✅ Text analyzed
ME: ${Math.round(a.nutrient_profile_canonical.me)} kcal/kg
CP: ${a.nutrient_profile_canonical.cp.toFixed(2)}%`
      );
    }

    const buf = await downloadTwilioMedia(mediaUrl0);
    const a = await agrocoreAnalyze(buf.toString("utf8"));

    return safeReply(
      res,
`${VERSION}
✅ File analyzed
ME: ${Math.round(a.nutrient_profile_canonical.me)} kcal/kg
CP: ${a.nutrient_profile_canonical.cp.toFixed(2)}%`
    );

  } catch (err) {
    console.error(err);
    return safeReply(res, `${VERSION}\n⚠️ Failed: ${err.message}`);
  }
});

/* ---------------- START ---------------- */

app.listen(PORT, "0.0.0.0", () => {
  console.log(VERSION);
  console.log(`Port: ${PORT}`);
  console.log(`Git: ${GIT_SHA}`);
  console.log(`AgroCore: ${AGROCORE_BASE}`);
});
