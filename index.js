// feedbot-whatsapp/index.js
const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const twilio = require("twilio");
const { MessagingResponse } = twilio.twiml;

// dotenv is optional on Render, but helpful locally
try { require("dotenv").config(); } catch (e) {}

const PORT = process.env.PORT || 3000;

// IMPORTANT: default must NOT be localhost on Render
const AGROCORE_BASE = (process.env.AGROCORE_BASE || "https://agrocore-api.onrender.com").trim();

const TWILIO_ACCOUNT_SID = (process.env.TWILIO_ACCOUNT_SID || "").trim();
const TWILIO_AUTH_TOKEN  = (process.env.TWILIO_AUTH_TOKEN || "").trim();

const VERSION = "NutriPilot vSafeReply ✅ (Thin Client → AgroCore API) v0.7";

const app = express();
app.use(express.urlencoded({ extended: false })); // Twilio sends form-urlencoded
app.use(express.json());

// Simple homepage
app.get("/", (req, res) => {
  res.status(200).send(
`Feedbot is running ✅
${VERSION}
AGROCORE_BASE=${AGROCORE_BASE}`
  );
});

// DEBUG: verify Render can reach AgroCore and see what AGROCORE_BASE is
app.get("/debug/agrocore", async (req, res) => {
  try {
    const healthUrl = `${AGROCORE_BASE}/v1/health`;
    const r = await axios.get(healthUrl, { timeout: 15000, validateStatus: () => true });

    return res.status(200).json({
      ok: true,
      AGROCORE_BASE,
      healthUrl,
      status: r.status,
      data: r.data
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      AGROCORE_BASE,
      error: String(err?.message || err)
    });
  }
});

function safeReply(res, msg) {
  const twiml = new MessagingResponse();
  twiml.message(msg);
  res.set("Content-Type", "text/xml");
  return res.status(200).send(twiml.toString());
}

async function downloadTwilioMedia(mediaUrl) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    throw new Error("Missing TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN (needed to download MediaUrl0).");
  }

  const r = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    auth: { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN },
    timeout: 60000,
    maxRedirects: 5,
    validateStatus: () => true,
  });

  if (r.status >= 400) {
    const txt = Buffer.from(r.data || []).toString("utf8");
    throw new Error(`Twilio download failed HTTP ${r.status}: ${txt.slice(0, 400)}`);
  }

  return Buffer.from(r.data);
}

async function agrocoreIngest(fileBuf, mediaType0, filename) {
  const url = `${AGROCORE_BASE}/v1/ingest`;
  const form = new FormData();

  form.append("file", fileBuf, {
    filename: filename || "upload.bin",
    contentType: mediaType0 || "application/octet-stream",
  });

  const r = await axios.post(url, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 120000,
    validateStatus: () => true,
  });

  if (r.status >= 400) {
    throw new Error(`AgroCore ingest failed HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 800)}`);
  }

  return r.data; // expected { ok, text, ... }
}

async function agrocoreAnalyze(formulaText) {
  const url = `${AGROCORE_BASE}/v1/analyze`;

  const r = await axios.post(
    url,
    { locale: "US", formula_text: formulaText },
    { timeout: 60000, validateStatus: () => true }
  );

  if (r.status >= 400) {
    throw new Error(`AgroCore analyze failed HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 800)}`);
  }

  return r.data;
}

function guessFilename(bodyRaw, mediaType0) {
  const name = (bodyRaw || "").trim();
  if (name && name.length < 120 && name.includes(".")) return name;

  const mt = String(mediaType0 || "").toLowerCase();
  if (mt.includes("pdf")) return "upload.pdf";
  if (mt.startsWith("image/")) return "upload.jpg";
  return "upload.bin";
}

app.post("/whatsapp", async (req, res) => {
  try {
    const bodyRaw = req.body?.Body ?? "";
    const fromRaw = req.body?.From ?? "unknown";
    const numMediaRaw = req.body?.NumMedia ?? "0";
    const numMedia = parseInt(numMediaRaw, 10) || 0;

    const mediaUrl0 = req.body?.MediaUrl0;
    const mediaType0 = req.body?.MediaContentType0;

    console.log("--------------------------------------------------");
    console.log(`[WA] From=${fromRaw} Body="${bodyRaw}" NumMedia=${numMedia}`);
    console.log(`[WA] MediaUrl0=${mediaUrl0 || "none"} MediaType0=${mediaType0 || "none"}`);
    console.log(`[WA] AGROCORE_BASE=${AGROCORE_BASE}`);

    // TEXT
    if (!numMedia) {
      const text = (bodyRaw || "").trim();
      if (!text) return safeReply(res, `${VERSION}\nSend formula text OR attach a PDF/image.`);

      const a = await agrocoreAnalyze(text);

      return safeReply(
        res,
        `${VERSION}\n✅ Text analyzed.\nME: ${
          a?.nutrient_profile_canonical?.me ? Math.round(a.nutrient_profile_canonical.me) + " kcal/kg" : "n/a"
        }\nCP: ${
          a?.nutrient_profile_canonical?.cp ? a.nutrient_profile_canonical.cp.toFixed(2) + "%" : "n/a"
        }`
      );
    }

    // MEDIA
    if (!mediaUrl0) return safeReply(res, `${VERSION}\n⚠️ Media detected but MediaUrl0 missing.`);

    // 1) Download
    const fileBuf = await downloadTwilioMedia(mediaUrl0);
    console.log(`[WA] Downloaded media bytes: ${fileBuf.length}`);

    // 2) Ingest
    const filename = guessFilename(bodyRaw, mediaType0);
    const ingest = await agrocoreIngest(fileBuf, mediaType0, filename);
    const extracted = (ingest?.text || "").trim();
    console.log(`[WA] Extracted chars: ${extracted.length}`);

    if (!extracted) {
      return safeReply(res, `${VERSION}\n⚠️ I got the file but couldn't extract text. Try a clearer file.`);
    }

    // 3) Analyze extracted text
    const a = await agrocoreAnalyze(extracted);

    // 4) Reply
    return safeReply(
      res,
      `${VERSION}\n✅ File ingested + analyzed.\nME: ${
        a?.nutrient_profile_canonical?.me ? Math.round(a.nutrient_profile_canonical.me) + " kcal/kg" : "n/a"
      }\nCP: ${
        a?.nutrient_profile_canonical?.cp ? a.nutrient_profile_canonical.cp.toFixed(2) + "%" : "n/a"
      }`
    );
  } catch (err) {
    console.error("=== ERROR ===");
    console.error(err?.message || err);
    if (err?.response) {
      console.error("HTTP", err.response.status, err.response.data);
    }
    console.error("=============");

    return safeReply(res, `${VERSION}\n⚠️ Failed: ${err?.message || "Unknown failure"}`);
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`${VERSION}`);
  console.log(`NutriPilot running on port ${PORT}`);
  console.log(`AGROCORE_BASE=${AGROCORE_BASE}`);
});
