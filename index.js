// FILE: C:\Users\Administrator\My Drive\NutriPilot\nutripilot-agrocore\feedbot-whatsapp\index.js
"use strict";

/**
 * feedbot-whatsapp/index.js
 * NutriPilot vSafeReply ✅ (Thin Client →’ AgroCore API) v1.3 â€” LOCKED (PATCHED)
 *
 * Patch goal (minimal change, high impact):
 * ✅ ALWAYS respond to Twilio webhook immediately for media uploads (TwiML ACK)
 * ✅ Process media asynchronously and send final result via Twilio REST API
 * ✅ If Twilio REST send fails (e.g. 63038 daily cap), store result in session
 * ✅ User can type: RESULT  -> bot returns stored last result via normal TwiML reply
 *
 * This fixes "No response on PDF upload" even when Twilio outbound is blocked.
 */

require("dotenv").config();
// ── FarmPulse Performance Analyzer ────────────────────────────
const { parsePerfText, looksLikePerfData }               = require("./core/perf/perf-parser");
const { handleQA, buildMainMenu } = require("./core/qa/liveiq.qa.engine");
const { analyzePerformance }                             = require("./core/perf/perf-analyzer");
const { buildPerfTable, buildAdviceText }                = require("./core/perf/perf-formatter");
const { parseBreedFromText, parseAgeFromText, buildContextPrompt } = require("./core/perf/perf-context");

const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const { resolveIngredient, resolveFormulaText, resolveFormulaRows } = require("./core/resolver/ingredientResolver");
const { applyIngredientRulesToPool } = require("../nutripilot-agrocore/core/services/ingredient-rules.service.cjs");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use("/reports", express.static(path.join(__dirname, "public", "reports")));

const PORT = process.env.PORT || 3000;
const AGROCORE_BASE = process.env.AGROCORE_BASE || "http://localhost:3001";
const FEEDBOT_PUBLIC_BASE_URL =
  process.env.FEEDBOT_PUBLIC_BASE_URL || `http://localhost:${PORT}`;


const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";

// ---------------- Session store (simple in-memory) ----------------
const SESS = new Map();
const SESS_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const nowMs = () => Date.now();

function getSession(from) {
  const key = String(from || "anon");
  const s = SESS.get(key);
  if (s && nowMs() - (s.updatedAt || 0) < SESS_TTL_MS) return s;

  const fresh = {
    dm_overrides: {},
    pending_clarification: null, // { createdAt, normalize, formula_text, needs_clarification }
    last_async_result: null, // { text, createdAt, meta }
        perf_context:       null,
    pending_perf_data:  null,
    last_perf_data:     null,
    last_perf_result:   null,
    last_failed_formula: null, // { formula_text, ingestMeta, context, createdAt }
    updatedAt: nowMs(),
  };
  SESS.set(key, fresh);
  return fresh;
}
function touchSession(from) {
  const s = getSession(from);
  s.updatedAt = nowMs();
  return s;
}
function pruneSessions() {
  const t = nowMs();
  for (const [k, v] of SESS.entries()) {
    if (!v?.updatedAt || t - v.updatedAt > SESS_TTL_MS) SESS.delete(k);
  }
}

// ---------------- SafeReply wrapper ----------------
function twimlMessage(text) {
  const safe = String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${safe}</Message></Response>`;
}

async function SafeReply(handler, req, res) {
  try {
    const out = await handler(req, res);

    console.log("[DBG SafeReply after handler]", {
      headersSent: res.headersSent,
      out_type: typeof out,
      out_len: typeof out === "string" ? out.length : null,
      from: req?.body?.From || null,
      body_len: String(req?.body?.Body || "").length,
    });

    if (!res.headersSent) {
      const xml = twimlMessage(out || "OK");

      console.log("[DBG SafeReply sending TwiML]", {
        xml_len: xml.length,
        preview: xml.slice(0, 220),
      });

      return res.status(200).type("text/xml").send(xml);
    }

    console.log("[DBG SafeReply skipped send because headers already sent]");
    return;
  } catch (e) {
    const status = e?.response?.status;
    const data = e?.response?.data;
    const msg =
      (typeof data === "string" ? data : data?.message) ||
      e?.message ||
      "Unknown error";

    console.log("[DBG SafeReply ERROR]", {
      status,
      msg,
      from: req?.body?.From || null,
    });

    if (!res.headersSent) {
      const xml = twimlMessage(`âŒ Error${status ? ` (${status})` : ""}: ${msg}`);
      console.log("[DBG SafeReply sending ERROR TwiML]", {
        xml_len: xml.length,
        preview: xml.slice(0, 220),
      });
      return res.status(200).type("text/xml").send(xml);
    }
  }
}

// ---------------- Helpers ----------------
function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
function fmt(x, decimals = 2) {
  const n = num(x);
  if (n === null) return "-";
  if (decimals === 0) return String(Math.round(n));
  return String(Number(n.toFixed(decimals)));
}

function fmtNum(v, dec, maxDec = 2) {
  if (v === "-" || v == null) return "-";
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  // Use enough decimals to show micro-inclusions like 0.001, 0.006
  const decimals = Math.min(dec ?? 2, maxDec);
  const str = n.toFixed(decimals);
  // Only strip trailing .00 if the value is actually >= 0.01 (not a micro-inclusion)
  if (n >= 0.01) return str.replace(/\.00$/, "");
  // For micro-inclusions, use up to 3 decimal places
  return n.toFixed(Math.max(decimals, 3)).replace(/0+$/, "").replace(/\.$/, "");
}

function looksLikeGreeting(txt) {
  const t = (txt || "").trim().toLowerCase();
  if (!t) return true;
  return (
    t === "hi" ||
    t === "hello" ||
    t === "hey" ||
    t === "yes" ||
    t === "ok" ||
    t === "okay" ||
    t === "thanks" ||
    t === "thank you"
  );
}

function pickCalculated(r) {
  return r?.nutrient_profile_full || r?.nutrient_profile_core || r?.nutrient_profile || {};
}
function pickReportedPanel(r) {
  return r?.meta?.reported_nutrients || r?.reported_nutrients || null;
}
function pickReportedFallbackTargets(r) {
  return r?.requirements_canonical || null;
}
function pickLab(r) {
  return r?.meta?.lab_nutrients || r?.lab_nutrients || null;
}

function countKeys(obj) {
  if (!obj || typeof obj !== "object") return 0;
  return Object.keys(obj).length;
}

function calcTotalAndDeltaFromAnalyze(r) {
  const total = r?.parsed?.total ?? r?.parsed?.total_inclusion ?? null;
  if (total == null) return { total: null, delta: null };
  const delta = Number(total) - 100;
  return { total: Number(total), delta };
}

function extFromContentType(ct) {
  const c = String(ct || "").toLowerCase();
  if (c.includes("pdf")) return "pdf";
  if (c.includes("spreadsheetml") || c.includes("xlsx")) return "xlsx";
  if (c.includes("ms-excel") || c.includes("xls")) return "xls";
  if (c.includes("png")) return "png";
  if (c.includes("jpeg") || c.includes("jpg")) return "jpg";
  if (c.includes("image")) return "img";
  return "bin";
}

/**
 * NORMALIZE command (request-scoped)
 */
function extractNormalizeCommand(text) {
  let t = (text || "").trim();
  if (!t) return { normalize: false, text: "" };

  const upper = t.toUpperCase();
  const isNormalize =
    upper === "NORMALIZE" ||
    upper.startsWith("NORMALIZE ") ||
    upper.startsWith("NORMALIZE\n") ||
    upper.startsWith("NORMALIZE\r\n");

  if (!isNormalize) return { normalize: false, text: t };

  const rest = t.split(/\r?\n/).slice(1).join("\n").trim();
  return { normalize: true, text: rest };
}

// ---------------- Text "REPORTED" block parsing ----------------
function normalizeSpaces(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}
function parseNumberFromLine(line) {
  const m = String(line || "").replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}
function labelToKey(rawLabel) {
  const L = normalizeSpaces(rawLabel).toUpperCase();

  if (L === "ME") return "me";
  if (L === "CP") return "cp";
  if (L === "CA") return "ca";
  if (L === "AVP" || L === "AV.P" || L === "AV P" || L === "AVAILABLE P") return "avp";
  if (L === "NA") return "na";
  if (L === "K") return "k";
  if (L === "CL") return "cl";
  if (L === "DEB") return "deb";
  if (L === "DM") return "dm";

  if (L === "SID LYS" || L === "SIDLYS") return "sid_lys";
  if (L === "SID MET" || L === "SIDMET") return "sid_met";
  if (L === "SID M+C" || L === "SID M+CYS" || L === "SID MET+CYS" || L === "SIDMETCYS") return "sid_metcys";
  if (L === "SID THR" || L === "SIDTHR") return "sid_thr";
  if (L === "SID TRP" || L === "SIDTRP") return "sid_trp";
  if (L === "SID ARG" || L === "SIDARG") return "sid_arg";

  return null;
}

function extractReportedBlock(text) {
  const raw = String(text || "").replace(/\r/g, "\n");
  const lines = raw.split("\n");

  const idx = lines.findIndex((l) => normalizeSpaces(l).toUpperCase() === "REPORTED");
  if (idx === -1) return { reported_nutrients: null, clean_text: raw.trim() };

  const reported = {};
  const keep = [];

  for (let i = 0; i < idx; i++) keep.push(lines[i]);

  let i = idx + 1;
  let seenBlankAfterReported = false;

  for (; i < lines.length; i++) {
    const ln = lines[i];
    const t = normalizeSpaces(ln);

    if (!t) {
      if (Object.keys(reported).length > 0) {
        seenBlankAfterReported = true;
        continue;
      }
      continue;
    }

    if (seenBlankAfterReported) {
      keep.push(ln);
      continue;
    }

    const firstNumMatch = t.match(/-?\d/);
    if (!firstNumMatch) {
      if (Object.keys(reported).length > 0) {
        seenBlankAfterReported = true;
        keep.push(ln);
      }
      continue;
    }

    const pos = firstNumMatch.index ?? 0;
    const left = t.slice(0, pos).trim();
    const key = labelToKey(left);
    const val = parseNumberFromLine(t);

    if (key && val != null) {
      reported[key] = val;
    } else {
      if (Object.keys(reported).length > 0) {
        seenBlankAfterReported = true;
        keep.push(ln);
      }
    }
  }

  const clean_text = keep.join("\n").trim();
  const reported_nutrients = Object.keys(reported).length ? reported : null;
  return { reported_nutrients, clean_text };
}

// ---------------- DM command parsing ----------------
function tryHandleDmCommand(body, session) {
  const t = (body || "").trim();

  if (/^DM\s+SHOW$/i.test(t)) {
    const dmCorn = session?.dm_overrides?.corn;
    return `DM overrides:\n- CORN: ${dmCorn != null ? fmt(dmCorn, 2) + "%" : "-"}\n\nSet with: DM CORN 86.5\nClear with: DM CLEAR`;
  }

  if (/^DM\s+CLEAR$/i.test(t)) {
    session.dm_overrides = {};
    return "✅ DM overrides cleared.";
  }

  const m = t.match(/^DM\s+(CORN|MAIZE)\s+([0-9]+(\.[0-9]+)?)$/i);
  if (m) {
    const who = m[1].toUpperCase();
    const v = Number(m[2]);
    if (!(v >= 50 && v <= 95)) return "âŒ DM must be between 50 and 95. Example: DM CORN 86.5";
    session.dm_overrides.corn = v;
    session.updatedAt = nowMs();
    return `✅ DM set: ${who} = ${fmt(v, 2)}%\n(Will be applied when AgroCore DM calibration is enabled.)`;
  }

  return null;
}

// ---------------- Clarification-mode parsing (unchanged) ----------------
function parseGradeOnlyReply(text) {
  const t = normalizeSpaces(String(text || "").replace(/\r/g, "\n").replace(/\n/g, " "));
  if (!t) return [];

  const out = [];
  const reSBM = /\bSBM\s+(44|46|48)(?:\s+([0-9]+(?:\.[0-9]+)?))?/gi;
  const reCan = /\bCanola\s+Meal\s+(34|36|38)(?:\s+([0-9]+(?:\.[0-9]+)?))?/gi;
  const reRap = /\bRapeseed\s+Meal\s+(28|30)(?:\s+([0-9]+(?:\.[0-9]+)?))?/gi;

  let m;
  while ((m = reSBM.exec(t))) out.push({ family: "soybean_meal", grade: Number(m[1]), inclusion: m[2] != null ? Number(m[2]) : null });
  while ((m = reCan.exec(t))) out.push({ family: "canola_rapeseed", kind: "canola", grade: Number(m[1]), inclusion: m[2] != null ? Number(m[2]) : null });
  while ((m = reRap.exec(t))) out.push({ family: "canola_rapeseed", kind: "rapeseed", grade: Number(m[1]), inclusion: m[2] != null ? Number(m[2]) : null });

  return out;
}

function looksLikeGradeOnlyReply(text) {
  const matches = parseGradeOnlyReply(text);
  if (!matches.length) return false;

  const raw = String(text || "");
  const lineCount = raw.replace(/\r/g, "\n").split("\n").filter((l) => l.trim()).length;
  if (lineCount >= 4) return false;

  return true;
}

function buildReplacementLinesFromNeeds(pendingNeeds, parsedReplies) {
  const needs = Array.isArray(pendingNeeds) ? pendingNeeds : [];
  const needByFamily = new Map();
  for (const n of needs) if (n?.family && !needByFamily.has(n.family)) needByFamily.set(n.family, n);

  const replacement = [];

  for (const r of parsedReplies) {
    const need = needByFamily.get(r.family);

    const storedInc =
      need && need.inclusion != null && Number.isFinite(Number(need.inclusion))
        ? Number(need.inclusion)
        : null;

    const inc =
      storedInc != null
        ? storedInc
        : (r.inclusion != null ? Number(r.inclusion) : null);

    if (inc == null) continue;

    if (r.family === "soybean_meal") replacement.push(`SBM ${r.grade} ${inc}`);
    else if (r.family === "canola_rapeseed") {
      if (r.kind === "canola") replacement.push(`Canola meal ${r.grade} ${inc}`);
      else if (r.kind === "rapeseed") replacement.push(`Rapeseed meal ${r.grade} ${inc}`);
    }
  }

  const dedup = new Map();
  for (const ln of replacement) dedup.set(ln.split(/\s+/).slice(0, 3).join(" ").toLowerCase(), ln);
  return Array.from(dedup.values());
}

function applyClarificationsToPreviousFormula(prevFormulaText, replacementLines) {
  const base = String(prevFormulaText || "").replace(/\r/g, "");
  const baseLines = base.split("\n").map((x) => x.trim()).filter(Boolean);

  const filtered = [];
  for (const line of baseLines) {
    if (/^SBM\b/i.test(line)) continue;
    if (/^(Canola\s+Meal|Rapeseed\s+Meal)\b/i.test(line)) continue;
    filtered.push(line);
  }

  const outLines = filtered.concat(replacementLines);
  return outLines.join("\n").trim();
}

// ---------------- Twilio media download (axios Basic Auth) ----------------
async function downloadTwilioMedia(mediaUrl) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    throw new Error("Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN in environment.");
  }

  const resp = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    timeout: 25000,
    auth: { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN },
    validateStatus: () => true,
  });

  if (resp.status < 200 || resp.status >= 300) {
    const preview = Buffer.isBuffer(resp.data)
      ? resp.data.toString("utf8", 0, 120)
      : String(resp.data).slice(0, 120);
    throw new Error(`Twilio media download failed: ${resp.status} ${resp.statusText} | ${preview}`);
  }

  const buf = Buffer.from(resp.data);
  const contentType = resp.headers?.["content-type"] || "";
  return { buf, contentType };
}

async function agrocoreIngestBytes(buf, contentType, filename) {
  const form = new FormData();
  form.append("file", buf, { filename, contentType: contentType || "application/octet-stream" });

  const resp = await axios.post(`${AGROCORE_BASE}/v1/ingest`, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 30000,
    validateStatus: () => true,
  });

  if (resp.status < 200 || resp.status >= 300) {
    const preview = typeof resp.data === "string" ? resp.data.slice(0, 200) : JSON.stringify(resp.data).slice(0, 200);
    throw new Error(`AgroCore ingest failed (${resp.status}): ${preview}`);
  }

  const json = resp.data;
  if (!json || json.ok === false) throw new Error(`AgroCore ingest failed: ${json?.message || "unknown"}`);
  return json;
}

// ---------------- Twilio outbound send (WhatsApp) ----------------
async function twilioSendWhatsApp({ to, from, body }) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    throw new Error("Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN in environment.");
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;

  const form = new URLSearchParams();
  form.set("To", String(to || ""));
  form.set("From", String(from || ""));
  form.set("Body", String(body || ""));

  const resp = await axios.post(url, form.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    auth: { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN },
    timeout: 25000,
    validateStatus: () => true,
  });

  if (resp.status < 200 || resp.status >= 300) {
    const payload = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data);
    throw new Error(`Twilio send failed (${resp.status}): ${payload}`);
  }

  return resp.data;
}

// ---------------- Rendering (NEAT WhatsApp MONOSPACE table) ----------------
function padRight(s, w) {
  s = String(s ?? "");
  if (s.length >= w) return s;
  return s + " ".repeat(w - s.length);
}
function padLeft(s, w) {
  s = String(s ?? "");
  if (s.length >= w) return s;
  return " ".repeat(w - s.length) + s;
}

function fmtNum(v, dec, maxDec = 2) {
  if (v === "-" || v == null) return "-";
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  return n.toFixed(Math.min(dec ?? 2, maxDec));
}

function buildNeatTable({ rAnalyze, ingestMeta, session }) {
  const calc = pickCalculated(rAnalyze);
  const panel = pickReportedPanel(rAnalyze) || ingestMeta?.reported_nutrients || {};
  const req = rAnalyze?.requirements_canonical || {};
  const dev = rAnalyze?.deviations_canonical || {};
  const ev = rAnalyze?.evaluation || {};

  function fmtWa(v) {
    if (v === null || v === undefined || v === "" || Number.isNaN(Number(v))) return "-";
    const n = Number(v);
    if (Math.abs(n) >= 100) return String(Math.round(n));
    return n.toFixed(2);
  }

  function val(obj, key) {
    const v = obj && obj[key] != null ? obj[key] : null;
    return fmtWa(v);
  }

  function target(key) {
    const v = dev?.[key]?.required ?? dev?.[key]?.target ?? req?.[key] ?? null;
    return fmtWa(v);
  }

  function status(key) {
    if (dev?.[key]?.status) return dev[key].status;

    const f = Array.isArray(ev?.findings)
      ? ev.findings.find((x) => String(x?.nutrient || "").toLowerCase() === key)
      : null;

    return f?.status || (req?.[key] != null ? "OK" : "INFO");
  }

  function statusSymbol(st) {
    const s = String(st || "").toUpperCase();
    if (s === "OK") return "✓";
    if (s === "WARN") return "~";
    if (s === "FAIL") return "x";
    if (s === "INFO") return "i";
    return "-";
  }

  function padLabel(v) {
    return String(v ?? "-").padEnd(4, " ");
  }

  function padNum(v) {
    return String(v ?? "-").padStart(5, " ");
  }

  const rows = [
    ["ME", "me"],
    ["CP", "cp"],
    ["Ca", "ca"],
    ["AvP", "avp"],
    ["Lys", "sid_lys"],
    ["Met", "sid_met"],
    ["Cys", "sid_cys"],
    ["M+C", "sid_metcys"],
    ["Thr", "sid_thr"],
    ["Trp", "sid_trp"],
    ["Arg", "sid_arg"],
  ];

  const out = [];

  const overallStatus = ev?.overall || rAnalyze?.overall || "NO_STATUS";
  const statusEmoji = overallStatus === "OK" ? "✅" : overallStatus === "WARN" ? "⚠️" : "❌";
  const reqKey = rAnalyze?.requirements_used?.reqKey || "";
  const breedLabel = reqKey.replace("poultry_","").replace(/_/g," ").replace(/v\d+$/,"").trim().replace(/\b\w/g, c => c.toUpperCase());

  out.push("🌾 *AgroCore AI*");
  out.push("━━━━━━━━━━━━━━━━━━━");
  out.push(`${statusEmoji} *Status: ${overallStatus}*`);
  if (breedLabel) out.push(`📋 ${breedLabel}`);
  out.push("━━━━━━━━━━━━━━━━━━━");
  out.push("");
  out.push("*Nutrient Analysis*");
  out.push("");
  out.push("Nutr|  Rep| Calc|  Tgt|S");
  out.push("----|-----|-----|-----|-");

  for (const [label, key] of rows) {
    const reported = val(panel, key);
    const calculated = val(calc, key);
    const tgt = target(key);
    const st = statusSymbol(status(key));

    if (reported === "-" && calculated === "-" && tgt === "-") continue;
    if (tgt === "0.00" || tgt === "0") continue;

    out.push(
      `${padLabel(label)}|${padNum(reported)}|${padNum(calculated)}|${padNum(tgt)}|${st}`
    );
  }

  out.push("");
  out.push("");
  out.push("✓ OK  ~ WARN  x FAIL");
  out.push("━━━━━━━━━━━━━━━━━━━");
  out.push("Reply *FIX* to auto-correct | *RESULT* to resend");

  return "```" + "\n" + out.join("\n") + "\n```";
}

function buildEvaluationSummary(r) {
  return "";
}

function buildOptimizedFormulaText(opt, originalFormulaText) {
  const optimizedPool =
    (Array.isArray(opt?.optimized_formula) && opt.optimized_formula) ||
    (Array.isArray(opt?.optimizedFormula) && opt.optimizedFormula) ||
    (Array.isArray(opt?.result?.optimized_formula) && opt.result.optimized_formula) ||
    (Array.isArray(opt?.result?.optimizedFormula) && opt.result.optimizedFormula) ||
    (Array.isArray(opt?.starting_formula_comparison) && opt.starting_formula_comparison) ||
    (Array.isArray(opt?.startingFormulaComparison) && opt.startingFormulaComparison) ||
    (Array.isArray(opt?.inclusion_delta) && opt.inclusion_delta) ||
    (Array.isArray(opt?.inclusionDelta) && opt.inclusionDelta) ||
    [];

  if (!optimizedPool.length) return "";

  const originalNameById = new Map(
    String(originalFormulaText || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^(.+?)\s+(-?\d+(\.\d+)?)$/);
        if (!m) return null;

        const ingredient_name = String(m[1] || "").trim();
        const id = ingredient_name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "");

        return [id, ingredient_name];
      })
      .filter(Boolean)
  );

  const lines = optimizedPool
    .map((row) => {
      const name =
        row?.ingredient_name ||
        row?.display_name ||
        row?.ingredient ||
        row?.name ||
        row?.ingredient_id ||
        row?.id ||
        originalNameById.get(String(row?.id || "").trim()) ||
        "Ingredient";

      const inclusion =
        row?.optimized_inclusion ??
        row?.optimizedInclusion ??
        row?.optimized_value ??
        row?.optimizedValue ??
        row?.new_inclusion ??
        row?.newInclusion ??
        row?.inclusion ??
        row?.value ??
        row?.optimized ??
        null;

      if (!Number.isFinite(Number(inclusion))) return null;
      if (Number(inclusion) <= 0) return null;

      return `${name} ${fmt(Number(inclusion), 3)}`;
    })
    .filter(Boolean);

  return lines.join("\n");
}

function normalizeFamilyName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseClarificationReply(text, pendingList) {
  const raw = String(text || "").trim();
  const pending = Array.isArray(pendingList) ? pendingList : [];
  const out = {};

  if (!raw || !pending.length) return out;

  // 1) numbered form: 1-48 2-36 3-54
  const numberedMatches = [...raw.matchAll(/(\d+)\s*[-:=]\s*(\d+(?:\.\d+)?)/gi)];
  if (numberedMatches.length) {
    for (const m of numberedMatches) {
      const idx = Number(m[1]);
      const cp = Number(m[2]);
      if (Number.isFinite(idx) && Number.isFinite(cp) && pending[idx - 1]) {
        out[idx - 1] = cp;
      }
    }
    return out;
  }

  // 2) plain ordered values: 48, 36, 54
  const orderedVals = [...raw.matchAll(/\b(\d+(?:\.\d+)?)\b/g)].map((m) => Number(m[1]));
  if (orderedVals.length && orderedVals.length <= pending.length) {
    for (let i = 0; i < orderedVals.length; i++) {
      if (Number.isFinite(orderedVals[i])) out[i] = orderedVals[i];
    }
    return out;
  }

  // 3) family-based forms: soybean 48, canola 36, fish 54 / SBM48
  const familyPatterns = [
    { family: "soybean_meal", rx: /\b(?:soybean|sbm)\s*(?:meal)?\s*(\d+(?:\.\d+)?)\b/gi },
    { family: "canola_rapeseed", rx: /\b(?:canola|rapeseed)\s*(?:meal)?\s*(\d+(?:\.\d+)?)\b/gi },
    { family: "fish_meal", rx: /\b(?:fish)\s*(?:meal)?\s*(\d+(?:\.\d+)?)\b/gi },
    { family: "sunflower_meal", rx: /\b(?:sunflower)\s*(?:meal)?\s*(\d+(?:\.\d+)?)\b/gi },
    { family: "corn_gluten_meal", rx: /\b(?:cgm|corn\s*gluten(?:\s*meal)?)\s*(\d+(?:\.\d+)?)\b/gi },
    { family: "ddgs", rx: /\b(?:ddgs|corn\s*ddgs)\s*(\d+(?:\.\d+)?)\b/gi },
    { family: "meat_bone_meal", rx: /\b(?:mbm|meat\s*(?:and)?\s*bone(?:\s*meal)?)\s*(\d+(?:\.\d+)?)\b/gi }
  ];

  for (const fp of familyPatterns) {
    const matches = [...raw.matchAll(fp.rx)];
    if (!matches.length) continue;

    for (let i = 0; i < pending.length; i++) {
      if (pending[i]?.family !== fp.family) continue;
      const cp = Number(matches[0][1]);
      if (Number.isFinite(cp)) out[i] = cp;
    }
  }

  return out;
}

function applyClarificationToFormula(formulaText, pendingList, resolvedMap) {
  const lines = String(formulaText || "").split(/\r?\n/);
  const pending = Array.isArray(pendingList) ? pendingList : [];

  for (const [idxStr, cp] of Object.entries(resolvedMap || {})) {
    const idx = Number(idxStr);
    const item = pending[idx];
    if (!item) continue;

    const raw = String(item.raw || "").trim();
    const inclusion = item.inclusion;
    const family = item.family;

    let replacementName = raw;

    if (family === "soybean_meal") replacementName = `SBM ${cp}`;
    else if (family === "canola_rapeseed") replacementName = `Canola Meal ${cp}`;
    else if (family === "fish_meal") replacementName = `Fish Meal ${cp}`;
    else if (family === "sunflower_meal") replacementName = `Sunflower Meal ${cp}`;
    else if (family === "corn_gluten_meal") replacementName = `CGM ${cp}`;
    else if (family === "ddgs") replacementName = `Corn DDGS ${cp}`;
    else if (family === "meat_bone_meal") replacementName = `MBM ${cp}`;

    const rawNorm = normalizeFamilyName(raw);

    for (let li = 0; li < lines.length; li++) {
      const line = String(lines[li] || "").trim();
      const m = line.match(/^(.+?)\s+(-?\d+(?:\.\d+)?)$/);
      if (!m) continue;

      const name = String(m[1] || "").trim();
      const inc = Number(m[2]);
      const nameNorm = normalizeFamilyName(name);

      if (nameNorm === rawNorm && Number(inc) === Number(inclusion)) {
        lines[li] = `${replacementName} ${inc}`;
        break;
      }
    }
  }

  return lines.join("\n");
}

function buildNumberedClarificationPrompt(needs) {
  const arr = Array.isArray(needs) ? needs : [];
  const lines = [];
  lines.push("âš ï¸ Need CP/grade clarification before accurate analysis:");

  arr.forEach((c, i) => {
    let opts = "";
    if (Array.isArray(c.options) && c.options.length) {
      opts = ` (${c.options.map((x) => String(x).replace(/^.*?(\d+(\.\d+)?).*?$/, "$1")).join(" / ")})`;
    }
    lines.push(`${i + 1}. ${c.raw}${opts}`);
  });

  lines.push("");
  lines.push("Reply in any of these formats:");
  lines.push("1-48, 2-36, 3-54");
  lines.push("48, 36, 54");
  lines.push("soybean 48, canola 36, fish 54");
  lines.push("SBM48 Canola36 Fish54");

  return lines.join("\n");
}

function isNeedsClarificationResponse(r) {
  return (
    r?.error === "NEEDS_CLARIFICATION" ||
    r?.code === "NEEDS_CLARIFICATION" ||
    r?.status === "NEEDS_CLARIFICATION" ||
    (Array.isArray(r?.needs_clarification) && r.needs_clarification.length > 0) ||
    !!r?.clarification_text
  );
}

function buildFinalReply({ rAnalyze, ingestMeta, session }) {
  const table = buildNeatTable({ rAnalyze, ingestMeta, session });
  const evalSummary = buildEvaluationSummary(rAnalyze);

  const { total, delta } = calcTotalAndDeltaFromAnalyze(rAnalyze);
  let driftHint = "";

  if (total != null && Math.abs(delta) >= 0.25) {
    const sign = delta >= 0 ? "+" : "";
    driftHint =
      `\n\nâš ï¸ Total drift detected (Î” ${sign}${fmt(delta, 2)}%). ` +
      `This can happen from PDF rounding/parsing. Use NORMALIZE to scale to 100.00%.`;
  }

  return `${table}${evalSummary}`;
}

// ---------------- Core (shared) analyze helper ----------------
async function runAnalyze({ formula_text, resolved_rows = [], ingestMeta, session }) {
  const hasResolvedRows = Array.isArray(resolved_rows) && resolved_rows.length > 0;

  const resolvedFormulaText = hasResolvedRows
    ? resolved_rows
        .filter((r) => r && r.ingredient_id && Number.isFinite(Number(r.inclusion)))
        .map((r) => `${String(r.ingredient_id).trim()} ${Number(r.inclusion)}`)
        .join("\n")
    : resolveFormulaText(formula_text);

  const resolvedFormulaRows = hasResolvedRows
    ? resolved_rows.map((r) => ({
        id: r.ingredient_id || r.canonical_id || null,
        ingredient_id: r.ingredient_id || r.canonical_id || null,
        name: r.ingredient_name || r.raw_name || r.ingredient_id || "",
        raw_name: r.raw_name || r.ingredient_name || r.ingredient_id || "",
        matched_name: r.ingredient_name || r.ingredient_id || "",
        canonical_id: r.canonical_id || r.ingredient_id || null,
        ingredient_code: r.ingredient_code || r.ingredient_id || null,
        inclusion: Number(r.inclusion || 0),
        resolved: true,
        confidence: 1,
        nutritive: r.nutritive !== false,
      }))
    : resolveFormulaRows(formula_text);

  // ---------------- CONTEXT GATE ----------------
  if (!session?.context || !session.context.breed || !session.context.phase) {
    session.pending_context = {
      formula_text,
      resolved_rows,
      ingestMeta,
    };

    return {
      needs_context: true,
      message: `Please select context:

1. Broiler →’ Ross308 →’ Starter
2. Broiler →’ Cobb500 →’ Starter
3. Layer →’ Hy-Line →’ Peak
4. Type manually (e.g. "Ross308 starter")`,
    };
  }

  const body = {
    locale: session?.context?.locale || "US",
    region: session?.context?.region || "global",
    version: session?.context?.version || "v1",
    species: session?.context?.species || "poultry",
    type: session?.context?.type || "broiler",
    production: session?.context?.production || "meat",
    breed: session?.context?.breed || "generic",
    phase: session?.context?.phase || null,

    formula_text: resolvedFormulaText,
    resolved_rows: hasResolvedRows ? resolved_rows : [],
    formula_rows: resolvedFormulaRows,

    normalize: !!ingestMeta?.normalize,
    dm_overrides: session?.dm_overrides || {},
    reported_nutrients: ingestMeta?.reported_nutrients || undefined,
  };

  const resp = await axios.post(`${AGROCORE_BASE}/v1/analyze`, body, { timeout: 25000 });
  const r = resp.data;

  console.log("[DBG analyze raw keys]", {
    has_npf: !!r?.nutrient_profile_full,
    npf_keys: r?.nutrient_profile_full ? Object.keys(r.nutrient_profile_full).slice(0, 30) : [],

    me: r?.nutrient_profile_full?.me,
    cp: r?.nutrient_profile_full?.cp,
    ca: r?.nutrient_profile_full?.ca,
    avp: r?.nutrient_profile_full?.avp,
    ee: r?.nutrient_profile_full?.ee,
    cf: r?.nutrient_profile_full?.cf,
    sid_lys: r?.nutrient_profile_full?.sid_lys,
    sid_met: r?.nutrient_profile_full?.sid_met,
    sid_metcys: r?.nutrient_profile_full?.sid_metcys,

    eval_used: r?.evaluation_keys_used,
    unknown_len: r?.nutrient_profile_full?.unknown?.length,
    unknown_items: Array.isArray(r?.nutrient_profile_full?.unknown) ? r.nutrient_profile_full.unknown : [],
    version: r?.version,
    parsed_total: r?.parsed?.total ?? r?.parsed?.total_inclusion ?? null,
    normalize_sent: !!ingestMeta?.normalize,
    pending_exists: !!session?.pending_clarification,
    has_reported_block: !!ingestMeta?.reported_nutrients,
    resolved_rows_count: hasResolvedRows
      ? resolved_rows.length
      : (Array.isArray(resolvedFormulaRows) ? resolvedFormulaRows.length : 0),
  });

  if (ingestMeta?.reported_nutrients && !r?.meta?.reported_nutrients) {
    r.meta = r.meta || {};
    r.meta.reported_nutrients = ingestMeta.reported_nutrients;
  }

  if (ingestMeta?.reported_total != null && r?.meta?.reported_total == null) {
    r.meta = r.meta || {};
    r.meta.reported_total = ingestMeta.reported_total;
  }

  return r;
}

async function runOptimize({ formula_text, ingestMeta, session, lastFail, scenario }) {
    scenario = scenario || "balance";
      let movement_limits = {
    max_total_change_pct: 12,
    per_ingredient_max: 5,
  };

  if (scenario === "cost") {
    movement_limits = {
      max_total_change_pct: 20,
      per_ingredient_max: 10,
    };
  }

  if (scenario === "low_synthetic") {
    movement_limits = {
      max_total_change_pct: 15,
      per_ingredient_max: 8,
    };
  }
  const analyzeResult = lastFail?.analyze_result || lastFail?.analysis || {};

  const reported =
    pickReportedPanel(analyzeResult) ||
    pickReportedFallbackTargets(analyzeResult) ||
    ingestMeta?.reported_nutrients ||
    {};

  const resolvedRows =
    Array.isArray(lastFail?.resolved_rows) && lastFail.resolved_rows.length
      ? lastFail.resolved_rows
      : resolveFormulaRows(formula_text);

  const ingredientProfileMap = await loadIngredientProfileMap();

  function getProfileFor(row) {
    return (
      row?.nutrient_profile ||
      row?.nutrient_profile_full ||
      ingredientProfileMap[row?.ingredient_code] ||
      ingredientProfileMap[row?.canonical_id] ||
      ingredientProfileMap[row?.ingredient_id] ||
      ingredientProfileMap[row?.id] ||
      {}
    );
  }

  const basePool = resolvedRows.map((row) => {
    const fallbackId = String(
      row?.ingredient_code ||
      row?.canonical_id ||
      row?.ingredient_id ||
      row?.matched_name ||
      row?.raw_name ||
      "ingredient"
    )
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");

    const id = row?.ingredient_code || row?.canonical_id || row?.ingredient_id || fallbackId;

    return {
      id,
      ingredient_code: row?.ingredient_code || id,
      ingredient_name: row?.matched_name || row?.ingredient_name || row?.raw_name || id,
      canonical_id: row?.canonical_id || row?.ingredient_id || id,
      inclusion: Number(row?.inclusion || 0),
      min: 0,
      max: 100,
      cost: 1,
      enabled: true,
      nutrient_profile: getProfileFor(row),
    };
  });

  const correctionPool = [
    { id: "limestone", ingredient_name: "Limestone", canonical_id: "limestone", inclusion: 0, min: 0, max: 15 },
    { id: "dcp", ingredient_name: "Dicalcium phosphate", canonical_id: "dcp", inclusion: 0, min: 0, max: 10 },
    { id: "acid_oil", ingredient_name: "Acid Oil", canonical_id: "acid_oil", inclusion: 0, min: 0, max: 10 },
    { id: "l_ile", ingredient_name: "L-Isoleucine", canonical_id: "l_ile", inclusion: 0, min: 0, max: 1 },
    { id: "l_val", ingredient_name: "L-Valine", canonical_id: "l_val", inclusion: 0, min: 0, max: 1 },
    { id: "l_arg", ingredient_name: "L-Arginine", canonical_id: "l_arg", inclusion: 0, min: 0, max: 1 },
    { id: "l_lys_sulfate", ingredient_name: "L-Lysine Sulfate", canonical_id: "l_lys_sulfate", inclusion: 0, min: 0, max: 3 },
    { id: "anti_coccidial", ingredient_name: "Anti-Coccidial", canonical_id: "anti_coccidial", inclusion: 0, min: 0, max: 0.1 },
    { id: "vit_min_premix", ingredient_name: "Vit+Min Premix", canonical_id: "vit_min_premix", inclusion: 0, min: 0, max: 1 },
    { id: "meat_bone_meal_45_cp", ingredient_name: "MBM 45%", canonical_id: "meat_bone_meal_45_cp", inclusion: 0, min: 0, max: 15 },
    { id: "dl_met", ingredient_name: "DL-Methionine", canonical_id: "dl_met", inclusion: 0, min: 0, max: 2 },
    { id: "l_lys_hcl", ingredient_name: "L-Lysine HCl", canonical_id: "l_lys_hcl", inclusion: 0, min: 0, max: 2 },
    { id: "l_thr", ingredient_name: "L-Threonine", canonical_id: "l_thr", inclusion: 0, min: 0, max: 2 },
    { id: "l_trp", ingredient_name: "L-Tryptophan", canonical_id: "l_trp", inclusion: 0, min: 0, max: 1 },
    { id: "salt", ingredient_name: "Salt", canonical_id: "salt", inclusion: 0, min: 0, max: 2 },
    { id: "soy_oil", ingredient_name: "Soybean Oil", canonical_id: "soy_oil", inclusion: 0, min: 0, max: 10 },
    { id: "sodium_bicarbonate", ingredient_name: "Sodium bicarbonate", canonical_id: "sodium_bicarbonate", inclusion: 0, min: 0, max: 2 },
  ].map((x) => ({
    ...x,
    ingredient_code: x.id,
    cost: 1,
    enabled: true,
    nutrient_profile: ingredientProfileMap[x.id] || {},
  }));

  const seenIds = new Set(basePool.map((x) => String(x.id || "").toLowerCase()));

  const ingredient_pool = [
    ...basePool,
    ...correctionPool.filter((x) => !seenIds.has(String(x.id || "").toLowerCase())),
  ];

  const formula_rows = ingredient_pool.map((x) => ({
    id: x.id,
    inclusion: Number(x.inclusion || 0),
  }));

  const nutrientMap = [
    ["me", "me"],
    ["cp", "cp"],
    ["sid_lys", "lys"],
    ["sid_met", "met"],
    ["sid_metcys", "metcys"],
    ["sid_thr", "thr"],
    ["sid_trp", "trp"],
    ["sid_arg", "arg"],
    ["ca", "ca"],
    ["avp", "avp"],
    ["na", "na"],
    ["k", "k"],
    ["cl", "cl"],
    ["deb", "deb"],
  ];

  const nutrient_constraints = nutrientMap
    .filter(([srcKey]) => reported?.[srcKey] != null && Number.isFinite(Number(reported[srcKey])))
    .map(([srcKey, optimizerKey]) => ({
      key: optimizerKey,
      min: Number(reported[srcKey]),
      max: null,
      target: Number(reported[srcKey]),
      enabled: true,
    }));

  const ctx = session?.context || {};

const payloadContext = {
  species: ctx.species || "poultry",
  type: ctx.type || "broiler",
  production: ctx.production || "meat",
  breed: ctx.breed || "Ross308",
  phase: ctx.phase || "starter",
};

const body = {
    mode: "deep_fix_limited",

    locale: ctx.locale || "US",
    region: ctx.region || "global",
    version: ctx.version || "v1",

species: payloadContext.species,
type: payloadContext.type,
production: payloadContext.production,
breed: payloadContext.breed,
phase: payloadContext.phase,

    objective: "least_cost",
    optimization_profile: "deep_fix_limited",
    priority_note: "nutrition_first_limited_whatsapp",

    ingredient_pool,
    starting_formula: formula_rows,
    nutrient_constraints,

    movement_limits,

    ingredient_policy: {
      allow_new_ingredients: true,
      allow_removal: false,
    },

    source: "whatsapp_deep_fix_limited",
  };

const ruleResult = applyIngredientRulesToPool(body.ingredient_pool, payloadContext);

body.ingredient_pool = ruleResult.ingredient_pool;
body.practical_rule_version = ruleResult.rule_version;
body.practical_rule_warnings = ruleResult.warnings;
body.practical_rule_detected = ruleResult.detected;

  console.log("[DEEP_FIX] optimize payload check", {
    ingredient_pool_count: body.ingredient_pool.length,
    starting_formula_count: formula_rows.length,
    nutrient_constraints_count: nutrient_constraints.length,
    profiles_with_keys: body.ingredient_pool.filter(
  (x) => x.nutrient_profile && Object.keys(x.nutrient_profile).length > 0
).length,
practical_rule_version: body.practical_rule_version,
practical_rule_detected_count: Array.isArray(body.practical_rule_detected)
  ? body.practical_rule_detected.length
  : 0,
practical_rule_warning_count: Array.isArray(body.practical_rule_warnings)
  ? body.practical_rule_warnings.length
  : 0,
  });

  const resp = await axios.post(`${AGROCORE_BASE}/v1/optimize`, body, {
    timeout: 30000,
    validateStatus: () => true,
  });

  if (resp.status < 200 || resp.status >= 300) {
    const msg =
      (typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data, null, 2)) ||
      `optimizer request failed (${resp.status})`;
    throw new Error(`optimizer request failed (${resp.status}): ${msg}`);
  }

  return resp.data;
}

// ---------------- Async media processor ----------------
function startAsyncMediaJob({ From, To, MediaUrl0, MediaContentType0, _override }) {
  setImmediate(async () => {
    const session = touchSession(From);
    const ingestMeta = _override?.ingestMeta || {};

    try {
      console.log("[DBG async media] start", { From, MediaUrl0, override: !!_override });

      let formula_text, resolved_rows;

      if (_override) {
        formula_text = _override.formula_text;
        resolved_rows = _override.resolved_rows || [];
      } else {
        const dl = await downloadTwilioMedia(MediaUrl0);
      const contentType = dl.contentType || MediaContentType0 || "application/octet-stream";
      const ext = extFromContentType(contentType);
      const filename = `upload.${ext}`;

      const ing = await agrocoreIngestBytes(dl.buf, contentType, filename);

      const ft = String(ing?.formula_text || "");
      const rn = ing?.meta?.reported_nutrients || ing?.reported_nutrients || null;
      const rt = ing?.meta?.reported_total ?? ing?.reported_total ?? null;

      console.log("[DBG ingest keys]", {
        ok: ing?.ok,
        formula_text_len: ft.length,
        formula_text_head: ft.slice(0, 120),
        has_reported_nutrients: !!rn && typeof rn === "object" && Object.keys(rn).length > 0,
        reported_keys: rn && typeof rn === "object" ? Object.keys(rn).slice(0, 25) : [],
        reported_total: rt,
        route_version: ing?.meta?.route_version,
      });

      ingestMeta.reported_nutrients = rn || null;
      ingestMeta.reported_total = rt ?? null;
      ingestMeta.route_version = ing?.meta?.route_version;

      formula_text = ft.trim();
        if (!formula_text) throw new Error("Ingest ok but formula_text empty.");
        resolved_rows = Array.isArray(ing?.resolved_rows) ? ing.resolved_rows : [];
      } // end else _override

      // Check for unresolved ingredients
      const unresolved = resolved_rows.filter(r => r.resolved === false && r.match_confidence === 0);
      if (unresolved.length > 0) {
        const names = unresolved.map((r, i) => `${i+1}. "${r.raw_name}" (${Number(r.inclusion||0).toFixed(2)}%)`).join('\n');
        session.pending_unresolved = {
          formula_text,
          resolved_rows,
          ingestMeta,
          unresolved,
          createdAt: nowMs(),
        };
        session.updatedAt = nowMs();
        await twilioSendWhatsApp({
          to: From, from: To,
          body: `⚠️ I found ${unresolved.length} ingredient(s) I don't recognize:\n\n${names}\n\nReply with the correct name for each, e.g:\n1. Corn Gluten Meal 60%\n2. Canola Meal 36%\n\nOr reply SKIP to analyze without them.`
        });
        return;
      }

      console.log("[DBG media analyze handoff]", {
        formula_text_len: formula_text.length,
        resolved_rows_count: resolved_rows.length,
        resolved_rows_head: resolved_rows.slice(0, 8),
      });

           const r = await runAnalyze({
        formula_text,
        resolved_rows,
        ingestMeta,
        session,
      });

      if (r?.needs_context) {
        await twilioSendWhatsApp({ to: From, from: To, body: r.message });
        return;
      }

      const parsedTotal = Number(
        r?.parsed?.total ?? r?.parsed?.total_inclusion ?? 0
      );

let reply;
if (!parsedTotal || parsedTotal <= 0) {
  reply =
    "âš ï¸ I could not detect a valid formula in your message.\n\n" +
    "Please send one of these:\n" +
    "- a full formula text\n" +
    "- a PDF/Excel file\n" +
    "- or a clarification reply like: 1-48, 2-36, 3-54";
} else {
  reply = buildFinalReply({ rAnalyze: r, ingestMeta, session });
}

// store result for RESULT fallback
session.last_async_result = {
  text: reply,
  createdAt: nowMs(),
  meta: {
    route_version: ingestMeta.route_version,
    parsed_total: parsedTotal
  }
};
session.updatedAt = nowMs();

// Store fail BEFORE sending so FIX always works even if send fails
const overallBeforeSend = String(r?.evaluation?.overall || r?.overall || "").toUpperCase();
if (overallBeforeSend === "FAIL" || overallBeforeSend === "WARN") {
  session.last_failed_formula = {
    analysis: r,
    formula_text,
    resolved_rows,
    ingestMeta,
    context: session.context || {},
    analyze_result: r,
    createdAt: nowMs(),
  };
  session.updatedAt = nowMs();
  console.log("[DBG STORE FAIL BEFORE SEND]", { stored: true, overall: overallBeforeSend });
}

// try outbound send (may fail due to 63038)
await twilioSendWhatsApp({ to: From, from: To, body: reply });

// try outbound send (may fail due to 63038)
await twilioSendWhatsApp({ to: From, from: To, body: reply });
console.log("[DBG async notify OK]", { to: From, from: To });

// ðŸ”¥ BACKUP STORE FAIL (IN CASE TRY FLOW BREAKS)
try {
  if (typeof r !== "undefined") {
    const overall = String(r?.evaluation?.overall || r?.overall || "").toUpperCase();

    if (overall === "FAIL" || overall === "WARN") {
      const session = touchSession(From);

      session.last_failed_formula = {
        analysis: r,
        formula_text,
        resolved_rows,
        ingestMeta,
        context: session.context || {},
      };

      session.updatedAt = nowMs();

      console.log("[DBG STORE FAIL CATCH]", {
        stored: true,
        overall,
      });
    }
  }
} catch (e2) {
  console.log("[DBG STORE FAIL CATCH ERROR]", e2?.message);
}
    } catch (e) {
      const status = e?.response?.status;
      const data = e?.response?.data;
      const msg =
        (typeof data === "string" ? data : data?.message) ||
        e?.message ||
        "Unknown error";

      console.log("[DBG async media ERROR]", { msg, status, data: typeof data === "string" ? data.slice(0, 200) : "" });

      // store failure as RESULT too (so user can fetch)
      const failTxt =
        `âŒ Processing finished but delivery failed.\n\nReason: ${msg}\n\n` +
        `If this is Twilio daily limit (63038), upgrade account or wait reset.\n` +
        `You can type RESULT again to fetch the last stored output.`;

      const session = touchSession(From);
      session.last_async_result = { text: failTxt, createdAt: nowMs(), meta: { error: msg } };
      session.updatedAt = nowMs();

      // Also try to send a short error (might also fail)
      try {
        await twilioSendWhatsApp({ to: From, from: To, body: failTxt });
        console.log("[DBG async notify FAIL-INFO sent]", { to: From, from: To });
      } catch (e2) {
        console.log("[DBG async notify FAIL]", e2?.message || e2);
      }
    }
  });
}

// ---------------- Real Quick Fix Helper ----------------
async function runQuickFixApi({ formula_text, session }) {
  const context = session?.context || {
    locale: "US",
    region: "global",
    version: "v1",
    species: "poultry",
    type: "broiler",
    production: "meat",
    breed: "Ross308",
    phase: "starter",
  };

  const beforeResp = await axios.post(`${AGROCORE_BASE}/v1/analyze`, {
    ...context,
    formula_text,
  });

  const before = beforeResp.data;

  function parseFormula(txt) {
    return String(txt || "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [id, val] = l.split(/\s+/);
        return { id, inclusion: Number(val) };
      });
  }

  function clamp(x, min, max) {
    return Math.max(min, Math.min(max, x));
  }

  let rows = parseFormula(formula_text);
  const changes = [];
  const notes = [];

  function getRow(id) {
    return rows.find((x) => x.id === id);
  }

  function adjustOrAdd(id, delta, reason) {
    let row = getRow(id);
    const beforeVal = row ? Number(row.inclusion || 0) : 0;

    if (!row) {
      row = { id, inclusion: 0 };
      rows.push(row);
      notes.push(`Added ${id}`);
    }

    row.inclusion = +(Number(row.inclusion || 0) + delta).toFixed(4);

    changes.push({
      ingredient_id: id,
      before: +beforeVal.toFixed(4),
      after: row.inclusion,
      delta: +delta.toFixed(4),
      reason,
    });
  }

  const findings = before?.evaluation?.findings || [];

  for (const f of findings) {
    const key = String(f.nutrient || f.key || "").toLowerCase();
    const st = String(f.status || "").toUpperCase();
    if (st !== "FAIL" && st !== "WARN") continue;

    const deficitPct = Math.abs(Number(f.pct || 0));

    if (key === "ca") {
      const add = clamp(deficitPct * 0.02, 0.05, 0.35);
      adjustOrAdd("limestone", add, "Buffered dynamic Ca correction via limestone");
    }

    if (key === "avp") {
      const add = clamp(deficitPct * 0.03, 0.04, 0.25);
      adjustOrAdd("dcp", add, "Buffered dynamic AvP correction via DCP");
    }

    if (key === "na") {
      const add = clamp(deficitPct * 0.005, 0.02, 0.10);
      adjustOrAdd("salt", add, "Dynamic Na correction via salt");
    }

    if (key === "sid_lys") {
      const add = clamp(deficitPct * 0.017, 0.02, 0.10);
      adjustOrAdd("l_lys_hcl", add, "Buffered dynamic SID Lys correction via L-Lys HCl");
    }

    if (key === "sid_metcys") {
      const add = clamp(deficitPct * 0.0125, 0.03, 0.12);
      adjustOrAdd("dl_met", add, "Buffered dynamic SID Met+Cys correction via DL-Met");
    }

    // --- NEW ADDITIONS START ---

if (key === "me") {
  const add = clamp(deficitPct * 0.03, 0.05, 0.30);
  adjustOrAdd("soy_oil", add, "Buffered dynamic ME correction via soy oil");
}

if (key === "sid_thr") {
  const add = clamp(deficitPct * 0.015, 0.02, 0.08);
  adjustOrAdd("l_thr", add, "Buffered dynamic SID Thr correction via L-Threonine");
}

if (key === "sid_trp") {
  const add = clamp(deficitPct * 0.010, 0.01, 0.05);
  adjustOrAdd("l_trp", add, "Buffered dynamic SID Trp correction via L-Tryptophan");
}

  }

    // --- Multi-ingredient balancing back to 100% ---
  function adjustBalanceIngredient(id, delta, reason) {
    const row = getRow(id);
    if (!row) return false;

    const beforeVal = Number(row.inclusion || 0);
    const afterVal = +(beforeVal + delta).toFixed(4);

    if (afterVal < 0) return false;

    row.inclusion = afterVal;

    changes.push({
      ingredient_id: id,
      before: +beforeVal.toFixed(4),
      after: row.inclusion,
      delta: +delta.toFixed(4),
      reason,
    });

    return true;
  }

  function balanceBackTo100() {
  const total = rows.reduce((s, r) => s + Number(r.inclusion || 0), 0);
  let diff = +(100 - total).toFixed(4);

  if (Math.abs(diff) <= 0.001) return;

  // If formula is over 100, distribute reduction across practical ingredients
  if (diff < 0) {
    let remaining = Math.abs(diff);

    const reduceOrder = [
      "corn_grain_avg",
      "rice_broken",
      "millet_grain",
      "soybean_meal_44_5_cp",
      "canola_meal",
      "sunflower_meal",
    ];

    const activeRows = reduceOrder
      .map((id) => getRow(id))
      .filter((r) => r && Number(r.inclusion) > 0.1);

    if (activeRows.length === 0) return;

    const share = remaining / activeRows.length;

    for (const row of activeRows) {
      const current = Number(row.inclusion || 0);
      const reduceNow = Math.min(current * 0.10, share, remaining);

      if (reduceNow > 0.00001) {
        const beforeVal = current;
        row.inclusion = +(current - reduceNow).toFixed(4);

        changes.push({
          ingredient_id: row.id,
          before: +beforeVal.toFixed(4),
          after: row.inclusion,
          delta: +(-reduceNow).toFixed(4),
          reason: "Distributed multi-ingredient balancing to 100%",
        });

        remaining = +(remaining - reduceNow).toFixed(4);
      }

      if (remaining <= 0.00001) break;
    }

    return;
  }

  // If formula is under 100, add to carrier ingredients
  if (diff > 0) {
    const addOrder = ["corn_grain_avg", "rice_broken", "millet_grain"];

    for (const id of addOrder) {
      if (
        adjustBalanceIngredient(
          id,
          diff,
          "Balanced total formula using carrier ingredient"
        )
      ) {
        return;
      }
    }
  }
}

  balanceBackTo100();

  const new_formula_text = rows
    .filter((r) => Number(r.inclusion) > 0)
    .map((r) => `${r.id} ${Number(r.inclusion).toFixed(4)}`)
    .join("\n");

  const afterResp = await axios.post(`${AGROCORE_BASE}/v1/analyze`, {
    ...context,
    formula_text: new_formula_text,
  });

  const after = afterResp.data;

  return {
    ok: true,
    mode: "quick_fix_dynamic",
    context,
    status: {
      before: before.overall,
      after: after.overall,
    },
    changes,
    notes,
    new_formula_text,
    before_analysis: before,
    after_analysis: after,
  };
}

function parseFormulaTextToRows(formulaText) {
  return String(formulaText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      const inclusion = parts.pop();
      return {
        ingredient: parts.join(" "),
        inclusion,
      };
    });
}

async function generateQuickFixPdfReport({ qf, session }) {
  const reportId = `agrocore-quickfix-${Date.now()}.pdf`;
  const outDir = path.join(__dirname, "public", "reports");
  fs.mkdirSync(outDir, { recursive: true });

  const filePath = path.join(outDir, reportId);
  const bannerPath = path.join(__dirname, "assets", "agrocore-banner.png");
  const logoSvgPath = path.join(__dirname, "assets", "agrocore-logo.svg");

  const doc = new PDFDocument({
    margin: 40,
    size: "A4",
  });

  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  const green = "#1f7a3f";
  const darkGreen = "#14532d";
  const lightGreen = "#eaf7ef";
  const paleGreen = "#f8fbf9";
  const red = "#b91c1c";
  const gold = "#b7791f";
  const dark = "#1f2933";
  const gray = "#666666";
  const border = "#d9e5dd";

  const x0 = 40;
  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const usableWidth = pageW - 80;
  const bottomLimit = pageH - 78;
  let pageNo = 1;

  function drawFooter() {
    const footerY = pageH - 48;

    doc
      .moveTo(x0, footerY - 8)
      .lineTo(pageW - x0, footerY - 8)
      .strokeColor(border)
      .stroke();

    doc
      .font("Helvetica")
      .fontSize(7)
      .fillColor(gray)
      .text(
        "AgroCore AI Quick Fix is rule-based. Use Deep Fix / Optimization Engine for precision least-cost formulation and nutrient balancing.",
        x0,
        footerY,
        {
          width: usableWidth - 70,
          align: "left",
          lineBreak: false,
        }
      );

    doc
      .font("Helvetica")
      .fontSize(7)
      .fillColor(gray)
      .text(`Page ${pageNo}`, pageW - 95, footerY, {
        width: 55,
        align: "right",
        lineBreak: false,
      });

    doc.fillColor(dark);
  }

  function newPage() {
  doc.addPage();
  pageNo += 1;
}

  function ensureSpace(h = 24) {
    if (doc.y + h > bottomLimit) newPage();
  }

  function safe(v, d = 2) {
    const n = Number(v);
    if (Number.isNaN(n)) return "-";
    if (Math.abs(n) >= 100) return String(Math.round(n));
    return n.toFixed(d);
  }

  function section(title, forceNewPage = false) {
    if (forceNewPage) newPage();
    ensureSpace(38);

    doc.roundedRect(x0, doc.y, usableWidth, 24, 6).fill(lightGreen);

    doc
      .fillColor(darkGreen)
      .font("Helvetica-Bold")
      .fontSize(11)
      .text(title, x0 + 10, doc.y + 7, {
        width: usableWidth - 20,
        lineBreak: false,
      });

    doc.y += 34;
    doc.fillColor(dark);
  }

  function table(headers, rows, widths, opts = {}) {
    const rowH = opts.rowH || 11;
    const fontSize = opts.fontSize || 7;

    function drawHeader() {
      ensureSpace(rowH * 3);

      doc.rect(x0, doc.y, usableWidth, rowH).fill(green);

      let hx = x0;
      const hy = doc.y + 5;

      doc.font("Helvetica-Bold").fontSize(fontSize).fillColor("white");

      headers.forEach((h, i) => {
        doc.text(String(h), hx + 4, hy, {
          width: widths[i] - 8,
          align: i === 0 ? "left" : "right",
          lineBreak: false,
        });
        hx += widths[i];
      });

      doc.y += rowH;
    }

    drawHeader();

    for (let idx = 0; idx < rows.length; idx++) {
      if (doc.y + rowH > bottomLimit) {
        newPage();
        drawHeader();
      }

      const r = rows[idx];
      const y = doc.y;

      if (idx % 2 === 0) {
        doc.rect(x0, y, usableWidth, rowH).fill(paleGreen);
      }

      let rx = x0;

      r.forEach((c, i) => {
        let color = dark;
        const header = String(headers[i] || "");

        if (header.includes("Status")) {
          const s = String(c || "").toUpperCase();
          if (s === "FAIL") color = red;
          else if (s === "WARN") color = gold;
          else if (s === "OK") color = green;
        }

        doc
          .font(i === 0 ? "Helvetica-Bold" : "Helvetica")
          .fontSize(fontSize)
          .fillColor(color)
          .text(String(c ?? "-"), rx + 4, y + 5, {
            width: widths[i] - 8,
            align: i === 0 ? "left" : "right",
            ellipsis: true,
            lineBreak: false,
          });

        rx += widths[i];
      });

      doc
        .moveTo(x0, y + rowH)
        .lineTo(x0 + usableWidth, y + rowH)
        .strokeColor(border)
        .stroke();

      doc.y += rowH;
    }

    doc.moveDown(0.7);
    doc.fillColor(dark);
  }

  function parseFormula(text) {
    return String(text || "")
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^(.+?)\s+(-?\d+(?:\.\d+)?)$/);
        if (!m) return null;
        const rawName = m[1].trim();
        const val = Number(m[2]);
        const formatted = val > 0 && val < 0.01 ? val.toFixed(3) : val.toFixed(2);
        return [pdfNameMap[rawName] || rawName, formatted];
      })
      .filter(Boolean);
  }

  async function getAfterAnalysis() {
    if (qf?.after_analysis) return qf.after_analysis;

    try {
      const after = await runAnalyze({
        formula_text: qf.new_formula_text,
        resolved_rows: resolveFormulaRows(qf.new_formula_text),
        ingestMeta: {},
        session,
      });

      qf.after_analysis = after;
      return after;
    } catch (err) {
      console.error("[WARN PDF corrected nutrient analysis failed]", err);
      return {};
    }
  }

  function getStatus(analysis, key) {
    const req = analysis?.requirements_canonical || {};
    const dev = analysis?.deviations_canonical || {};
    const ev = analysis?.evaluation || {};

    if (dev?.[key]?.status) return dev[key].status;

    const f = Array.isArray(ev?.findings)
      ? ev.findings.find((x) => String(x?.nutrient || "").toLowerCase() === key)
      : null;

    return f?.status || (req?.[key] != null ? "OK" : "INFO");
  }

  function getTarget(analysis, key) {
    const req = analysis?.requirements_canonical || {};
    const dev = analysis?.deviations_canonical || {};
    return dev?.[key]?.required ?? dev?.[key]?.target ?? req?.[key] ?? null;
  }

  async function buildNutrientRows() {
    const beforeAnalysis =
      session?.last_failed_formula?.analyze_result ||
      session?.last_failed_formula?.analysis ||
      {};

    const afterAnalysis = await getAfterAnalysis();

    const beforeCalc = pickCalculated(beforeAnalysis);
    const afterCalc = pickCalculated(afterAnalysis);

    const panel =
      pickReportedPanel(beforeAnalysis) ||
      session?.last_failed_formula?.ingestMeta?.reported_nutrients ||
      {};

    const list = [
      ["ME", "me"],
      ["CP", "cp"],
      ["Ca", "ca"],
      ["AvP", "avp"],
      ["Na", "na"],
      ["SID Lys", "sid_lys"],
      ["SID Met", "sid_met"],
      ["SID Cys", "sid_cys"],
      ["SID M+C", "sid_metcys"],
      ["SID Thr", "sid_thr"],
      ["SID Trp", "sid_trp"],
      ["SID Arg", "sid_arg"],
    ];

    return list
      .map(([label, key]) => {
        const rep = panel?.[key];
        const before = beforeCalc?.[key];
        const corrected = afterCalc?.[key];
        const tgt = getTarget(beforeAnalysis, key);

        if (rep == null && before == null && corrected == null && tgt == null) return null;
        if (tgt != null && Number(tgt) === 0) return null;

        return [
          label,
          safe(rep),
          safe(before),
          safe(corrected),
          safe(tgt),
          String(getStatus(beforeAnalysis, key)).toUpperCase(),
          String(getStatus(afterAnalysis, key)).toUpperCase(),
        ];
      })
      .filter(Boolean);
  }

  // Header — draw logo mark + wordmark
  const logoX = pageW / 2 - 130;
  const logoY = 45;

  // Draw hexagon
  function hexPoints(cx, cy, r) {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 180) * (60 * i - 30);
      pts.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
    }
    return pts;
  }

  // outer hex
  const hp = hexPoints(logoX + 40, logoY + 28, 28);
  doc.polygon(...hp).fillAndStroke(lightGreen, darkGreen);

  // inner hex ring
  const hip = hexPoints(logoX + 40, logoY + 28, 22);
  doc.polygon(...hip).stroke('#2d7a4f');

  // neural connections
  const cx = logoX + 40, cy = logoY + 28;
  doc.moveTo(cx - 8, cy + 10).lineTo(cx, cy - 2).stroke('#4caf76');
  doc.moveTo(cx + 8, cy + 10).lineTo(cx, cy - 2).stroke('#4caf76');
  doc.moveTo(cx - 5, cy - 10).lineTo(cx, cy - 2).stroke('#4caf76');
  doc.moveTo(cx + 5, cy - 10).lineTo(cx, cy - 2).stroke('#4caf76');

  // A letterform
  doc.lineWidth(2.5)
    .moveTo(cx - 8, cy + 11).lineTo(cx, cy - 11).stroke('white');
  doc.moveTo(cx + 8, cy + 11).lineTo(cx, cy - 11).stroke('white');
  doc.moveTo(cx - 4, cy + 2).lineTo(cx + 4, cy + 2).stroke('white');

  // neural nodes
  doc.circle(cx - 8, cy + 10, 3).fillAndStroke(lightGreen, darkGreen);
  doc.circle(cx + 8, cy + 10, 3).fillAndStroke(lightGreen, darkGreen);
  doc.circle(cx, cy - 2, 2.5).fillAndStroke(lightGreen, '#4caf76');
  doc.circle(cx - 5, cy - 10, 2).fillAndStroke(lightGreen, '#2d7a4f');
  doc.circle(cx + 5, cy - 10, 2).fillAndStroke(lightGreen, '#2d7a4f');

  doc.lineWidth(1);

  // wordmark
  doc.font("Helvetica-Bold").fontSize(22).fillColor(darkGreen)
    .text("AgroCore", logoX + 78, logoY + 14, { lineBreak: false });
  doc.font("Helvetica-Bold").fontSize(22).fillColor('#2d7a4f')
    .text(" AI", logoX + 78 + 108, logoY + 14, { lineBreak: false });
  doc.font("Helvetica").fontSize(9).fillColor('#2d7a4f')
    .text("Quick Fix Correction Report", logoX + 78, logoY + 40, { lineBreak: false });
  doc.font("Helvetica").fontSize(7).fillColor(gray)
    .text("LIVESTOCK · FEED · INTELLIGENCE", logoX + 78, logoY + 54, { lineBreak: false, characterSpacing: 1 });

  // green line separator
  doc.y = logoY + 75;
  doc.moveTo(x0, doc.y).lineTo(pageW - x0, doc.y)
    .strokeColor(green).lineWidth(2).stroke();
  doc.lineWidth(1);
  doc.y = logoY + 85;

  doc.moveDown(0.8);

  // Compact summary — inline, no table
  doc.font("Helvetica").fontSize(7.5).fillColor(gray);
  doc.text(
    `Generated: ${new Date().toLocaleString()}   |   Status: ${qf?.status?.before || "-"} to ${qf?.status?.after || "-"}   |   AgroCore AI Quick Fix   |   Use Deep Fix for full optimization`,
    x0, doc.y, { width: usableWidth, lineBreak: true }
  );
  doc.moveDown(0.3);
  doc.moveTo(x0, doc.y).lineTo(pageW - x0, doc.y).strokeColor(border).lineWidth(0.5).stroke();
  doc.lineWidth(1);
  doc.moveDown(0.4);

  section("Nutrient Comparison");

  table(
    ["Nutrient", "Rep", "Before", "Corr", "Target", "Was", "Now"],
    await buildNutrientRows(),
    [62, 42, 48, 48, 48, 52, usableWidth - 300],
    { rowH: 14, fontSize: 8.5 }
  );

  const pdfNameMap = {
    corn_grain_avg: "Maize", soybean_meal_44_5_cp: "SBM 44%",
    soybean_meal_48_cp: "SBM 48%", soybean_meal_46_5_cp: "SBM 46.5%",
    soybean_meal_45_5_cp: "SBM 45.5%",
    fish_meal_54_cp: "Fish Meal 54%", fish_meal_65_cp: "Fish Meal 65%",
    corn_gluten_meal_60_cp: "CGM 60%", corn_gluten_feed_21_cp: "CGF 21%",
    corn_ddgs_6_9_ee: "DDGS", corn_germ_meal_deoiled: "Corn Germ Meal",
    canola_meal: "Canola Meal", sunflower_meal: "Sunflower Meal",
    rapeseed_meal: "Rapeseed Meal", cottonseed_meal_41_cp: "CSM 41%",
    rice_broken: "Rice (Broken)", rice_bran: "Rice Bran",
    millet_grain: "Millet/Bajra", sorghum_grain: "Sorghum",
    wheat_grain: "Wheat", wheat_bran: "Wheat Bran",
    wheat_middlings: "Wheat Middlings", wheat_mill_run: "Wheat Mill Run",
    barley_grain: "Barley", oat_grain: "Oats",
    soy_oil: "Soybean Oil", palm_oil: "Palm Oil",
    canola_oil: "Canola Oil", poultry_fat: "Poultry Fat", tallow: "Tallow",
    dl_met: "DL-Methionine", l_lys_hcl: "L-Lysine HCl",
    l_lys_sulfate: "L-Lysine Sulfate", l_thr: "L-Threonine",
    l_trp: "L-Tryptophan", l_val: "L-Valine", l_ile: "L-Isoleucine",
    limestone: "Limestone", dcp: "Di-Ca Phosphate", mcp: "Mono-Ca Phos",
    salt: "Salt", sodium_bicarbonate: "Sodium Bicarb",
    choline_chloride: "Choline Chloride",
    vitamin_premix: "Vitamin Premix", mineral_premix: "Mineral Premix",
    vit_min_premix: "Vit+Min Premix",
    anti_coccidial: "Anti-Coccidial", toxin_binder: "Toxin Binder",
    phytase: "Phytase", nsps: "NSPase", protease: "Protease", agps: "AGPs",
    xylanase: "Xylanase", amylase: "Amylase", lipase: "Lipase",
    multi_enzyme: "Multi-Enzyme", probiotic: "Probiotic",
    blood_meal: "Blood Meal", feather_meal_84_cp: "Feather Meal 84%",
    poultry_byproduct_meal: "Poultry By-Product",
    bovine_meat_bone_meal_48_cp: "MBM 48%",
    bovine_meat_bone_meal_43_cp: "MBM 43%",
    animal_protein_concentrate_55_cp: "APC 55%",
    animal_protein_concentrate_65_cp: "APC 65%",
    guar_meal: "Guar Meal", peanut_meal: "Groundnut Meal",
    copra_meal: "Copra Meal", palm_kernel_meal: "PKM",
    cassava_meal: "Cassava Meal", bakery_meal: "Bakery Meal",
    lupin_grain: "Lupins", field_peas: "Field Peas",
    faba_beans: "Faba Beans", soybean_hulls: "Soy Hulls",
    soybean_fullfat_extruded: "Full Fat Soya",
    whey_powder: "Whey Powder", skim_milk_powder: "Skim Milk",
    potato_protein: "Potato Protein",
    sugarcane_molasses: "Molasses", brewers_grains: "Brewers Grain",
    hominy_meal: "Hominy Meal", alfalfa_meal: "Alfalfa Meal",
    acid_oil: "Acid Oil",
    meat_bone_meal_45_cp: "MBM 45%",
    meat_bone_meal_48_cp: "MBM 48%",
    l_arg: "L-Arginine",
    monosodium_phosphate: "Mono-Na Phos",
    dicalcium_phosphate: "Di-Ca Phos",
    beet_pulp: "Beet Pulp",
    molasses_cane: "Cane Molasses",
    alfalfa_meal_17_cp: "Alfalfa Meal",
    wheat_middlings: "Wheat Midds",
    soybean_hulls: "Soy Hulls",
  };

  section("Ingredient Changes", true);

  const changeRows = (qf?.changes || []).map((c) => {
    const before = Number(c.before || 0);
    const after = Number(c.after || 0);
    const diff = after - before;

    return [
      pdfNameMap[c.ingredient_id] || c.ingredient_id || "-",
      before.toFixed(2),
      after.toFixed(2),
      diff >= 0 ? `+${diff.toFixed(2)}` : diff.toFixed(2),
    ];
  });

  table(
    ["Ingredient", "Before %", "Corrected %", "Change %"],
    changeRows,
    [220, 90, 100, usableWidth - 410],
    { rowH: 14, fontSize: 8.5 }
  );

  section("Corrected Formula", true);

  // Merge back ingredients dropped by Quick Fix engine
  const storedResolvedRows = session?.last_failed_formula?.resolved_rows || [];
  console.log('[MERGE DEBUG2] storedResolvedRows count:', storedResolvedRows.length);
  const originalRows = storedResolvedRows.length > 0
    ? storedResolvedRows.map(r => `${r.ingredient_code || r.canonical_id || r.ingredient_id} ${Number(r.inclusion || 0)}`)
    : String(session?.last_failed_formula?.formula_text || '').split('\n').filter(Boolean);
  const qfLines = String(qf?.new_formula_text || '').split('\n').filter(Boolean);
  console.log('[MERGE DEBUG] originalRows count:', originalRows.length);
  console.log('[MERGE DEBUG] originalRows all:', originalRows);
  console.log('[MERGE DEBUG] qfLines count:', qfLines.length);
  console.log('[MERGE DEBUG] qfLines all:', qfLines);
  const qfIds = new Set(qfLines.map(l => l.split(/\s+/)[0].toLowerCase().trim()));
  const microIngredients = originalRows.filter(line => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) return false;
    const id = parts[0].toLowerCase().trim();
    const inc = Number(parts[parts.length - 1]);
    // Include any ingredient not in QF output with inclusion > 0
    return !qfIds.has(id) && inc > 0;
  });
  const mergedFormulaText = qf?.new_formula_text + (microIngredients.length > 0 ? '\n' + microIngredients.join('\n') : '');
  const formulaData = parseFormula(mergedFormulaText);
  const half = Math.ceil(formulaData.length / 2);
  const col1 = formulaData.slice(0, half);
  const col2 = formulaData.slice(half);
  const maxRows = Math.max(col1.length, col2.length);
  const twoColRows = [];
  for (let i = 0; i < maxRows; i++) {
    twoColRows.push([
      col1[i] ? col1[i][0] : "",
      col1[i] ? col1[i][1] : "",
      col2[i] ? col2[i][0] : "",
      col2[i] ? col2[i][1] : "",
    ]);
  }

  table(
    ["Ingredient", "Inclusion %", "Ingredient", "Inclusion %"],
    twoColRows,
    [150, 75, 150, usableWidth - 375],
    { rowH: 14, fontSize: 8.5 }
  );

  // Total row
  const formulaTotal = parseFormula(mergedFormulaText)
    .reduce((sum, row) => sum + Number(row[1] || 0), 0);
  
  doc.moveDown(0.3);
  doc.rect(x0, doc.y, usableWidth, 16).fill(lightGreen);
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(darkGreen)
    .text("TOTAL", x0 + 4, doc.y + 4, { lineBreak: false });
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(darkGreen)
    .text(formulaTotal.toFixed(2) + " %", x0 + 154, doc.y + 4, { lineBreak: false });
  doc.y += 20;
  doc.fillColor(dark);

  doc.moveDown(0.8);
doc
  .font("Helvetica")
  .fontSize(8)
  .fillColor(gray)
  .text(
    "AgroCore AI Quick Fix is rule-based. Use Deep Fix / Optimization Engine for precision least-cost formulation and nutrient balancing.",
    { align: "center" }
  );

doc.end();

  await new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });

  return {
    fileName: reportId,
    filePath,
    url: `${FEEDBOT_PUBLIC_BASE_URL}/reports/${reportId}`,
  };
}

// ---------------- Main Handler ----------------
async function whatsappHandler(req) {
  pruneSessions();

  const Body = (req.body?.Body || "").trim();
  const From = req.body?.From || "anon";
  const To = req.body?.To || "";
  const NumMediaRaw = req.body?.NumMedia;
  const NumMedia = Number(NumMediaRaw || 0);

  const session = touchSession(From);
  if (session?.pending_deepfix_scenario && /^[123]$/.test(Body)) {
  session.pending_deepfix_scenario = false;

  let scenario = "balance";
  if (Body === "2") scenario = "cost";
  if (Body === "3") scenario = "low_synthetic";

  return await runDeepFixScenario({ session, scenario });
}

  console.log("[DBG media payload]", {
    From,
    To,
    NumMedia: NumMediaRaw,
    NumMedia_n: NumMedia,
    MediaUrl0: req.body?.MediaUrl0,
    MediaContentType0: req.body?.MediaContentType0,
    Body_len: Body.length,
  });

  // Skip greeting and QA if waiting for media context or unresolved ingredients
  const bypassQA = !!(session?.pending_media || session?.pending_unresolved);

  // ---------------- OPENING / GREETING ----------------
  if (!NumMedia && !bypassQA && looksLikeGreeting(Body)) {
    session.qa_context = null;
    return buildMainMenu();
  }

  // ---------------- UNRESOLVED INGREDIENT REPLY ----------------
  if (!NumMedia && session?.pending_unresolved) {
    if (/^SKIP$/i.test(Body)) {
      const pending = session.pending_unresolved;
      session.pending_unresolved = null;
      session.updatedAt = nowMs();
      startAsyncMediaJob({ From, To, MediaUrl0: null, MediaContentType0: null, 
        _override: { formula_text: pending.formula_text, resolved_rows: pending.resolved_rows, ingestMeta: pending.ingestMeta }
      });
      return "⏭️ Skipping unrecognized ingredients and analyzing...";
    }

    // Parse numbered replies like "1. Maize\n2. Canola Meal"
    const lines = Body.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const pending = session.pending_unresolved;
    const updates = {};

    for (const line of lines) {
      const m = line.match(/^(\d+)[.\-:)\s]+(.+)$/);
      if (m) {
        const idx = Number(m[1]) - 1;
        const name = m[2].trim();
        if (idx >= 0 && idx < pending.unresolved.length) {
          updates[idx] = name;
        }
      }
    }

    if (Object.keys(updates).length > 0) {
      // Apply corrections to resolved_rows
      for (const [idxStr, name] of Object.entries(updates)) {
        const idx = Number(idxStr);
        const unresRow = pending.unresolved[idx];
        const mainIdx = pending.resolved_rows.findIndex(r => r.raw_name === unresRow.raw_name);
        if (mainIdx > -1) {
          pending.resolved_rows[mainIdx].raw_name = name;
          pending.resolved_rows[mainIdx].matched_name = name;
        }
        // Also update formula_text
        pending.formula_text = pending.formula_text.replace(
          new RegExp(unresRow.raw_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
          name
        );
      }

      session.pending_unresolved = null;
      session.updatedAt = nowMs();

      // Re-run with corrected names
      startAsyncMediaJob({ From, To, MediaUrl0: null, MediaContentType0: null,
        _override: { formula_text: pending.formula_text, resolved_rows: pending.resolved_rows, ingestMeta: pending.ingestMeta }
      });
      return `✅ Got it! Analyzing with corrected names...\n_(Reply RESULT if no response)_`;
    }
  }

  // ---------------- PENDING MEDIA CONTEXT REPLY ----------------
  if (!NumMedia && session?.pending_media) {
    const bCtx = Body.trim().toLowerCase();
    if (bCtx === "1" || /ross\s*308|ross308/i.test(bCtx)) {
      session.context = { locale:"US", region:"global", version:"v1", species:"poultry", type:"broiler", production:"meat", breed:"Ross308", phase:"starter" };
    } else if (bCtx === "2" || /cobb\s*500|cobb500/i.test(bCtx)) {
      session.context = { locale:"US", region:"global", version:"v1", species:"poultry", type:"broiler", production:"meat", breed:"Cobb500", phase:"starter" };
    } else if (bCtx === "3" || /hy[-\s]?line|hyline/i.test(bCtx)) {
      session.context = { locale:"US", region:"global", version:"v1", species:"poultry", type:"layer", production:"egg", breed:"hyline", phase:"peak" };
    } else if (/grower/i.test(bCtx) && /cobb/i.test(bCtx)) {
      session.context = { locale:"US", region:"global", version:"v1", species:"poultry", type:"broiler", production:"meat", breed:"Cobb500", phase:"grower" };
    } else if (/grower/i.test(bCtx) && /ross/i.test(bCtx)) {
      session.context = { locale:"US", region:"global", version:"v1", species:"poultry", type:"broiler", production:"meat", breed:"Ross308", phase:"grower" };
    } else if (/finish/i.test(bCtx) && /ross/i.test(bCtx)) {
      session.context = { locale:"US", region:"global", version:"v1", species:"poultry", type:"broiler", production:"meat", breed:"Ross308", phase:"finisher" };
    } else if (/finish/i.test(bCtx) && /cobb/i.test(bCtx)) {
      session.context = { locale:"US", region:"global", version:"v1", species:"poultry", type:"broiler", production:"meat", breed:"Cobb500", phase:"finisher" };
    } else {
      return `Please select:\n1️⃣ Broiler → Ross308 → Starter\n2️⃣ Broiler → Cobb500 → Starter\n3️⃣ Layer → Hy-Line → Peak\n4️⃣ Type manually`;
    }
    if (session.context) {
      const media = session.pending_media;
      session.pending_media = null;
      session.updatedAt = nowMs();
      startAsyncMediaJob({ From: media.From, To: media.To, MediaUrl0: media.MediaUrl0, MediaContentType0: media.MediaContentType0 });
      return "🐔 *Analyzing your formula...*\n\n🌾 Results will arrive in a few seconds.\n_(If delayed, type: RESULT)_";
    }
  }

  // ---------------- Q&A ENGINE ----------------
  const hasPendingDownload = !!session?.pending_download && /^[1234]$/.test(Body.trim());
  const isCommand = /^(FIX|RESULT|MORE|ADVICE|PERF|TREND|NORMALIZE|OPTIMIZE|DEEP FIX|DEEPFIX|ADVANCED|NUTRIX|LITE|WEB|DM|CONTEXT|FLOCK|FARM|ALERTS?|MILL|BATCH|BREED|ASK NUTRIX)(\s|$)/i.test(Body);
  if (!NumMedia && !isCommand && !hasPendingDownload && !bypassQA) {
    const qaResult = await handleQA(Body, session);
    if (qaResult) return qaResult;
  }

  
  // ---------------- PERF command ----------------
  if (/^PERF$/i.test(Body)) {
    const last = session?.last_perf_data;
    if (!last) return "No performance data stored.\n\nSend farm data first, e.g.:\nRoss308 day28\nBW 1420g, FCR 1.85, mort 2.1%";
    const result = analyzePerformance(last.parsed, last.context);
    session.last_perf_result = result;
    session.updatedAt = nowMs();
    const reply = buildPerfTable({ result, context: last.context });
    if (result.overall === "FAIL" || result.overall === "WARN") {
      return `${reply}\n\nReply ADVICE for recommendations.`;
    }
    return reply;
  }

  // ---------------- ADVICE command ----------------
  if (/^ADVICE$/i.test(Body)) {
    const last = session?.last_perf_result;
    if (!last) return "No performance result stored.\n\nSend farm data first, then check it.";
    return buildAdviceText(last);
  }

// ── FarmPulse Live Commands ──────────────────────────────────────────────────

  // FLOCK STATUS - show all active flocks summary
  if (/^FLOCK STATUS$/i.test(Body)) {
    try {
      const r = await axios.get(`${AGROCORE_BASE}/api/farmpulse/flocks`, { params: { status: 'active' } });
      const flocks = r.data?.data || [];
      if (!flocks.length) return 'No active flocks found.';
      const lines = flocks.map(f => {
        const k = f.latest_kpis || {};
        const bw  = k.avg_body_weight_g ? `BW ${Math.round(k.avg_body_weight_g)}g` : '';
        const fcr = k.avg_fcr           ? `FCR ${Number(k.avg_fcr).toFixed(2)}`    : '';
        const mort= k.mortality_rate_pct? `Mort ${Number(k.mortality_rate_pct).toFixed(2)}%` : '';
        const kpis = [bw, fcr, mort].filter(Boolean).join(', ');
        const ageDays = f.placement_date
          ? Math.floor((Date.now() - new Date(f.placement_date).getTime()) / 86400000)
          : null;
        return `*${f.flock_code}* (${f.breed}) — Day ${ageDays ?? '?'}\n${kpis || 'No records yet'}`;
      });
      return `🐔 *Active Flocks*\n\n${lines.join('\n\n')}`;
    } catch(e) {
      return `Error fetching flocks: ${e.message}`;
    }
  }

  // ALERTS - show open alerts
  if (/^ALERTS?$/i.test(Body)) {
    try {
      const r = await axios.get(`${AGROCORE_BASE}/api/farmpulse/alerts`, { params: { status: 'open' } });
      const alerts = r.data?.data || [];
      if (!alerts.length) return '✅ No open alerts.';
      const lines = alerts.map(a => {
        const sev = a.severity === 'critical' ? '🔴' : a.severity === 'warning' ? '🟡' : '🔵';
        return `${sev} *${a.alert_type.replace(/_/g,' ')}* — Flock ${a.flock_id}\n${a.message || ''}`;
      });
      return `⚠️ *Open Alerts* (${alerts.length})\n\n${lines.join('\n\n')}`;
    } catch(e) {
      return `Error fetching alerts: ${e.message}`;
    }
  }

  // FLOCK <code> - show specific flock details
  const flockMatch = Body.match(/^FLOCK\s+([A-Z0-9\-]+)$/i);
  if (flockMatch) {
    try {
      const code = flockMatch[1].toUpperCase();
      const r = await axios.get(`${AGROCORE_BASE}/api/farmpulse/flocks`);
      const flocks = r.data?.data || [];
      const flock = flocks.find(f => f.flock_code.toUpperCase() === code);
      if (!flock) return `Flock ${code} not found.\n\nSend FLOCK STATUS for all flocks.`;
      const trendR = await axios.get(`${AGROCORE_BASE}/api/farmpulse/daily-records/flock/${flock.id}/trend`);
      const trend = trendR.data?.data?.trend || [];
      const last = trend[trend.length - 1];
      if (!last) return `*${code}* — No daily records yet.`;
      const lines = [
        `*${flock.flock_code}* — ${flock.breed} (${flock.production_type})`,
        `Farm: ${flock.farm_name || flock.farm_id} | Birds: ${last.bird_count?.toLocaleString()}`,
        `Age: Day ${last.age_days} | Date: ${last.record_date}`,
        ``,
        `📊 *Latest KPIs*`,
        last.avg_body_weight_g ? `BW: ${Math.round(last.avg_body_weight_g)}g` : '',
        last.fcr_cumulative    ? `FCR: ${Number(last.fcr_cumulative).toFixed(2)}` : '',
        last.mortality_rate_pct? `Mortality: ${Number(last.mortality_rate_pct).toFixed(2)}%` : '',
        last.feed_intake_per_bird_g ? `Feed/Bird: ${Math.round(last.feed_intake_per_bird_g)}g/day` : '',
        last.egg_production_pct ? `Egg Production: ${Number(last.egg_production_pct).toFixed(1)}%` : '',
      ].filter(Boolean).join('\n');
      return lines;
    } catch(e) {
      return `Error fetching flock: ${e.message}`;
    }
  }

  // FARM STATUS - show all farms summary
  if (/^FARM STATUS$/i.test(Body)) {
    try {
      const r = await axios.get(`${AGROCORE_BASE}/api/farmpulse/farms`);
      const farms = r.data?.data || [];
      if (!farms.length) return 'No farms found.';
      const lines = farms.map(f =>
        `*${f.name}* — ${f.location || 'No location'}\n${f.flock_count ?? 0} active flocks | Capacity: ${f.capacity?.toLocaleString() ?? 0} birds`
      );
      return `🏡 *Farms*\n\n${lines.join('\n\n')}`;
    } catch(e) {
      return `Error fetching farms: ${e.message}`;
    }
  }

  // FP HELP - show FarmPulse commands
  if (/^FP HELP$/i.test(Body)) {
    return `🐔 *FarmPulse Commands*\n\n` +
      `*FLOCK STATUS* — All active flocks\n` +
      `*FLOCK FL-2026-001* — Specific flock details\n` +
      `*ALERTS* — Open alerts\n` +
      `*FARM STATUS* — All farms summary\n\n` +
      `_Send FP HELP any time to see this menu_`;
  }

  // MILL BATCHES - show recent mill batches
  if (/^MILL BATCHES?$/i.test(Body)) {
    try {
      const r = await axios.get(`${AGROCORE_BASE}/api/farmpulse/mill-batches`);
      const batches = r.data?.data || [];
      if (!batches.length) return 'No mill batches found.';
      const lines = batches.slice(0, 5).map(b =>
        `*${b.batch_number}*\n${b.formula_name} | ${b.planned_qty_tons}t | ${b.status}\nDispatched: ${b.dispatched_at ? new Date(b.dispatched_at).toLocaleDateString() : '—'}`
      );
      return `🏭 *Recent Mill Batches*\n\n${lines.join('\n\n')}\n\nSend BATCH <number> for details.`;
    } catch(e) {
      return `Error fetching mill batches: ${e.message}`;
    }
  }

  // BATCH <number> - specific batch details
  const batchMatch = Body.match(/^BATCH\s+(.+)$/i);
  if (batchMatch) {
    try {
      const batchNum = batchMatch[1].trim().toUpperCase();
      const r = await axios.get(`${AGROCORE_BASE}/api/farmpulse/mill-batches`);
      const batches = r.data?.data || [];
      const batch = batches.find(b => b.batch_number.toUpperCase() === batchNum);
      if (!batch) return `Batch ${batchNum} not found.\n\nSend MILL BATCHES to see all batches.`;
      const lines = [
        `🏭 *${batch.batch_number}*`,
        `Formula: ${batch.formula_name}`,
        `Feed type: ${batch.feed_type}`,
        `Species: ${batch.species}`,
        `Version: ${batch.formula_version}`,
        `Planned qty: ${batch.planned_qty_tons}t`,
        `Actual qty: ${batch.actual_qty_tons ? batch.actual_qty_tons + 't' : 'Not recorded'}`,
        `Status: ${batch.status}`,
        `Cost/ton: ${batch.cost_per_ton ? '$' + batch.cost_per_ton : 'Not set'}`,
        `Dispatched: ${batch.dispatched_at ? new Date(batch.dispatched_at).toLocaleString() : '—'}`,
        `Completed: ${batch.completed_at ? new Date(batch.completed_at).toLocaleString() : '—'}`,
      ].join('\n');
      return lines;
    } catch(e) {
      return `Error fetching batch: ${e.message}`;
    }
  }

  // ASK NUTRIX <question> - AI poultry nutrition troubleshooting
  const askMatch = Body.match(/^ASK\s+NUTRIX\s+(.+)$/is);
  if (askMatch) {
    const q = askMatch[1].trim();
    const ql = q.toLowerCase();

    // Try AgroCore AI engine first
    try {
      const aiRes = await axios.post(`${AGROCORE_BASE}/v1/nutrix-ai/ask`,
        { question: q },
        { headers: { 'Content-Type': 'application/json' }, timeout: 8000 }
      );
      const answer = aiRes.data?.answer || '';
      if (answer && !answer.includes('mock') && !answer.includes('Real AI will be connected')) {
        return `🧠 *NutriX AI*\n\n${answer}`;
      }
    } catch(e) { /* fall through to KB */ }

    // Knowledge base fallback
    const kb = [
      { keys: ['fines','pellet quality','dusty','dust','crumble','pdi'],
        answer: `*Feed Fines — Common Causes*\n\n• Conditioning temp too low — target 80-85°C\n• Die wear — check L:D ratio, replace if worn\n• Moisture too low — pellets below 12% break easily\n• Cooling too fast — hot pellets hit cold air\n• Excess conveyor drops and auger damage\n\n✅ Check PDI (target >80%). Verify conditioner steam pressure and die spec.` },
      { keys: ['high fcr','poor fcr','feed conversion','fcr bad','fcr high'],
        answer: `*High FCR — Common Causes*\n\n• Poor feed quality — high fines, low energy\n• Health issues — coccidiosis, necrotic enteritis\n• Wrong phase feed — finisher fed too early\n• Feeder management — wastage, wrong height\n• Heat stress — birds eat less efficiently\n\n✅ Check feed energy (AME), pellet quality, water:feed ratio and health status.` },
      { keys: ['heat stress','hot','temperature high','panting','thi'],
        answer: `*Heat Stress Management*\n\n• THI >28 = heat stress risk for broilers\n• Reduce stocking density 10-15%\n• Increase ventilation — target 2.5 m/s tunnel\n• Add electrolytes to water (Na, K, Cl)\n• Feed in cool parts of day\n• Add Vitamin C 200-300g/ton\n\n✅ Water must be cool and always available — birds drink 2x in heat.` },
      { keys: ['mortality','death','dying','sudden death'],
        answer: `*High Mortality — Check List*\n\n• Day 1-7: Yolk sac infection, chilling, dehydration\n• Day 7-21: Coccidiosis, IBD, respiratory\n• Day 21+: Ascites, SDS, NE, heat stress\n• Layers: Fatty liver, egg peritonitis\n\n✅ Post-mortem immediately. Check litter, ventilation, vaccination and mycotoxin levels.` },
      { keys: ['poor growth','low body weight','bw low','slow growth','underweight'],
        answer: `*Poor Body Weight — Causes*\n\n• Low feed energy — check ingredient quality\n• Amino acid deficiency — lysine and methionine\n• Subclinical coccidiosis\n• Feeder/drinker space inadequate\n• Poor chick quality at placement\n\n✅ Check starter energy >3000 kcal/kg, lysine >1.2%, uniform flock distribution.` },
      { keys: ['egg production','laying rate','production drop','eggs low'],
        answer: `*Egg Production Drop — Causes*\n\n• Low calcium, phosphorus, energy or amino acids\n• Reduction in light hours triggers molt\n• Disease: IB, Newcastle, EDS-76\n• Heat stress >28°C reduces production 5-15%\n• 1hr without water = 2 day production loss\n\n✅ Check light program, water, calcium (3.5-4.5%) and disease history.` },
      { keys: ['shell quality','thin shell','soft shell','shell crack','broken eggs'],
        answer: `*Poor Shell Quality — Causes*\n\n• Low calcium — layer needs 3.8-4.2% Ca\n• Ca:P ratio should be 10:1\n• Vitamin D3 deficiency\n• Heat stress reduces shell gland function\n• Disease: IB, Newcastle\n\n✅ Use coarse limestone (2-4mm) 50% of Ca. Add 2000-3000 IU/kg Vit D3.` },
      { keys: ['water','drinker','water intake','water consumption'],
        answer: `*Water Management*\n\n• Normal water:feed ratio = 1.8-2.0:1 broilers\n• Layers: 200-250ml/bird/day at 21°C\n• High ratio >3:1: Heat stress, disease, wet litter\n• Nipple flow: 60-80ml/min broilers\n\n✅ Clean water lines weekly. Check pressure daily. pH target 6-7.` },
      { keys: ['mycotoxin','mold','aflatoxin','fumonisin','vomitoxin','don'],
        answer: `*Mycotoxin Issues*\n\n• Signs: Reduced intake, poor growth, immunosuppression\n• Aflatoxin: Max 10ppb poultry\n• DON/Vomitoxin: Feed refusal\n\n✅ Test all grain batches. Add broad-spectrum binder 1-2kg/ton. Store grain <13% moisture, <25°C.` },
      { keys: ['feed refusal','not eating','off feed','low intake','reduced intake'],
        answer: `*Feed Refusal — Causes*\n\n• Rancid fat — peroxide value >5 meq/kg\n• Mycotoxins — reduce palatability\n• Sudden ingredient change\n• Heat stress — intake drops 5%/°C above 21°C\n\n✅ Check fat quality (AV, PV), add antioxidant, no sudden formula changes.` },
      { keys: ['wet litter','litter','caking','damp litter','footpad'],
        answer: `*Wet Litter — Causes*\n\n• High water:feed ratio >2.5:1\n• Drinker leakage or high pressure\n• High dietary salt or potassium\n• Coccidiosis, necrotic enteritis\n• Poor ventilation\n\n✅ Add NSPase enzyme. Check electrolyte balance (target 240-260 meq/kg). Fix drinkers.` },
      { keys: ['amino acid','lysine','methionine','threonine','protein','cp'],
        answer: `*Amino Acid Deficiency Signs*\n\n• Low lysine: Poor muscle growth, low BW\n• Low methionine: Feather pecking, poor feathering\n• Low threonine: Gut integrity issues\n• Low tryptophan: Aggression, cannibalism\n\n✅ Broiler starter: SID Lys 1.2%, Met 0.50%, Thr 0.80%.` },
      { keys: ['energy','me','ame','kcal','mj'],
        answer: `*Energy Deficiency Signs*\n\n• Poor growth despite good feed intake\n• High FCR\n• Birds huddle together — feel cold\n\n✅ Broiler starter AME target: 3000-3050 kcal/kg. Add fat 2-4% if energy is low.` },
    ];

    const match = kb.find(e => e.keys.some(k => ql.includes(k)));
    if (match) return `🧠 *NutriX Expert*\n\n${match.answer}`;

    return `🧠 *NutriX Expert*\n\nI don't have a specific answer for that yet.\n\nTry asking about:\n• Feed fines / pellet quality\n• High FCR\n• Heat stress\n• Mortality\n• Poor growth\n• Egg production drop\n• Shell quality\n• Wet litter\n• Mycotoxins\n• Amino acids`;
  }

  // ── End FarmPulse Commands ───────────────────────────────────────────────────

  // ---------------- BREED INFO command ----------------
  if (/^BREED INFO$/i.test(Body)) {
    const { listBreeds } = require("./core/breed-standards/breed-standards.data");
    const breeds = listBreeds();
    return "Available breed standards:\n\n" + breeds.join("\n") +
           "\n\nSend e.g. 'Ross308 day28, BW 1420g, FCR 1.85' to check performance.";
  }

  // ---------------- TREND command ----------------
  if (/^TREND$/i.test(Body)) {
    return "TREND report: connect to FarmPulse daily records via web dashboard.\n\nOpen Nutrix Lite for full trend charts.";
  }

  if (/^MORE$/i.test(Body)) {
    const part2 = session?.pending_fix_part2;
    if (part2) {
      session.pending_fix_part2 = null;
      return part2;
    }
    return "Nothing more to show.";
  }

  // ---------------- RESULT command ----------------
  if (/^RESULT$/i.test(Body)) {
    const last = session?.last_async_result;
    if (last?.text) return last.text;
    return "No stored result yet. Send a PDF/Excel/photo to analyze, then type RESULT if you don't receive a reply.";
  }

    // ---------------- DOWNLOAD MENU REPLY ----------------
  if (session?.pending_download && /^[1234]$/.test(Body)) {
    const choice = Body.trim();
    const pending = session.pending_download;

    if (pending.type !== "quick_fix" || !pending.qf) {
      session.pending_download = null;
      return "âŒ Download session expired. Please run FIX again.";
    }

        if (choice === "1") {
      try {
        const report = await generateQuickFixPdfReport({
          qf: pending.qf,
          session,
        });

        session.pending_download = null;
        session.updatedAt = nowMs();

        return [
          "AgroCore AI",
          "",
          "Download PDF:",
          report.url,
        ].join("\n");
      } catch (err) {
        console.error("[ERR PDF report generation]", err);

        return (
          "âŒ PDF report could not be generated.\n\n" +
          "Please check server logs, then try again by replying 1."
        );
      }
    }

    if (choice === "2") {
      try {
        const qf = pending.qf;
        const reportId = `agrocore-formula-${Date.now()}.xlsx`;
        const outDir = require('path').join(__dirname, 'public', 'reports');
        require('fs').mkdirSync(outDir, { recursive: true });
        const filePath = require('path').join(outDir, reportId);

        // Build Excel using ExcelJS
        const ExcelJS = require('exceljs');
        const wb = new ExcelJS.Workbook();
        wb.creator = 'AgroCore AI';

        // Sheet 1 — Corrected Formula
        const ws1 = wb.addWorksheet('Corrected Formula');
        ws1.columns = [
          { header: 'Ingredient', key: 'name', width: 28 },
          { header: 'Inclusion %', key: 'inclusion', width: 15 },
        ];
        ws1.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        ws1.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a4d2e' } };

        const pdfNameMap = {
          corn_grain_avg: 'Maize', soybean_meal_44_5_cp: 'SBM 44%',
          fish_meal_54_cp: 'Fish Meal 54%', corn_gluten_meal_60_cp: 'CGM 60%',
          canola_meal: 'Canola Meal', sunflower_meal: 'Sunflower Meal',
          rice_broken: 'Rice (Broken)', millet_grain: 'Millet/Bajra',
          soy_oil: 'Soybean Oil', dl_met: 'DL-Methionine',
          l_lys_hcl: 'L-Lysine HCl', l_thr: 'L-Threonine',
          l_trp: 'L-Tryptophan', limestone: 'Limestone', dcp: 'Di-Ca Phosphate',
          salt: 'Salt', choline_chloride: 'Choline Chloride',
          vitamin_premix: 'Vitamin Premix', mineral_premix: 'Mineral Premix',
          anti_coccidial: 'Anti-Coccidial', toxin_binder: 'Toxin Binder',
          phytase: 'Phytase', nsps: 'NSPase', protease: 'Protease', agps: 'AGPs',
        };

        String(qf.new_formula_text || '').split('\n').filter(Boolean).forEach((line, i) => {
          const m = line.match(/^(.+?)\s+(-?\d+(?:\.\d+)?)$/);
          if (!m) return;
          const raw = m[1].trim();
          const row = ws1.addRow({ name: pdfNameMap[raw] || raw, inclusion: Number(m[2]) });
          row.fill = i % 2 === 0
            ? { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFf0faf4' } }
            : { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
        });

        // Total row
        const total = String(qf.new_formula_text || '').split('\n').filter(Boolean)
          .reduce((s, l) => { const m = l.match(/(-?\d+(?:\.\d+)?)$/); return s + (m ? Number(m[1]) : 0); }, 0);
        const totalRow = ws1.addRow({ name: 'TOTAL', inclusion: Number(total.toFixed(2)) });
        totalRow.font = { bold: true };
        totalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2d7a4f' } };
        totalRow.getCell('name').font = { bold: true, color: { argb: 'FFFFFFFF' } };
        totalRow.getCell('inclusion').font = { bold: true, color: { argb: 'FFFFFFFF' } };

        // Sheet 2 — Changes
        const ws2 = wb.addWorksheet('Ingredient Changes');
        ws2.columns = [
          { header: 'Ingredient', key: 'name', width: 28 },
          { header: 'Before %', key: 'before', width: 12 },
          { header: 'Corrected %', key: 'after', width: 14 },
          { header: 'Change %', key: 'diff', width: 12 },
        ];
        ws2.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        ws2.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a4d2e' } };
        (qf.changes || []).forEach((c, i) => {
          const diff = Number(c.after) - Number(c.before);
          const row = ws2.addRow({
            name: pdfNameMap[c.ingredient_id] || c.ingredient_id,
            before: Number(c.before).toFixed(4),
            after: Number(c.after).toFixed(4),
            diff: diff >= 0 ? `+${diff.toFixed(4)}` : diff.toFixed(4),
          });
          row.fill = i % 2 === 0
            ? { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFf0faf4' } }
            : { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
        });

        // Sheet 3 — Nutrient Profile
        const ws3 = wb.addWorksheet('Nutrient Profile');
        ws3.columns = [
          { header: 'Nutrient', key: 'name', width: 18 },
          { header: 'Reported', key: 'rep', width: 12 },
          { header: 'Before', key: 'before', width: 12 },
          { header: 'Corrected', key: 'after', width: 12 },
          { header: 'Target', key: 'target', width: 12 },
          { header: 'Status Before', key: 'was', width: 14 },
          { header: 'Status After', key: 'now', width: 14 },
        ];
        ws3.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        ws3.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a4d2e' } };

        const beforeAnalysis = session?.last_failed_formula?.analysis || session?.last_failed_formula?.analyze_result || {};
        const afterAnalysis = qf?.after_analysis || {};
        const beforeCalc = beforeAnalysis?.nutrient_profile_full || beforeAnalysis?.nutrient_profile || {};
        const afterCalc = afterAnalysis?.nutrient_profile_full || afterAnalysis?.nutrient_profile || {};
        const panel = beforeAnalysis?.meta?.reported_nutrients || session?.last_failed_formula?.ingestMeta?.reported_nutrients || {};
        const req = beforeAnalysis?.requirements_canonical || {};
        const dev = beforeAnalysis?.deviations_canonical || {};

        const nutrients = [
          ['ME', 'me'], ['CP', 'cp'], ['Ca', 'ca'], ['AvP', 'avp'],
          ['Na', 'na'], ['SID Lys', 'sid_lys'], ['SID Met', 'sid_met'],
          ['SID M+C', 'sid_metcys'], ['SID Thr', 'sid_thr'],
          ['SID Trp', 'sid_trp'], ['SID Arg', 'sid_arg'],
        ];

        function getStatus(key, calc) {
          const d = dev?.[key];
          if (d?.status) return d.status;
          const tgt = req?.[key];
          if (tgt == null) return '-';
          return Number(calc) >= Number(tgt) ? 'OK' : 'FAIL';
        }

        nutrients.forEach(([label, key], i) => {
          const tgt = dev?.[key]?.required ?? dev?.[key]?.target ?? req?.[key];
          if (tgt == null && !beforeCalc?.[key]) return;
          const wasSt = getStatus(key, beforeCalc?.[key]);
          const nowSt = getStatus(key, afterCalc?.[key]);
          const row = ws3.addRow({
            name: label,
            rep: panel?.[key] != null ? Number(panel[key]).toFixed(2) : '-',
            before: beforeCalc?.[key] != null ? Number(beforeCalc[key]).toFixed(2) : '-',
            after: afterCalc?.[key] != null ? Number(afterCalc[key]).toFixed(2) : '-',
            target: tgt != null ? Number(tgt).toFixed(2) : '-',
            was: wasSt,
            now: nowSt,
          });
          row.fill = i % 2 === 0
            ? { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFf0faf4' } }
            : { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
          // Color status cells
          const wasCell = row.getCell('was');
          const nowCell = row.getCell('now');
          if (wasSt === 'FAIL') wasCell.font = { color: { argb: 'FFb91c1c' }, bold: true };
          else if (wasSt === 'WARN') wasCell.font = { color: { argb: 'FFb7791f' }, bold: true };
          else if (wasSt === 'OK') wasCell.font = { color: { argb: 'FF1a4d2e' }, bold: true };
          if (nowSt === 'FAIL') nowCell.font = { color: { argb: 'FFb91c1c' }, bold: true };
          else if (nowSt === 'OK') nowCell.font = { color: { argb: 'FF1a4d2e' }, bold: true };
        });

        await wb.xlsx.writeFile(filePath);
        const url = `${FEEDBOT_PUBLIC_BASE_URL}/reports/${reportId}`;
        session.pending_download = null;
        session.updatedAt = nowMs();
        return `📊 Excel Formula Ready\n\nDownload:\n${url}`;
      } catch (err) {
        console.error('[ERR Excel]', err);
        return '❌ Excel generation failed. Try PDF instead (reply 1).';
      }
    }
if (choice === "3") {
  session.pending_deepfix_scenario = true;
  return (
    "🔬 Deep Optimization Mode\n\n" +
    "Choose scenario:\n" +
    "1 = Improve nutrition balance\n" +
    "2 = Reduce cost\n" +
    "3 = Reduce synthetic additives"
  );
}

if (choice === "4") {
  return await createNutrixLiteLinkFromSession({ session });
}

  }

  // ---------------- CHANGE / RESET CONTEXT ----------------
  if (/^(context|change context|reset context)$/i.test(Body)) {
    session.context = null;
    session.pending_context = null;
    return `Context reset.

Send your formula/PDF again, then I will ask species, type, breed, and phase.`;
  }

  // ---------------- COMMAND BYPASS FOR PENDING CONTEXT ----------------
const upperBodyForCommand = String(Body || "").trim().toUpperCase();

if (
  session?.pending_context &&
  /^(FIX|QUICK FIX|DEEP FIX|DEEPFIX|OPTIMIZE|ADVANCED|NUTRIX|WEB|LITE)$/i.test(upperBodyForCommand)
) {
  session.pending_context = null;
  session.updatedAt = nowMs();
}

  // ---------------- CONTEXT SELECTION REPLY ----------------
  if (session?.pending_context && Body) {
    const b = String(Body || "").trim().toLowerCase();

    if (b === "1" || /ross\s*308|ross308/i.test(b)) {
      session.context = {
        locale: "US",
        region: "global",
        version: "v1",
        species: "poultry",
        type: "broiler",
        production: "meat",
        breed: "Ross308",
        phase: "starter",
      };
    } else if (b === "2" || /cobb\s*500|cobb500/i.test(b)) {
      session.context = {
        locale: "US",
        region: "global",
        version: "v1",
        species: "poultry",
        type: "broiler",
        production: "meat",
        breed: "Cobb500",
        phase: "starter",
      };
    } else if (b === "3" || /hy[-\s]?line|hyline/i.test(b)) {
      session.context = {
        locale: "US",
        region: "global",
        version: "v1",
        species: "poultry",
        type: "layer",
        production: "egg",
        breed: "hyline",
        phase: "peak",
      };
    } else {
      return `Please reply with 1, 2, or 3.

1. Broiler →’ Ross308 →’ Starter
2. Broiler →’ Cobb500 →’ Starter
3. Layer →’ Hy-Line →’ Peak

Or type manually, e.g. Ross308 starter`;
    }

    // If there's a pending media file — process it now with selected context
    if (session.pending_media) {
      const media = session.pending_media;
      session.pending_media = null;
      session.pending_context = null;
      session.updatedAt = nowMs();
      startAsyncMediaJob({ From: media.From, To: media.To, MediaUrl0: media.MediaUrl0, MediaContentType0: media.MediaContentType0 });
      return "🐔 *Analyzing your formula...*\n\n🌾 Results will arrive in a few seconds.\n_(If delayed, type: RESULT)_";
    }

    const pending = session.pending_context;
    session.pending_context = null;
    session.updatedAt = nowMs();

    const r = await runAnalyze({
  formula_text: pending.formula_text,
  resolved_rows: pending.resolved_rows || [],
  ingestMeta: pending.ingestMeta || {},
  session,
});

if (r?.needs_context) return r.message;

// ðŸ”¥ STORE FAIL HERE (THIS IS THE MISSING PIECE)
const overall = String(r?.evaluation?.overall || r?.overall || "").toUpperCase();

if (overall === "FAIL" || overall === "WARN") {
  session.last_failed_formula = {
    analysis: r,
    formula_text:
  pending?.formula_text ||
  r?.formula_text ||
  r?.input?.formula_text ||
  session?.last_formula_text ||
  "",
    resolved_rows: pending.resolved_rows || [],
    ingestMeta: { ...(pending.ingestMeta || {}) },
    context: session.context || {},
    analyze_result: r,
    createdAt: nowMs(),
  };

  session.updatedAt = nowMs();

  console.log("[DBG STORE FAIL CONTEXT]", {
    stored: true,
    overall,
    formula_len: pending.formula_text?.length,
  });
}

return buildFinalReply({
  rAnalyze: r,
  ingestMeta: pending.ingestMeta || {},
  session,
});
  }

  if (/^(NUTRIX|NUTRIX LITE|WEB|LITE)$/i.test(Body)) {
    return await createNutrixLiteLinkFromSession({ session });
  }

  // DEEP FIX command: limited optimizer
  if (/^(OPTIMIZE|DEEP FIX|DEEPFIX|ADVANCED)$/i.test(Body)) {
    return await runDeepFixFromSession({ session });
  }

  // FIX command: real Quick Fix
  if (/^FIX$/i.test(Body)) {
  const lastFail = session?.last_failed_formula;
  console.log("[DBG FIX session]", {
    from: From,
    has_last_failed: !!lastFail,
    has_formula_text: !!lastFail?.formula_text,
    session_keys: Object.keys(session || {}),
    session_size: SESS.size,
    all_keys: Array.from(SESS.keys()),
  });

  if (!lastFail?.formula_text) {
    return "No failed formula found in this session.\n\nSend a formula first, and if it FAILS, reply: FIX";
  }

  const qf = await runQuickFixApi({
    formula_text: lastFail.formula_text,
    session,
  });

  session.last_quick_fix = {
    qf,
    createdAt: nowMs(),
  };

  session.pending_download = {
    type: "quick_fix",
    qf,
    createdAt: nowMs(),
  };

  session.updatedAt = nowMs();

  const nameMap = {
    corn_grain_avg: "Maize",
    soybean_meal_44_5_cp: "SBM 44%",
    soybean_meal_46_5_cp: "SBM 46.5%",
    soybean_meal_48_cp: "SBM 48%",
    soybean_meal_45_5_cp: "SBM 45.5%",
    fish_meal_54_cp: "Fish 54%",
    fish_meal_65_cp: "Fish 65%",
    corn_gluten_meal_60_cp: "CGM 60%",
    canola_meal: "Canola",
    sunflower_meal: "Sunflower",
    rice_broken: "Rice Brkn",
    millet_grain: "Millet",
    wheat_grain: "Wheat",
    wheat_bran: "Wheat Bran",
    wheat_middlings: "Wht Midds",
    sorghum_grain: "Sorghum",
    soy_oil: "Soy Oil",
    acid_oil: "Acid Oil",
    palm_oil: "Palm Oil",
    poultry_fat: "Pltry Fat",
    dl_met: "DL-Met",
    l_lys_hcl: "L-Lys HCl",
    l_lys_sulfate: "L-Lys SO4",
    l_thr: "L-Thr",
    l_trp: "L-Trp",
    l_val: "L-Val",
    l_ile: "L-Ile",
    l_arg: "L-Arg",
    limestone: "Limestone",
    dcp: "DCP",
    mcp: "MCP",
    salt: "Salt",
    sodium_bicarbonate: "Sod Bicarb",
    choline_chloride: "Choline",
    vitamin_premix: "Vit Premix",
    mineral_premix: "Min Premix",
    vit_min_premix: "Vit+Min",
    anti_coccidial: "Anticoccid",
    toxin_binder: "Toxin Bdr",
    phytase: "Phytase",
    nsps: "NSPase",
    protease: "Protease",
    agps: "AGPs",
    meat_bone_meal_45_cp: "MBM 45%",
    meat_bone_meal_48_cp: "MBM 48%",
    bovine_meat_bone_meal_48_cp: "MBM 48%",
    bovine_meat_bone_meal_43_cp: "MBM 43%",
    animal_protein_concentrate_55_cp: "APC 55%",
    animal_protein_concentrate_65_cp: "APC 65%",
    blood_meal: "Blood Meal",
    feather_meal_84_cp: "Fthr Meal",
    soybean_hulls: "Soy Hulls",
    beet_pulp: "Beet Pulp",
    molasses_cane: "Molasses",
    alfalfa_meal_17_cp: "Alfalfa",
    dicalcium_phosphate: "DiCa Phos",
    monosodium_phosphate: "MonoNa Ph",
  };

  function padName(v) {
    const raw = String(v || "-");
    const name = nameMap[raw] || raw;
    if (name.length <= 12) return name.padEnd(12, " ");
    return name.slice(0, 12).padEnd(12, " ");
  }

  function padVal(v) {
    const n = Number(v);

    if (Number.isNaN(n)) return "-".padStart(6, " ");
    if (n > 0 && n < 0.01) return n.toFixed(3).padStart(6, " ");

    let s;

    if (Math.abs(n) >= 100) {
      s = Math.round(n).toString();
    } else if (Math.abs(n) >= 10) {
      s = n.toFixed(1);
    } else {
      s = n.toFixed(2);
    }

    return s.padStart(6, " ");
  }

  function parseFormulaLines(text) {
    return String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^(.+?)\s+(-?\d+(?:\.\d+)?)$/);
        if (!m) return null;
        return {
          ingredient: m[1],
          inclusion: Number(m[2]),
        };
      })
      .filter(Boolean);
  }

  const out = [];

  out.push("AgroCore AI — Quick Fix");
  out.push(`Status: ${qf.status.before} -> ${qf.status.after}`);
  out.push("");

  out.push("Changes:");
  out.push("```");
  out.push("Ingredient   Before  After");
  out.push("------------ ------ ------");

  for (const c of qf.changes || []) {
    out.push(`${padName(c.ingredient_id)} ${padVal(c.before)} ${padVal(c.after)}`);
  }

  out.push("```");
  out.push("");

  const formulaRows = parseFormulaLines(qf.new_formula_text);

  out.push("Corrected formula:");
  out.push("```");
  out.push("Ingredient        %");
  out.push("------------ ------");

  for (const r of formulaRows) {
    out.push(`${padName(r.ingredient)} ${padVal(r.inclusion)}`);
  }

  out.push("```");
  out.push("");
  // Run analyze on corrected formula to show nutrient improvement
  try {
    const afterR = await runAnalyze({
      formula_text: qf.new_formula_text,
      resolved_rows: [],
      ingestMeta: {},
      session,
    });
    if (afterR && !afterR.needs_context) {
      const afterTable = buildNeatTable({ rAnalyze: afterR, ingestMeta: {}, session });
      out.push("");
      out.push("*Corrected Nutrient Profile:*");
      out.push(afterTable);
    }
  } catch(e) { /* skip if fails */ }

  out.push("");
  out.push("Download options:");
  out.push("1 = PDF correction report");
  out.push("2 = Excel corrected formula");
  out.push("3 = Deep Fix");
  out.push("4 = Open Nutrix Lite (full optimization)");
  
  const msg1 = out.slice(0, out.indexOf("Corrected formula:")).join("\n");
  const msg2 = out.slice(out.indexOf("Corrected formula:")).join("\n");
  
  session.pending_fix_part2 = msg2;
  session.updatedAt = nowMs();
  
  return msg1 + "\n\n_Reply MORE for corrected formula & download options_";
}

  const dmCmdResp = tryHandleDmCommand(Body, session);
  if (dmCmdResp) return dmCmdResp;

 if (NumMedia === 0 && looksLikeGreeting(Body)) {
  return "AgroCore AI\n\nHow can I help you today?";
}

  // ---------------- MEDIA PATH (IMPORTANT PATCH) ----------------
  if (NumMedia > 0) {
    session.pending_clarification = null;

    const mediaUrl0 = req.body?.MediaUrl0;
    const mediaCt0 = req.body?.MediaContentType0 || "application/octet-stream";
    if (!mediaUrl0) return "âŒ MediaUrl0 missing from Twilio payload.";

    // If no context yet — store media and ask for context first
    if (!session.context || !session.context.breed || !session.context.phase) {
      session.pending_media = {
        MediaUrl0: mediaUrl0,
        MediaContentType0: mediaCt0,
        From,
        To,
        createdAt: nowMs(),
      };
      session.updatedAt = nowMs();
      return `🐔 *File received!*\n\nBefore I analyze, please select the animal type:\n\n1️⃣ Broiler → Ross308 → Starter\n2️⃣ Broiler → Cobb500 → Starter\n3️⃣ Layer → Hy-Line → Peak\n4️⃣ Type manually (e.g. "Ross308 starter")`;
    }

    // Context exists — process immediately
    startAsyncMediaJob({ From, To, MediaUrl0: mediaUrl0, MediaContentType0: mediaCt0 });
    return "🐔 *Analyzing your formula...*\n\n🌾 Results will arrive in a few seconds.\n_(If delayed, type: RESULT)_";
  }

  
  // ---------------- Auto-detect farm performance data ----------------
  if (NumMedia === 0 && !session?.pending_clarification && looksLikePerfData(Body)) {
    const parsed  = parsePerfText(Body);
    const breed   = parseBreedFromText(Body) || session?.perf_context?.breed;
    const ageInfo = parseAgeFromText(Body)   || session?.perf_context;

    if (!breed || !ageInfo) {
      session.pending_perf_data = { text: Body, parsed };
      session.updatedAt = nowMs();
      return buildContextPrompt();
    }

    const context = { breed, age: ageInfo.age, ageUnit: ageInfo.ageUnit };
    const result  = analyzePerformance(parsed, context);

    session.last_perf_data   = { parsed, context };
    session.last_perf_result = result;
    session.perf_context     = context;
    session.updatedAt = nowMs();

    const reply = buildPerfTable({ result, context });
    if (result.overall === "FAIL" || result.overall === "WARN") {
      return `${reply}\n\nReply ADVICE for recommendations.`;
    }
    return reply;
  }

  // ---------------- TEXT PATH (unchanged behavior) ----------------
  let formula_text = "";
  const ingestMeta = {};

  if (session?.pending_clarification && looksLikeGradeOnlyReply(Body)) {
    const pending = session.pending_clarification;
    const replies = parseGradeOnlyReply(Body);

    const replacementLines = buildReplacementLinesFromNeeds(pending?.needs_clarification, replies);
    if (!replacementLines.length) {
      return (
        "âš ï¸ I detected a clarification reply but couldn't apply it.\n\nTry:\n" +
        "- SBM 48\n- Canola meal 36\n- Rapeseed meal 28\n" +
        "(No need to include %; I will use the stored inclusions.)"
      );
    }

    formula_text = applyClarificationsToPreviousFormula(pending.formula_text, replacementLines);
    ingestMeta.normalize = !!pending.normalize;

    console.log("[DBG clarification applied]", {
      From,
      normalize_carry: !!ingestMeta.normalize,
      replacementLines,
      new_formula_head: formula_text.slice(0, 160),
    });
  } else {
    const repx = extractReportedBlock(Body);
    if (repx.reported_nutrients) {
      ingestMeta.reported_nutrients = repx.reported_nutrients;
      console.log("[DBG reported block]", { From, reported_keys: Object.keys(repx.reported_nutrients) });
    }

    const nx = extractNormalizeCommand(repx.clean_text);
    ingestMeta.normalize = nx.normalize;

    if (nx.normalize && !nx.text) {
      return (
        "✅ NORMALIZE enabled.\nNow send ingredients after NORMALIZE.\n\nExample:\n" +
        "NORMALIZE\nCorn 55\nSBM 48 30\nOil 3\nSalt 0.3"
      );
    }

    formula_text = nx.text;

    if (!formula_text.trim() && ingestMeta.reported_nutrients) {
      return (
        "✅ Reported nutrition panel saved.\nNow paste the formula ingredients below it.\n\nExample:\n" +
        "REPORTED\nME 3000\nCP 21\n\nCorn 55\nSBM 48 30\nOil 3\nSalt 0.3"
      );
    }
  }

if (session?.pending_clarification && Body) {
  const pending = session.pending_clarification;
  const needs = Array.isArray(pending.needs_clarification) ? pending.needs_clarification : [];

  const resolvedMap = parseClarificationReply(Body, needs);
  const countResolved = Object.keys(resolvedMap).length;

  if (countResolved > 0) {
    const rebuiltFormula = applyClarificationToFormula(
      pending.formula_text,
      needs,
      resolvedMap
    );

    session.pending_clarification = null;

    session.last_formula_text = pending.formula_text;
    const r = await runAnalyze({
      formula_text: rebuiltFormula,
      resolved_rows: [],
      ingestMeta: pending.ingestMeta || {},
      session,
    });

    const overall = String(r?.evaluation?.overall || r?.overall || "").toUpperCase();

    if (overall === "FAIL") {
      session.last_failed_formula = {
        analysis: r,
        formula_text: rebuiltFormula,
        resolved_rows: resolveFormulaRows(rebuiltFormula),
        ingestMeta: { ...(pending.ingestMeta || {}) },
        context: {
          locale: "US",
          species: "poultry",
          type: "broiler",
          phase: "starter",
        },
        analyze_result: r,
        createdAt: nowMs(),
      };
    }

    const reply = buildFinalReply({
      rAnalyze: r,
      ingestMeta: pending.ingestMeta || {},
      session
    });

    if (overall === "FAIL") {
      return `${reply}\n\nReply FIX to generate a quick corrected formula.`;
    }

    return reply;
  }
}


const r = await runAnalyze({
  formula_text,
  resolved_rows: [],
  ingestMeta,
  session
});

if (r?.needs_context) {
  return r.message;
}

const parsedTotal = Number(
  r?.parsed?.total ?? r?.parsed?.total_inclusion ?? 0
);

// 1) Handle empty / non-formula input FIRST
if (!parsedTotal || parsedTotal <= 0) {
  return (
    "âš ï¸ I could not detect a valid formula in your message.\n\n" +
    "Please send one of these:\n" +
    "- a full formula text\n" +
    "- a PDF/Excel file\n" +
    "- or a clarification reply like: 1-48, 2-36, 3-54"
  );
}

// 2) Handle clarification
if (isNeedsClarificationResponse(r)) {
  session.pending_clarification = {
    createdAt: nowMs(),
    normalize: !!ingestMeta?.normalize,
    formula_text,
    ingestMeta: { ...ingestMeta },
    needs_clarification: Array.isArray(r?.needs_clarification) ? r.needs_clarification : [],
  };
  session.updatedAt = nowMs();

  console.log("[DBG clarification STORED]", {
    From,
    pending_count: session.pending_clarification.needs_clarification.length,
    formula_head: String(formula_text || "").slice(0, 160),
  });

  const prompt =
    buildNumberedClarificationPrompt(session.pending_clarification.needs_clarification);

  return prompt;
} else {
  if (session?.pending_clarification) {
    console.log("[DBG clarification CLEARED]", { From });
    session.pending_clarification = null;
    session.updatedAt = nowMs();
  }
}

const overall = String(r?.evaluation?.overall || r?.overall || "").toUpperCase();

if (overall === "FAIL") {
  session.last_failed_formula = {
    analysis: r,
    formula_text,
    resolved_rows: resolveFormulaRows(formula_text),
    ingestMeta: { ...ingestMeta },
    context: {
      locale: "US",
      species: "poultry",
      type: "broiler",
      phase: "starter",
    },
    analyze_result: r,
    createdAt: nowMs(),
  };
}

const reply = buildFinalReply({ rAnalyze: r, ingestMeta, session });

if (overall === "FAIL") {
  return `${reply}\n\nReply FIX to generate a quick corrected formula.`;
}

return reply;
}

async function runDeepFixFromSession({ session }) {
  try {
    const lastFail = session?.last_failed_formula;

    if (!lastFail?.formula_text) {
      return "No failed formula found for Deep Fix.\n\nSend a formula first, and if it FAILS, reply: OPTIMIZE";
    }

    const formulaForDeepFix =
      session?.last_quick_fix?.new_formula_text ||
      lastFail.formula_text;

    const opt = await runOptimize({
      formula_text: formulaForDeepFix,
      ingestMeta: lastFail.ingestMeta || {},
      session,
      lastFail,
    });

    session.last_deep_fix = {
      opt,
      createdAt: nowMs(),
    };

    session.updatedAt = nowMs();

    return formatDeepFixReply(opt, formulaForDeepFix);
  } catch (err) {
    console.error("[ERR DEEP FIX]", err);
    return (
      "âŒ Deep Fix could not complete optimization.\n\n" +
      "Quick Fix is still available. Reply: FIX"
    );
  }
}

function formatDeepFixReply(opt, originalFormulaText) {
  const out = [];

  const status =
    opt?.status ||
    opt?.solver_status ||
    opt?.lp_status ||
    opt?.optimization_status ||
    "COMPLETED";

  out.push("AgroCore AI");
  out.push(`Status: ${status}`);
  out.push("");

  const optimizedText = buildOptimizedFormulaText(opt, originalFormulaText);

  if (String(status).toLowerCase().includes("infeasible")) {
  out.push("Result:");
  out.push("The optimizer could not find a feasible formula under limited WhatsApp rules.");
  out.push("");
  out.push("Most likely reason:");
  out.push("- movement limits are too tight");
  out.push("- no new ingredients allowed");
  out.push("- nutrient targets require stronger formula changes");
  out.push("");
  out.push("Try:");
  out.push("FIX = Quick Fix");
  out.push("or use Nutrix Dashboard for full optimization controls.");
  return out.join("\n");
  
  return fullReply;
}

function formatDeepFixScenarioReply(opt, scenario) {
  const out = [];

  const status =
    opt?.status ||
    opt?.solver_status?.termination ||
    opt?.optimization_status ||
    "COMPLETED";

  out.push("AgroCore AI");

  if (scenario === "cost") {
    out.push("Scenario: Cost Reduction");
  } else if (scenario === "low_synthetic") {
    out.push("Scenario: Low Synthetic Additives");
  } else {
    out.push("Scenario: Nutrition Balance");
  }

  out.push(`Status: ${status}`);
  out.push("");

  const rows = Array.isArray(opt?.starting_formula_comparison?.rows)
    ? opt.starting_formula_comparison.rows
    : [];

  const changedRows = rows
    .map((r) => {
      const before = Number(r.start_inclusion || 0);
      const after = Number(r.optimized_inclusion || 0);
      const delta = after - before;

      return {
        id: r.id || r.display_name || "ingredient",
        before,
        after,
        delta,
        absDelta: Math.abs(delta),
      };
    })
    .filter((r) => r.absDelta > 0.001)
    .sort((a, b) => b.absDelta - a.absDelta)
    .slice(0, 8);

  if (!changedRows.length) {
    out.push("Result:");
    out.push("No major ingredient movement was needed under this scenario.");
    out.push("");
  } else {
    out.push("Top Changes:");
    out.push("```");
    out.push("Ingredient     Before  After");
    out.push("------------   ------ ------");

    for (const r of changedRows) {
      const name =
        r.id.length <= 12
          ? r.id.padEnd(12, " ")
          : (r.id.slice(0, 6) + ".." + r.id.slice(-4)).padEnd(12, " ");

      out.push(
        `${name} ${r.before.toFixed(2).padStart(6, " ")} ${r.after
          .toFixed(2)
          .padStart(6, " ")}`
      );
    }

    out.push("```");
    out.push("");
  }

  const nutrientResults = opt?.nutrient_results || {};
  const nutrientKeys = Object.keys(nutrientResults).slice(0, 8);

  if (nutrientKeys.length) {
    out.push("Optimized Nutrients:");
    out.push("```");

    for (const key of nutrientKeys) {
      const val = Number(nutrientResults[key]);
      out.push(
        `${String(key).padEnd(10, " ")} ${
          Number.isFinite(val) ? val.toFixed(3) : "-"
        }`
      );
    }

    out.push("```");
    out.push("");
  }

  if (scenario === "cost") {
    out.push("Focus: lower-cost optimized formula under controlled rules.");
  } else if (scenario === "low_synthetic") {
    out.push("Focus: reduce synthetic additive dependence where possible.");
  } else {
    out.push("Focus: improve nutrient balance with limited formula movement.");
  }

  out.push("");
  out.push("Reply:");
  out.push("1 = PDF report");
  out.push("2 = Excel formula");

  return out.join("\n");
}

  out.push("Optimized formula:");
  out.push("```");

  if (optimizedText) {
    out.push("Ingredient        %");
    out.push("------------ ------");

    const rows = parseFormulaTextToRows(optimizedText);

    for (const r of rows.slice(0, 25)) {
      const name = String(r.ingredient || "-");
      const short =
        name.length <= 12
          ? name.padEnd(12, " ")
          : (name.slice(0, 6) + "." + name.slice(-4)).padEnd(12, " ");

      const n = Number(r.inclusion);
      const val = Number.isFinite(n) ? n.toFixed(2).padStart(6, " ") : "-".padStart(6, " ");

      out.push(`${short} ${val}`);
    }
  } else {
    out.push("Optimizer completed, but optimized formula rows were not found in response.");
  }

  out.push("```");
  out.push("");
  out.push("Summary:");
  out.push("✓ Solver-backed correction");
  out.push("✓ Nutrition-first limited mode");
  out.push("✓ WhatsApp simplified output");
  out.push("");
  out.push("Full Nutrix optimization controls will stay in dashboard.");

  return out.join("\n");
}

async function createNutrixLiteLinkFromSession({ session }) {
  try {
    const lastFail = session?.last_failed_formula;

    if (!lastFail?.formula_text) {
      return (
        "No formula found for Nutrix Lite.\n\n" +
        "Please upload or paste a formula first."
      );
    }

    const analysis = lastFail.analysis || lastFail.analyze_result || null;

let originalFormula = [];

if (Array.isArray(lastFail.resolved_rows) && lastFail.resolved_rows.length > 0) {
  originalFormula = lastFail.resolved_rows.map((r) => ({
    id: r.ingredient_code || r.canonical_id || r.ingredient_id || r.id,
    ingredient_id: r.ingredient_code || r.canonical_id || r.ingredient_id || r.id,
    ingredient_name: r.ingredient_name || r.raw_name || r.id,
    inclusion: Number(r.inclusion || 0),
    min: 0,
    max: 100,
    active: true,
    cost: 1,
  }));
} else if (lastFail.formula_text) {
  // ðŸ”¥ FALLBACK: rebuild from text
  originalFormula = lastFail.formula_text
    .split("\n")
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) return null;

      const val = parseFloat(parts.pop());
      const name = parts.join(" ");

      return {
        id: name.toLowerCase().replace(/\s+/g, "_"),
        ingredient_id: name.toLowerCase().replace(/\s+/g, "_"),
        ingredient_name: name,
        inclusion: isNaN(val) ? 0 : val,
        min: 0,
        max: 100,
        active: true,
        cost: 1,
      };
    })
    .filter(Boolean);
}

const quickFixFormula = Array.isArray(session?.last_quick_fix?.formula_rows)
  ? session.last_quick_fix.formula_rows
  : Array.isArray(session?.last_quick_fix?.corrected_rows)
  ? session.last_quick_fix.corrected_rows
  : [];

const payload = {
  source: "whatsapp",
  mode: "nutrix_lite",
  context: session.context || lastFail.context || {},

  original_formula: originalFormula,
  quick_fix_formula: quickFixFormula,

  reported_nutrients:
    lastFail.ingestMeta?.reported_nutrients ||
    analysis?.reported_nutrients ||
    {},

  calculated_before:
    analysis?.nutrient_profile_full ||
    analysis?.nutrient_profile ||
    analysis?.calculated ||
    {},

  calculated_after:
    session?.last_quick_fix?.analysis?.nutrient_profile_full ||
    session?.last_quick_fix?.analysis?.nutrient_profile ||
    {},

  nutrient_comparison:
    analysis?.nutrient_comparison ||
    analysis?.comparison ||
    [],

  ingredient_changes:
    session?.last_quick_fix?.changes ||
    session?.last_quick_fix?.ingredient_changes ||
    [],

  allowed_actions: {
    view: true,
    optimize: true,
    download_pdf: true,
    download_excel: true,
    send_back_to_whatsapp: true,
    edit_formula: true,
    edit_min_max: true,
    edit_ingredient_db: false,
    access_full_dashboard: false,
  },
};

    const resp = await axios.post(`${AGROCORE_BASE}/v1/lite/cases`, payload, {
      timeout: 30000,
      validateStatus: () => true,
    });

    if (resp.status < 200 || resp.status >= 300 || !resp.data?.ok) {
      console.error("[NUTRIX_LITE] create case failed", resp.status, resp.data);
      return "Nutrix Lite link could not be created yet.";
    }

    const base =
      process.env.NUTRIX_WEB_BASE ||
      process.env.PUBLIC_WEB_BASE ||
      "http://localhost:4200";

    const url = `${base}${resp.data.lite_url_path}`;

    return (
      "🌐 Nutrix Lite Access\n\n" +
      "Your formula is ready for limited web optimization.\n\n" +
      `${url}\n\n` +
      "This link gives controlled access only. Full Nutrix dashboard remains separate."
    );
  } catch (err) {
    console.error("[NUTRIX_LITE] error", err);
    return "Nutrix Lite link could not be created.";
  }
}

async function runDeepFixScenario({ session, scenario }) {
  try {
    const lastFail = session?.last_failed_formula;

    if (!lastFail?.formula_text) {
      return "No formula found. Upload and analyze first.";
    }

    const opt = await runOptimize({
      formula_text: lastFail.formula_text,
      ingestMeta: lastFail.ingestMeta || {},
      session,
      lastFail,
      scenario,
    });

    return formatDeepFixScenarioReply(opt, scenario);
  } catch (err) {
    console.error("[ERR DEEP SCENARIO]", err);
    return "âŒ Deep optimization failed.";
  }
}

async function loadIngredientProfileMap() {
  try {
    const resp = await axios.get(`${AGROCORE_BASE}/v1/ingredients?species=poultry&region=us&version=v1&basis=sid`, {
      timeout: 15000,
      validateStatus: () => true,
    });

    const rows =
      Array.isArray(resp.data) ? resp.data :
      Array.isArray(resp.data?.items) ? resp.data.items :
      Array.isArray(resp.data?.ingredients) ? resp.data.ingredients :
      Array.isArray(resp.data?.rows) ? resp.data.rows :
      Array.isArray(resp.data?.data) ? resp.data.data :
      [];

    const map = {};
    const NUTRIENT_KEYS = ['me','ge','amen','cp','ee','cf','ndf','adf','ash','ca','p','avp','na','k','cl','deb',
      'lys','met','metcys','thr','trp','arg','ile','leu','val','his','phe','cys',
      'sid_lys','sid_met','sid_metcys','sid_thr','sid_trp','sid_arg','sid_ile','sid_leu','sid_val',
      'tdlys','tdmet','tdthr','tdtrp','tdarg','dm','moisture','starch','sugar','fat'];
    for (const r of rows) {
      const id = r?.ingredient_id || r?.id || r?.canonical_id || r?.ingredient_code;
      if (!id) continue;
      // Build profile from flat fields
      let profile = r?.nutrient_profile || r?.nutrient_profile_full || r?.nutrients || r?.profile || null;
      if (!profile || Object.keys(profile).length === 0) {
        profile = {};
        for (const key of NUTRIENT_KEYS) {
          if (r[key] != null && r[key] !== '') profile[key] = Number(r[key]);
        }
      }
      if (Object.keys(profile).length > 0) {
        map[String(id)] = profile;
      }
    }

    console.log("[DEEP_FIX] ingredient profiles loaded", {
      count: Object.keys(map).length,
      sample: Object.keys(map).slice(0, 10),
    });

    return map;
  } catch (err) {
    console.error("[DEEP_FIX] ingredient profile load failed", err?.message || err);
    return {};
  }
}

// ---------------- Routes ----------------
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true, service: "feedbot-whatsapp" }));

app.post("/whatsapp", (req, res) => SafeReply(async (req) => whatsappHandler(req), req, res));
app.post("/", (req, res) => SafeReply(async (req) => whatsappHandler(req), req, res));

app.listen(PORT, () => {
  console.log(`feedbot-whatsapp listening on ${PORT}`);
  console.log(`AGROCORE_BASE=${AGROCORE_BASE}`);
  console.log(`TWILIO_ACCOUNT_SID set: ${!!TWILIO_ACCOUNT_SID}`);
  console.log(`TWILIO_AUTH_TOKEN set: ${!!TWILIO_AUTH_TOKEN}`);
});





