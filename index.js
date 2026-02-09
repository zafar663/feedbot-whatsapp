require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const axios = require("axios");

const app = express();

// Twilio sends x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));
// Also allow JSON (for your own tests)
app.use(express.json());

const VERSION = "NutriPilot vSafeReply (Thin Client → AgroCore API) v0.5 ✅";

// On Render this MUST be your AgroCore public URL
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

// If message contains digits, likely a formula
function looksLikeFormula(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  const hasNumber = /\d/.test(t);
  const hasIngredientWord = /corn|maize|soy|sbm|wheat|oil|salt|lys|met|dcp|mcp|lime|limestone|premix|ddgs|meat|fish/i.test(t);
  return hasNumber && t.length >= 6 && (hasIngredientWord || /,|\n|%/.test(t) || /\d+\s*[a-z]/i.test(t));
}

// --- Auto-fix suggestion helper ---
function buildQuickFixes(result) {
  const fixes = [];

  const findings = Array.isArray(result?.evaluation?.findings) ? result.evaluation.findings : [];
  const statusByNut = new Map();
  for (const f of findings) statusByNut.set(String(f.nutrient || "").toLowerCase(), String(f.status || "").toUpperCase());

  const need = (n) => statusByNut.get(n) === "FAIL";

  // Simple, safe heuristics (no exact dosing)
  if (need("ca")) fixes.push("CA low → add limestone (calcite) / limestone grit");
  if (need("avp")) fixes.push("AvP low → add MCP/DCP (phosphate source)");
  if (need("na")) fixes.push("Na low → add salt (NaCl) or sodium bicarb (NaHCO₃)");
  if (need("lys")) fixes.push("Lys low → add L-Lysine HCl (or adjust SBM)");
  if (need("met")) fixes.push("Met low → add DL-Methionine (or MHA) / adjust protein");
  if (need("thr")) fixes.push("Thr low → add L-Threonine (or adjust protein)");

  // If nothing detected but FAIL overall:
  if (fixes.length === 0 && (result?.overall === "FAIL" || result?.evaluation?.overall === "FAIL")) {
    fixes.push("Diet not meeting targets → add missing minerals/AA or adjust ingredients");
  }

  // Keep short for WhatsApp
  return fixes.slice(0, 5);
}

// --- Format ME with units ---
function formatMEline(result) {
  // Prefer formatted energy with unit
  const meFmt = result?.nutrient_profile_formatted?.energy?.me;
  const req = result?.requirements_canonical?.me;

  if (meFmt && typeof meFmt.value === "number" && meFmt.unit) {
    const unit = meFmt.unit;
    const actual = meFmt.value;
    if (typeof req === "number") {
      return `⚡ ME: ${actual.toFixed(0)} ${unit} (req ${req} ${unit})`;
    }
    return `⚡ ME: ${actual.toFixed(0)} ${unit}`;
  }

  // Fallback if formatted not present
  const actual2 = result?.nutrient_profile_canonical?.me;
  if (typeof actual2 === "number" && typeof req === "number") {
    return `⚡ ME: ${actual2} (req ${req})`;
  }
  return null;
}

function formatKeyFindings(result) {
  const findings = Array.isArray(result?.evaluation?.findings) ? result.evaluation.findings : [];
  // show up to 8
  return findings.slice(0, 8).map((f) => {
    const n = String(f.nutrient || "").toUpperCase();
    const st = String(f.status || "");
    const diff = (typeof f.diff === "number") ? f.diff : null;
    // keep compact
    return `${n}:${st}${diff !== null ? `(${diff})` : ""}`;
  }).join(" | ");
}

function formatAgrocoreResult(result) {
  if (!result || typeof result !== "object") return "⚠️ Empty AgroCore response.";
  if (result.ok === false) return `⚠️ AgroCore error: ${result.error || "Unknown error"}`;

  const overall = result.overall || result?.evaluation?.overall || "UNKNOWN";
  const meta = result.meta || {};
  const head = `🧠 Result: ${overall}\n🧾 ${meta.species || "poultry"}${meta.type ? `/${meta.type}` : ""}${meta.phase ? `/${meta.phase}` : ""}`;

  const meLine = formatMEline(result);
  const key = formatKeyFindings(result);

  const lines = [head];
  if (meLine) lines.push(meLine);
  if (key) lines.push(`📌 Key: ${key}`);

  // ✅ Auto-fix suggestions when FAIL
  if (String(overall).toUpperCase() === "FAIL") {
    const fixes = buildQuickFixes(result);
    if (fixes.length) {
      lines.push("🔧 Quick fixes:");
      for (const fx of fixes) lines.push(`- ${fx}`);
      lines.push("✅ Reply: FIX to get a smarter reformulation step next.");
    }
  }

  return lines.join("\n");
}

app.post("/whatsapp", async (req, res) => {
  const bodyRaw = (req.body && (req.body.Body || req.body.body)) || "";
  const body = String(bodyRaw).trim();
  const msg = body.toLowerCase();
  const from = (req.body && (req.body.From || req.body.from)) || "unknown";

  console.log(`[WA] From=${from} Body="${body}"`);

  try {
    if (!msg || msg === "menu" || msg === "help" || msg === "?") {
      return reply(res, `${VERSION}\n\n${MENU}`);
    }

    // Menu numbers
    if (["1", "2", "3", "4", "5"].includes(msg)) {
      if (msg === "1") {
        return reply(res, `${VERSION}\n\nSend your formula like:\n\ncorn 60, soybean meal 30, oil 3, salt 0.3`);
      }
      return reply(res, `${VERSION}\n\nComing next ✅`);
    }

    // If user says FIX (for now: just show how to send complete formula)
    if (msg === "fix") {
      return reply(
        res,
        `${VERSION}\n\nTo fix properly, send full formula including minerals:\n\ncorn 60, soybean meal 30, oil 3, limestone 1.2, dcp 1.6, salt 0.3\n\nThen I’ll re-check targets.`
      );
    }

    // Analyze formulas immediately
    if (looksLikeFormula(body)) {
      const resp = await axios.post(
        AGROCORE_URL,
        { text: body },
        { timeout: 20000 }
      );
      const out = formatAgrocoreResult(resp.data);
      return reply(res, `${VERSION}\n\n${out}`);
    }

    // Fallback
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NutriPilot running on port ${PORT} — ${VERSION}`);
});
