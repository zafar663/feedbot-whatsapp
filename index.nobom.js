// FILE: C:\Users\Administrator\My Drive\NutriPilot\nutripilot-agrocore\feedbot-whatsapp\index.js
"use strict";

/**
 * feedbot-whatsapp/index.js
 * NutriPilot vSafeReply âœ… (Thin Client â†’ AgroCore API) v1.3 â€” LOCKED (PATCHED)
 *
 * Patch goal (minimal change, high impact):
 * âœ… ALWAYS respond to Twilio webhook immediately for media uploads (TwiML ACK)
 * âœ… Process media asynchronously and send final result via Twilio REST API
 * âœ… If Twilio REST send fails (e.g. 63038 daily cap), store result in session
 * âœ… User can type: RESULT  -> bot returns stored last result via normal TwiML reply
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
  return n.toFixed(Math.min(dec ?? 2, maxDec)).replace(/\.00$/, "");
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
    return "âœ… DM overrides cleared.";
  }

  const m = t.match(/^DM\s+(CORN|MAIZE)\s+([0-9]+(\.[0-9]+)?)$/i);
  if (m) {
    const who = m[1].toUpperCase();
    const v = Number(m[2]);
    if (!(v >= 50 && v <= 95)) return "âŒ DM must be between 50 and 95. Example: DM CORN 86.5";
    session.dm_overrides.corn = v;
    session.updatedAt = nowMs();
    return `âœ… DM set: ${who} = ${fmt(v, 2)}%\n(Will be applied when AgroCore DM calibration is enabled.)`;
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
    if (s === "OK") return "âœ“";
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

  out.push("Live IQ");
  out.push(`Status: ${ev?.overall || rAnalyze?.overall || "NO_STATUS"}`);

  if (rAnalyze?.requirements_used?.reqKey) {
    out.push(`Profile: ${rAnalyze.requirements_used.reqKey}`);
  }

  out.push("");
  out.push("Nutrient check");
  out.push("");

  out.push("Nutr|  Rep| Calc|  Tgt|S");
  out.push("----|-----|-----|-----|-");

  for (const [label, key] of rows) {
    const reported = val(panel, key);
    const calculated = val(calc, key);
    const tgt = target(key);
    const st = statusSymbol(status(key));

    if (reported === "-" && calculated === "-" && tgt === "-") continue;

    out.push(
      `${padLabel(label)}|${padNum(reported)}|${padNum(calculated)}|${padNum(tgt)}|${st}`
    );
  }

  out.push("");
  out.push("âœ“ OK   ~ WARN   x FAIL");

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

1. Broiler â†’ Ross308 â†’ Starter
2. Broiler â†’ Cobb500 â†’ Starter
3. Layer â†’ Hy-Line â†’ Peak
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
    phase: session?.context?.phase || "starter",

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
function startAsyncMediaJob({ From, To, MediaUrl0, MediaContentType0 }) {
  setImmediate(async () => {
    const session = touchSession(From);
    const ingestMeta = {};

    try {
      console.log("[DBG async media] start", { From, MediaUrl0, MediaContentType0 });

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

      const formula_text = ft.trim();
      if (!formula_text) throw new Error("Ingest ok but formula_text empty.");

      const resolved_rows = Array.isArray(ing?.resolved_rows) ? ing.resolved_rows : [];

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
  const reportId = `liveiq-quickfix-${Date.now()}.pdf`;
  const outDir = path.join(__dirname, "public", "reports");
  fs.mkdirSync(outDir, { recursive: true });

  const filePath = path.join(outDir, reportId);
  const bannerPath = path.join(__dirname, "assets", "agrocore-banner.png");

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
        "Live IQ Quick Fix is rule-based. Use Deep Fix / Optimization Engine for precision least-cost formulation and nutrient balancing.",
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
    const rowH = opts.rowH || 17;
    const fontSize = opts.fontSize || 8;

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
        return [m[1], Number(m[2]).toFixed(4)];
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

  // Header
  if (fs.existsSync(bannerPath)) {
    doc.image(bannerPath, {
      fit: [usableWidth, 105],
      align: "center",
    });
    doc.moveDown(0.5);
  }

  doc
    .font("Helvetica-Bold")
    .fontSize(18)
    .fillColor(darkGreen)
    .text("Live IQ", { align: "center" });

  doc
    .font("Helvetica")
    .fontSize(12)
    .fillColor(dark)
    .text("Quick Fix Correction Report", { align: "center" });

  doc.moveDown(0.8);

  section("1. Summary");

  table(
    ["Item", "Value"],
    [
      ["Generated", new Date().toLocaleString()],
      ["Status", `${qf?.status?.before || "-"} -> ${qf?.status?.after || "-"}`],
      ["Report Type", "Live IQ Quick Fix Correction"],
      ["Next Step", "Use Deep Fix / Optimization Engine for full formulation balancing"],
    ],
    [150, usableWidth - 150],
    { rowH: 17, fontSize: 8 }
  );

  section("2. Nutrient Comparison: Reported vs Before vs Corrected");

  table(
    ["Nutrient", "Reported", "Before", "Corrected", "Target", "Before Status", "After Status"],
    await buildNutrientRows(),
    [70, 58, 58, 70, 58, 92, usableWidth - 406],
    { rowH: 17, fontSize: 7.2 }
  );

  section("3. Ingredient Changes: Before vs Corrected", true);

  const changeRows = (qf?.changes || []).map((c) => {
    const before = Number(c.before || 0);
    const after = Number(c.after || 0);
    const diff = after - before;

    return [
      c.ingredient_id || "-",
      before.toFixed(4),
      after.toFixed(4),
      diff >= 0 ? `+${diff.toFixed(4)}` : diff.toFixed(4),
    ];
  });

  table(
    ["Ingredient", "Before %", "Corrected %", "Change %"],
    changeRows,
    [250, 80, 95, usableWidth - 425],
    { rowH: 17, fontSize: 8 }
  );

  section("4. Corrected Formula", true);

  table(
    ["Ingredient", "Inclusion %"],
    parseFormula(qf?.new_formula_text),
    [usableWidth - 115, 115],
    { rowH: 17, fontSize: 8 }
  );

  doc.moveDown(0.8);
doc
  .font("Helvetica")
  .fontSize(8)
  .fillColor(gray)
  .text(
    "Live IQ Quick Fix is rule-based. Use Deep Fix / Optimization Engine for precision least-cost formulation and nutrient balancing.",
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

  // ---------------- OPENING / GREETING ----------------
  if (!NumMedia && looksLikeGreeting(Body)) {
    session.qa_context = null;
    return buildMainMenu();
  }

  // ---------------- Q&A ENGINE ----------------
  if (!NumMedia) {
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

    // Try Live IQ engine first
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

  // ---------------- RESULT command ----------------
  if (/^RESULT$/i.test(Body)) {
    const last = session?.last_async_result;
    if (last?.text) return last.text;
    return "No stored result yet. Send a PDF/Excel/photo to analyze, then type RESULT if you donâ€™t receive a reply.";
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
          "Live IQ",
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
      return "ðŸ“Š Excel corrected formula is the next step to generate here.";
    }
if (choice === "3") {
  session.pending_deepfix_scenario = true;
  return (
    "ðŸ”¬ Deep Optimization Mode\n\n" +
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

1. Broiler â†’ Ross308 â†’ Starter
2. Broiler â†’ Cobb500 â†’ Starter
3. Layer â†’ Hy-Line â†’ Peak

Or type manually, e.g. Ross308 starter`;
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

  function padName(v) {
    const name = String(v || "-");

    if (name.length <= 12) {
      return name.padEnd(12, " ");
    }

    return (name.slice(0, 6) + ".." + name.slice(-4)).padEnd(12, " ");
  }

  function padVal(v) {
    const n = Number(v);

    if (Number.isNaN(n)) return "-".padStart(6, " ");

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

  out.push("Live IQ Quick Fix");
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
  out.push("Download options:");
  out.push("1 = PDF correction report");
  out.push("2 = Excel corrected formula");
  out.push("3 = Deep Fix");
  out.push("4 = Open Nutrix Lite");

  return out.join("\n");
}

  const dmCmdResp = tryHandleDmCommand(Body, session);
  if (dmCmdResp) return dmCmdResp;

 if (NumMedia === 0 && looksLikeGreeting(Body)) {
  return "Live IQ\n\nHow can I help you today?";
}

  // ---------------- MEDIA PATH (IMPORTANT PATCH) ----------------
  if (NumMedia > 0) {
    session.pending_clarification = null;

    const mediaUrl0 = req.body?.MediaUrl0;
    const mediaCt0 = req.body?.MediaContentType0 || "application/octet-stream";
    if (!mediaUrl0) return "âŒ MediaUrl0 missing from Twilio payload.";

    // âœ… Always ACK immediately (TwiML), then process async
    startAsyncMediaJob({ From, To, MediaUrl0: mediaUrl0, MediaContentType0: mediaCt0 });
    return "âœ… File received. Processing nowâ€¦\n\nIf you donâ€™t receive results (Twilio daily cap), type: RESULT";
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
        "âœ… NORMALIZE enabled.\nNow send ingredients after NORMALIZE.\n\nExample:\n" +
        "NORMALIZE\nCorn 55\nSBM 48 30\nOil 3\nSalt 0.3"
      );
    }

    formula_text = nx.text;

    if (!formula_text.trim() && ingestMeta.reported_nutrients) {
      return (
        "âœ… Reported nutrition panel saved.\nNow paste the formula ingredients below it.\n\nExample:\n" +
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

  out.push("Live IQ");
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
}

function formatDeepFixScenarioReply(opt, scenario) {
  const out = [];

  const status =
    opt?.status ||
    opt?.solver_status?.termination ||
    opt?.optimization_status ||
    "COMPLETED";

  out.push("Live IQ");

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
  out.push("âœ” Solver-backed correction");
  out.push("âœ” Nutrition-first limited mode");
  out.push("âœ” WhatsApp simplified output");
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
      "ðŸŒ Nutrix Lite Access\n\n" +
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
    const resp = await axios.get(`${AGROCORE_BASE}/v1/ingredients`, {
      timeout: 15000,
      validateStatus: () => true,
    });

    const rows =
      Array.isArray(resp.data) ? resp.data :
      Array.isArray(resp.data?.ingredients) ? resp.data.ingredients :
      Array.isArray(resp.data?.rows) ? resp.data.rows :
      Array.isArray(resp.data?.data) ? resp.data.data :
      [];

    const map = {};

    for (const r of rows) {
      const id =
        r?.id ||
        r?.ingredient_id ||
        r?.canonical_id ||
        r?.ingredient_code;

      const profile =
        r?.nutrient_profile ||
        r?.nutrient_profile_full ||
        r?.nutrients ||
        r?.profile ||
        r;

      if (id && profile && typeof profile === "object") {
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





