/**
 * =========================================================
 * NutriPilot vSafeReply ✅ v1.3x — EXPERIMENTAL
 * Adds: NEEDS_CLARIFICATION handling (CP/grade prompts)
 *
 * Output contract:
 * - If analysis OK -> keep EXACT v1.3 output contract
 * - If NEEDS_CLARIFICATION -> reply with clarification_text + examples
 * =========================================================
 */

const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const FormData = require("form-data");
require("dotenv").config();

const VERSION = "NutriPilot vSafeReply ✅ (Thin Client → AgroCore API) v1.3x — EXPERIMENTAL";
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const AGROCORE_BASE = process.env.AGROCORE_BASE || "http://localhost:3001";

// ---------- SAFE ENV CHECK (never prints secrets) ----------
function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}
const SELF_HASH = sha256(fs.readFileSync(__filename, "utf8")).slice(0, 12);

const HAS_SID = !!process.env.TWILIO_ACCOUNT_SID;
const HAS_TOKEN = !!process.env.TWILIO_AUTH_TOKEN;
const SID_STARTS_AC = (process.env.TWILIO_ACCOUNT_SID || "").startsWith("AC");

console.log("\n========== START ==========");
console.log(VERSION);
console.log("FILE_HASH:", SELF_HASH);
console.log("PORT:", PORT);
console.log("AGROCORE_BASE:", AGROCORE_BASE);
console.log("TWILIO_ACCOUNT_SID present?", HAS_SID);
console.log("TWILIO_AUTH_TOKEN present?", HAS_TOKEN);
console.log("TWILIO_ACCOUNT_SID starts with AC?", SID_STARTS_AC);
console.log("===========================\n");

// Ensure downloads directory exists
const DOWNLOAD_DIR = path.join(process.cwd(), "_downloads");
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

function twiml(message) {
  const safe = String(message || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<Response><Message>${safe}</Message></Response>`;
}

function guessExtFromContentType(ct = "") {
  const s = String(ct).toLowerCase();
  if (s.includes("pdf")) return "pdf";
  if (s.includes("spreadsheet") || s.includes("excel") || s.includes("xlsx")) return "xlsx";
  if (s.includes("csv")) return "csv";
  if (s.includes("png")) return "png";
  if (s.includes("jpeg") || s.includes("jpg")) return "jpg";
  if (s.includes("image")) return "img";
  return "bin";
}

// ---------- Formatting helpers ----------
function fmtNum(x, decimals = 4) {
  const n = Number(x);
  if (!Number.isFinite(n)) return "-";
  return n.toFixed(decimals);
}
function fmtMeKcal(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return "-";
  return `${n.toFixed(0)} kcal/kg`;
}
function normKey(k) {
  return String(k || "").trim().toUpperCase();
}

// ---------- Robust extraction helpers ----------
function toScalarMaybe(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/[^\d.\-]/g, "");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "object") {
    if ("value" in v) return toScalarMaybe(v.value);
    if ("val" in v) return toScalarMaybe(v.val);
    if ("amount" in v) return toScalarMaybe(v.amount);
  }
  return null;
}

function mapKeyAliases(k) {
  const K = normKey(k);

  if (
    K === "AVP" ||
    K === "AVP(%)" ||
    K === "AVAILP" ||
    K === "AVAILABLEP" ||
    K === "AVAILABLE PHOSPHORUS" ||
    K === "AVPERCENT" ||
    K === "AVP_%"
  ) return "AVP";

  if (K === "NA" || K === "SODIUM") return "NA";
  if (K === "CA" || K === "CALCIUM") return "CA";
  if (K === "CP" || K === "CRUDEPROTEIN" || K === "CRUDE PROTEIN") return "CP";

  if (
    K === "ME" ||
    K === "AMEN" ||
    K === "AMEN" ||
    K === "AMEN" ||
    K === "METABOLIZABLEENERGY" ||
    K === "METABOLIZABLE ENERGY" ||
    K === "ME_KCAL" ||
    K === "ME_KCAL_PER_KG"
  ) return "ME";

  if (K === "LYS" || K === "LYSINE" || K === "DIG LYS" || K === "DIGLYS") return "LYS";
  if (K === "MET" || K === "METHIONINE" || K === "DIG MET" || K === "DIGMET") return "MET";
  if (K === "THR" || K === "THREONINE" || K === "DIG THR" || K === "DIGTHR") return "THR";

  return K;
}

function extractNutrientObjectFromArray(arr) {
  const out = {};
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const name = item.nutrient || item.name || item.key || item.code || item.label;
    const val = item.value ?? item.val ?? item.amount ?? item.reported ?? item.calculated;
    if (!name) continue;
    const key = mapKeyAliases(name);
    const scalar = toScalarMaybe(val);
    if (scalar != null) out[key] = scalar;
  }
  return out;
}

function extractReportedNutrients(ingestData) {
  const candidates = [
    ingestData?.meta?.reported_nutrients,
    ingestData?.reported_nutrients,
    ingestData?.meta?.reported,
    ingestData?.meta?.nutrients_reported,
    ingestData?.meta?.reportedNutrients,
  ];

  for (const cand of candidates) {
    if (!cand) continue;

    if (Array.isArray(cand)) {
      const obj = extractNutrientObjectFromArray(cand);
      if (Object.keys(obj).length) return { obj, foundAt: "array(candidate)" };
    }

    if (typeof cand === "object") {
      const obj = {};
      for (const [k, v] of Object.entries(cand)) {
        const key = mapKeyAliases(k);
        const scalar = toScalarMaybe(v);
        if (scalar != null) obj[key] = scalar;
        if (scalar == null && v && typeof v === "object") {
          const nested = toScalarMaybe(v.value ?? v.val ?? v.amount);
          if (nested != null) obj[key] = nested;
        }
      }
      if (Object.keys(obj).length) return { obj, foundAt: "object(candidate)" };
    }
  }

  return { obj: {}, foundAt: "not_found" };
}

function extractCalculatedNutrients(analyzeData) {
  // AgroCore v1.4+ returns nutrient_profile (flat)
  const candidates = [
    analyzeData?.nutrient_profile,
    analyzeData?.nutrient_profile_core,
    analyzeData?.nutrient_profile_full,
    analyzeData?.result?.calculated?.nutrients,
    analyzeData?.result?.nutrients,
    analyzeData?.nutrients,
  ];

  for (const cand of candidates) {
    if (!cand) continue;

    if (Array.isArray(cand)) {
      const obj = extractNutrientObjectFromArray(cand);
      if (Object.keys(obj).length) return { obj, foundAt: "array(candidate)" };
    }

    if (typeof cand === "object") {
      const obj = {};
      for (const [k, v] of Object.entries(cand)) {
        // ignore non-nutrients
        if (k === "unknown" || k === "coverage" || k === "_LOCK") continue;
        const key = mapKeyAliases(k);
        const scalar = toScalarMaybe(v);
        if (scalar != null) obj[key] = scalar;
      }
      if (Object.keys(obj).length) return { obj, foundAt: "object(candidate)" };
    }
  }

  return { obj: {}, foundAt: "not_found" };
}

// Build 2-column WhatsApp table (UNCHANGED)
function buildReportedVsCalculatedTable(reported = {}, calculated = {}) {
  const rows = [
    ["ME", "kcal/kg"],
    ["CP", "%"],
    ["LYS", "%"],
    ["MET", "%"],
    ["THR", "%"],
    ["CA", "%"],
    ["AVP", "%"],
    ["NA", "%"],
  ];

  const rep = {};
  const calc = {};
  for (const [k, v] of Object.entries(reported || {})) rep[mapKeyAliases(k)] = v;
  for (const [k, v] of Object.entries(calculated || {})) calc[mapKeyAliases(k)] = v;

  const lines = [];
  lines.push("Reported vs Calculated");
  lines.push("Nutrient | Reported | Calculated");
  lines.push("--------------------------------");

  for (const [k, unit] of rows) {
    const r = rep[k];
    const c = calc[k];

    let rStr = "-";
    let cStr = "-";

    if (k === "ME") {
      rStr = r != null ? fmtMeKcal(r) : "-";
      cStr = c != null ? fmtMeKcal(c) : "-";
    } else {
      rStr = r != null ? `${fmtNum(r, 4)} ${unit}` : "-";
      cStr = c != null ? `${fmtNum(c, 4)} ${unit}` : "-";
    }

    lines.push(`${k} | ${rStr} | ${cStr}`);
  }

  return lines.join("\n");
}

// ---- MEDIA DOWNLOAD (same as locked baseline) ----
async function downloadTwilioMedia(mediaUrl) {
  if (mediaUrl.startsWith("http://")) mediaUrl = mediaUrl.replace("http://", "https://");
  return axios.get(mediaUrl, {
    responseType: "arraybuffer",
    auth: {
      username: process.env.TWILIO_ACCOUNT_SID,
      password: process.env.TWILIO_AUTH_TOKEN,
    },
    headers: { "User-Agent": "NutriPilot-Ingest/1.3x" },
    validateStatus: () => true,
    timeout: 30000,
  });
}

// ---- Clarification formatter (NEW) ----
function buildClarificationReply(a) {
  const text = a?.clarification_text || a?.message || "Need ingredient clarification before analysis.";
  const ex = Array.isArray(a?.clarification_examples) ? a.clarification_examples : [];
  const lines = [];
  lines.push(text.trim());
  if (ex.length) {
    lines.push("");
    lines.push("Examples:");
    for (const e of ex.slice(0, 6)) lines.push(`- ${e}`);
  }
  return lines.join("\n");
}

app.get("/health", (req, res) => res.json({ ok: true, version: VERSION }));

app.post("/whatsapp", async (req, res) => {
  try {
    const numMedia = Number(req.body.NumMedia || 0);
    const bodyText = String(req.body.Body || "").trim();

    if (!numMedia && /^(hi|hello|hey|start)$/i.test(bodyText)) {
      return res.status(200).type("text/xml").send(
        twiml("👋 NutriPilot v1.3x is ready. Send a PDF/Excel/photo formula to analyze.")
      );
    }

    if (!numMedia) {
      return res.status(200).type("text/xml").send(twiml("Send a formula file (PDF/Excel/photo)."));
    }

    if (!HAS_SID || !HAS_TOKEN) {
      return res.status(200).type("text/xml").send(twiml("Server missing Twilio credentials (.env not loaded)."));
    }

    // 1) Download media
    const mediaUrl0 = req.body.MediaUrl0;
    const mediaCT0 = req.body.MediaContentType0 || "application/octet-stream";
    const ext = guessExtFromContentType(mediaCT0);
    const filename = `twilio_${Date.now()}.${ext}`;
    const filepath = path.join(DOWNLOAD_DIR, filename);

    const mediaResp = await downloadTwilioMedia(mediaUrl0);
    if (mediaResp.status !== 200) {
      const preview = Buffer.from(mediaResp.data || []).toString("utf8").slice(0, 200);
      console.log("Twilio download failed:", mediaResp.status, preview);
      return res.status(200).type("text/xml").send(twiml(`❌ Twilio media download failed (${mediaResp.status}).`));
    }
    fs.writeFileSync(filepath, Buffer.from(mediaResp.data));

    // 2) Ingest
    const form = new FormData();
    form.append("file", fs.createReadStream(filepath), { filename, contentType: mediaCT0 });

    const ingestResp = await axios.post(`${AGROCORE_BASE}/v1/ingest`, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: () => true,
      timeout: 60000,
    });

    if (ingestResp.status !== 200) {
      const errTxt = typeof ingestResp.data === "string" ? ingestResp.data : JSON.stringify(ingestResp.data);
      console.log("AgroCore ingest failed:", ingestResp.status, errTxt?.slice(0, 300));
      return res.status(200).type("text/xml").send(twiml(`❌ AgroCore ingest failed (${ingestResp.status}).`));
    }

    const ingestData = ingestResp.data || {};
    const formula_text = ingestData.formula_text || ingestData.text || "";
    if (!String(formula_text).trim()) {
      return res.status(200).type("text/xml").send(twiml("✅ File ingested, but no formula text extracted."));
    }

    const repExtract = extractReportedNutrients(ingestData);

    // 3) Analyze
    const analyzeResp = await axios.post(
      `${AGROCORE_BASE}/v1/analyze`,
      { locale: "US", formula_text },
      {
        headers: { "Content-Type": "application/json" },
        validateStatus: () => true,
        timeout: 60000,
      }
    );

    if (analyzeResp.status !== 200) {
      return res.status(200).type("text/xml").send(
        twiml(`✅ File ingested. ❌ Analyze failed (${analyzeResp.status}).`)
      );
    }

    const a = analyzeResp.data || {};

    // ✅ NEW: Clarification gating (don’t print table)
    if (a && a.ok === false && a.error === "NEEDS_CLARIFICATION") {
      const msg = buildClarificationReply(a);
      return res.status(200).type("text/xml").send(twiml(msg));
    }

    const calcExtract = extractCalculatedNutrients(a);

    const unknown =
      a.unknown ||
      a.unknown_ingredients ||
      a?.nutrient_profile?.unknown ||
      a?.nutrient_profile_full?.unknown ||
      [];

    const repKeys = Object.keys(repExtract.obj || {}).length;
    const calcKeys = Object.keys(calcExtract.obj || {}).length;
    const unkCount = Array.isArray(unknown) ? unknown.length : 0;

    // 4) Reply (same contract + debug)
    const header = `${VERSION}\nTotal: 100.00%`;
    const table = buildReportedVsCalculatedTable(repExtract.obj, calcExtract.obj);
    const debugLine = `\n\nDBG: reported_keys=${repKeys} | calculated_keys=${calcKeys} | unknown=${unkCount}`;

    return res.status(200).type("text/xml").send(twiml(`${header}\n\n${table}${debugLine}`));
  } catch (err) {
    console.log("ERROR:", err?.message || err);
    return res.status(200).type("text/xml").send(twiml("Server error. Check logs."));
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
