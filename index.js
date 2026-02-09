require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const axios = require("axios");

const app = express();

// Twilio sends x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));
// Also allow JSON
app.use(express.json());

const VERSION = "NutriPilot vSafeReply (Thin Client → AgroCore API) v0.4 ✅";

// IMPORTANT: On Render set AGROCORE_URL to your AgroCore public URL later.
// For now, if AgroCore is not deployed separately, this can point to something else.
const AGROCORE_URL =
  process.env.AGROCORE_URL || "http://localhost:3001/v1/analyze";

const MENU =
  `NutriPilot AI

1) Formulation & Diet Control
2) Performance & Production Intelligence
3) Raw Materials, Feed Mill & Quality
4) Expert Review
5) Nutrition Partner Program

Reply with a number or type MENU.`;

function reply(res, message) {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(message);
  res.status(200);
  res.set("Content-Type", "text/xml");
  return res.send(twiml.toString());
}

app.get("/", (_, res) => {
  res.send(`Feedbot is running ✅\n${VERSION}\nAgroCore URL: ${AGROCORE_URL}`);
});

// Simple detector: if message contains any digit, treat as formula input
function looksLikeFormula(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  // common formula patterns: numbers, %, commas, line breaks
  const hasNumber = /\d/.test(t);
  const hasIngredientWord = /corn|maize|soy|sbm|wheat|oil|salt|lys|met|dcp|lime|premix/.test(t);
  // If it has numbers, it's very likely a formula, even without known words
  return hasNumber && (t.length >= 6) && (hasIngredientWord || /,|\n|%/.test(t) || /\d+\s*[a-z]/i.test(t));
}

function formatAgrocoreResult(result) {
  if (!result || typeof result !== "object") return "⚠️ Empty AgroCore response.";
  if (result.ok === false) return `⚠️ AgroCore error: ${result.error || "Unknown error"}`;

  const overall = result.overall || result?.evaluation?.overall || "UNKNOWN";
  const meta = result.meta || {};
  const header = `🧠 Result: ${overall}\n🧾 ${meta.species || "poultry"}${meta.type ? `/${meta.type}` : ""}${meta.phase ? `/${meta.phase}` : ""}`;

  const findings = Array.isArray(result?.evaluation?.findings) ? result.evaluation.findings : [];
  const key = findings.slice(0, 8).map((f) => {
    const n = String(f.nutrient || "").toUpperCase();
    const st = f.status || "";
    const diff = typeof f.diff === "number" ? f.diff : "";
    return `${n}:${st}${diff !== "" ? `(${diff})` : ""}`;
  });

  const lines = [header];
  if (key.length) lines.push(`📌 Key: ${key.join(" | ")}`);

  return lines.join("\n");
}

app.post("/whatsapp", async (req, res) => {
  const bodyRaw = (req.body && (req.body.Body || req.body.body)) || "";
  const body = String(bodyRaw).trim();
  const msg = body.toLowerCase();
  const from = (req.body && (req.body.From || req.body.from)) || "unknown";

  console.log(`[WA] From=${from} Body="${body}"`);

  try {
    // Only show menu when user asks for it
    if (!msg || msg === "menu" || msg === "help" || msg === "?") {
      return reply(res, `${VERSION}\n\n${MENU}`);
    }

    // If user sends 1–5, keep menu navigation behavior
    if (["1", "2", "3", "4", "5"].includes(msg)) {
      if (msg === "1") {
        return reply(res, `${VERSION}\n\nSend your formula like:\n\ncorn 60, soybean meal 30, oil 3, salt 0.3`);
      }
      return reply(res, `${VERSION}\n\nComing next ✅`);
    }

    // ✅ NEW: If it looks like a formula, analyze immediately
    if (looksLikeFormula(body)) {
      const resp = await axios.post(
        AGROCORE_URL,
        { text: body },
        { timeout: 20000 }
      );
      const out = formatAgrocoreResult(resp.data);
      return reply(res, `${VERSION}\n\n${out}`);
    }

    // Otherwise, fallback (show menu)
    return reply(res, `${VERSION}\n\n${MENU}`);
  } catch (err) {
    const reason =
      err?.response?.data?.error ||
      err?.message ||
      "AgroCore request failed";
    console.error("WhatsApp→AgroCore error:", reason);
    return reply(res, `${VERSION}\n\n⚠️ Failed: ${reason}`);
  }
});

// Render provides PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NutriPilot running on port ${PORT} — ${VERSION}`);
});
