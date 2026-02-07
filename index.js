/**
 * NutriPilot AI — Full index.js (stable webhook + anti-silence)
 * What this version fixes:
 * 1) Adds GET /whatsapp so you DON'T see confusing "Cannot GET /whatsapp"
 * 2) Ensures EVERY inbound request returns valid TwiML (no silent failures)
 * 3) Adds /health and /debug endpoints for quick checks
 * 4) Keeps your main menu + Core1 -> Formula Review -> input method menus
 *
 * IMPORTANT TWILIO SETTING (must match exactly):
 * Twilio Sandbox → "WHEN A MESSAGE COMES IN"
 * URL: https://feedbot-whatsapp.onrender.com/whatsapp
 * Method: POST
 */

require("dotenv").config();
const express = require("express");
const twilio = require("twilio");

const app = express();

// Twilio sends application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

/* -------------------------- TEXT -------------------------- */

const VERSION = "NutriPilot AI vStableWebhook ✅";

const MAIN_MENU =
  `NutriPilot AI\n\n` +
  `How can we help you today?\n\n` +
  `1) Formulation & Diet Control\n` +
  `2) Performance & Production Intelligence\n` +
  `3) Raw Materials, Feed Mill & Quality\n` +
  `4) Expert Review\n` +
  `5) Nutrition Partner Program\n\n` +
  `Reply with a number or type MENU.`;

const CORE1_MENU =
  `Formulation & Diet Control\n\n` +
  `1) Formula review (MVP)\n` +
  `2) Reformulation (next)\n` +
  `3) Diet approval / risk check (next)\n` +
  `4) Additives & enzymes guidance (next)\n\n` +
  `Reply 1 for now, or type MENU.`;

const FORMULA_REVIEW_METHOD =
  `Formula Review – Submit your diet\n\n` +
  `Choose input method:\n\n` +
  `1) Guided manual entry (% only)\n` +
  `2) Bulk paste (% only)\n` +
  `3) Upload Excel/CSV (next)\n` +
  `4) Upload photo/PDF (next)\n\n` +
  `Reply 1 or 2 for now, or type MENU.`;

/* -------------------------- SESSION STORE -------------------------- */
/** Simple in-memory sessions (stable). Replace with Redis later. */
const sessions = new Map();

function freshSession() {
  return {
    step: "MAIN",
    lastReport: "",
    fr: {
      animal: null,
      poultryType: null,
      strain: null,
      stage: null,
      feedForm: null,
      method: null,
      items: [] // { name, key, pct, meta:{} }
    }
  };
}

function getSession(key) {
  if (!sessions.has(key)) sessions.set(key, freshSession());
  return sessions.get(key);
}
function resetSession(key) {
  sessions.set(key, freshSession());
}

/* -------------------------- UTILITIES -------------------------- */

function norm(s) {
  return (s || "").toLowerCase().trim();
}
function firstDigit(raw) {
  const m = String(raw || "").trim().match(/^(\d)/);
  return m ? m[1] : null;
}
function safeNum(x) {
  if (x === null || x === undefined) return null;
  const s = String(x).trim().replace(/,/g, "").replace(/o/gi, "0");
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}
function extractTrailingNumber(text) {
  const s = String(text || "").replace(/,/g, " ").trim();
  const m = s.match(/(-?\d+(?:\.\d+)?)\s*%?\s*$/);
  if (!m) return null;
  return safeNum(m[1]);
}
function stripTrailingNumber(text) {
  return String(text || "").trim().replace(/(-?\d+(?:\.\d+)?)\s*%?\s*$/, "").trim();
}
function canonicalKey(name) {
  const n = norm(name);

  // core synonyms (expand later)
  if (n.includes("maize") || n === "corn") return "corn";
  if (n.includes("soybean meal") || n.includes("sbm")) return "sbm";
  if (n.includes("broken rice") || n.includes("rice broken")) return "broken_rice";
  if (n.includes("fishmeal") || n.includes("fish meal")) return "fishmeal";
  if (n.includes("canola")) return "canola_meal";
  if (n.includes("sunflower")) return "sunflower_meal";
  if (n.includes("millet") || n.includes("bajra")) return "millet";
  if (n.includes("soybean oil") || n.includes("soya oil")) return "soy_oil";
  if (n.includes("corn gluten")) return "cgf60";
  if (n.includes("salt")) return "salt";
  if (n.includes("limestone")) return "limestone";
  if (n.includes("dcp") || n.includes("dicalcium")) return "dcp";
  if (n.includes("mcp") || n.includes("monocalcium")) return "mcp";

  return n.replace(/[^\w]+/g, "_").slice(0, 40);
}

function parseAddLine(raw) {
  // Accepts:
  // "ADD Maize 27.45"
  // "Maize27.45"
  // "SBM44% 25.34"
  // "Sunflower meal26-28%5"
  // "Bajra 4,"
  const s = String(raw || "").trim();
  if (!s) return null;

  let body = s.replace(/,+$/, "").trim();
  if (body.toUpperCase().startsWith("ADD ")) body = body.slice(4).trim();

  const pct = extractTrailingNumber(body);
  if (pct === null) return null;

  const name = stripTrailingNumber(body).replace(/[:\-]+$/, "").trim();
  if (!name) return null;

  return { name, pct };
}

function parseBulkPaste(text) {
  const chunks = String(text || "")
    .replace(/\r/g, "\n")
    .split(/[\n;,]+/)
    .map(x => x.trim())
    .filter(Boolean);

  const items = [];
  const unreadable = [];
  for (const c of chunks) {
    const p = parseAddLine(c);
    if (!p) unreadable.push(c);
    else items.push(p);
  }
  return { items, unreadable };
}

function addItem(fr, parsed) {
  const key = canonicalKey(parsed.name);
  const idx = fr.items.findIndex(x => x.key === key);
  const obj = { name: parsed.name, key, pct: parsed.pct, meta: {} };
  if (idx >= 0) fr.items[idx] = obj;
  else fr.items.push(obj);
  fr.items = fr.items.slice(0, 150);
}
function removeItem(fr, name) {
  const key = canonicalKey(name);
  fr.items = fr.items.filter(x => x.key !== key);
}
function totalPct(fr) {
  return fr.items.reduce((a, b) => a + (b.pct || 0), 0);
}
function fmt(x, dp = 2) {
  return Number.isFinite(x) ? x.toFixed(dp) : "-";
}

/* -------------------------- ENDPOINTS -------------------------- */

app.get("/", (req, res) => res.status(200).send(`Feedbot is running ✅\n${VERSION}`));
app.get("/health", (req, res) => res.status(200).json({ ok: true, version: VERSION }));
app.get("/debug", (req, res) => {
  // light debug (safe)
  res.status(200).json({
    ok: true,
    version: VERSION,
    sessions: sessions.size
  });
});

// IMPORTANT: This prevents confusion when you open /whatsapp in browser
app.get("/whatsapp", (req, res) => {
  res
    .status(200)
    .send(
      `NutriPilot WhatsApp webhook is LIVE ✅\n\n` +
      `Twilio must POST to this endpoint:\n` +
      `https://feedbot-whatsapp.onrender.com/whatsapp\n\n` +
      `If you see silence in WhatsApp, check Twilio Sandbox "WHEN A MESSAGE COMES IN" URL + POST method.\n\n` +
      `${VERSION}`
    );
});

/* -------------------------- MAIN WEBHOOK -------------------------- */

app.post("/whatsapp", (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    const from = req.body.From || "unknown";
    const raw = (req.body.Body || "").trim();
    const msg = norm(raw);
    const choice = firstDigit(raw);
    const session = getSession(from);

    // Always log minimal info for Render logs
    console.log(`[WA] from=${from} body="${raw}" step=${session.step}`);

    // Global commands (always respond)
    if (!raw || ["hi", "hello", "start", "menu"].includes(msg)) {
      resetSession(from);
      twiml.message(MAIN_MENU);
      return res.type("text/xml").status(200).send(twiml.toString());
    }
    if (msg === "back") {
      resetSession(from);
      twiml.message(MAIN_MENU);
      return res.type("text/xml").status(200).send(twiml.toString());
    }
    if (msg === "result") {
      twiml.message(session.lastReport || `No report yet.\n\nType MENU.\n\n${VERSION}`);
      return res.type("text/xml").status(200).send(twiml.toString());
    }

    /* ---------------- MAIN MENU ---------------- */
    if (session.step === "MAIN") {
      if (choice === "1") {
        session.step = "CORE1";
        twiml.message(CORE1_MENU);
      } else {
        twiml.message(`Not active yet (MVP).\n\nType MENU.\n\n${VERSION}`);
      }
      return res.type("text/xml").status(200).send(twiml.toString());
    }

    /* ---------------- CORE1 ---------------- */
    if (session.step === "CORE1") {
      if (choice === "1") {
        session.step = "FR_ANIMAL";
        twiml.message(
          `Formula Review (MVP)\n\n` +
          `Step 1: Choose animal:\n` +
          `1) Poultry\n` +
          `2) Swine (next)\n` +
          `3) Dairy (next)\n` +
          `4) Beef cattle (next)\n` +
          `5) Small ruminants (next)\n` +
          `6) Horse (next)\n\n` +
          `Reply 1 for Poultry.\n(Type MENU anytime)`
        );
      } else {
        twiml.message(`Only 1 is active right now.\n\n${CORE1_MENU}`);
      }
      return res.type("text/xml").status(200).send(twiml.toString());
    }

    /* ---------------- Animal ---------------- */
    if (session.step === "FR_ANIMAL") {
      if (choice === "1") {
        session.fr.animal = "poultry";
        session.step = "FR_POULTRY_TYPE";
        twiml.message(
          `Poultry type:\n\n` +
          `1) Broiler\n` +
          `2) Layer\n` +
          `3) Broiler breeder\n` +
          `4) Layer breeder\n\n` +
          `Reply 1–4.`
        );
      } else {
        twiml.message(`Only Poultry is active in this MVP.\nReply 1.`);
      }
      return res.type("text/xml").status(200).send(twiml.toString());
    }

    /* ---------------- Poultry type ---------------- */
    if (session.step === "FR_POULTRY_TYPE") {
      const map = { "1": "broiler", "2": "layer", "3": "broiler breeder", "4": "layer breeder" };
      const pt = map[choice];
      if (!pt) {
        twiml.message(`Reply 1–4.\n\n1) Broiler\n2) Layer\n3) Broiler breeder\n4) Layer breeder`);
        return res.type("text/xml").status(200).send(twiml.toString());
      }
      session.fr.poultryType = pt;

      // Only broiler strain matching in this MVP (targets later)
      if (pt === "broiler") {
        session.step = "FR_STRAIN";
        twiml.message(
          `Broiler genetic line (for target matching):\n\n` +
          `1) Ross\n` +
          `2) Cobb500\n` +
          `3) Hubbard\n` +
          `4) Other (no targets)\n\n` +
          `Reply 1–4.`
        );
      } else {
        session.fr.strain = "other";
        session.step = "FR_STAGE";
        twiml.message(
          `Stage:\n\n1) Starter\n2) Grower\n3) Finisher\n4) Withdrawal\n\nReply 1–4.`
        );
      }
      return res.type("text/xml").status(200).send(twiml.toString());
    }

    /* ---------------- Strain ---------------- */
    if (session.step === "FR_STRAIN") {
      const map = { "1": "ross", "2": "cobb500", "3": "hubbard", "4": "other" };
      const st = map[choice];
      if (!st) {
        twiml.message(`Reply 1–4.\n\n1) Ross\n2) Cobb500\n3) Hubbard\n4) Other`);
        return res.type("text/xml").status(200).send(twiml.toString());
      }
      session.fr.strain = st;
      session.step = "FR_STAGE";
      twiml.message(`Stage:\n\n1) Starter\n2) Grower\n3) Finisher\n4) Withdrawal\n\nReply 1–4.`);
      return res.type("text/xml").status(200).send(twiml.toString());
    }

    /* ---------------- Stage ---------------- */
    if (session.step === "FR_STAGE") {
      const map = { "1": "starter", "2": "grower", "3": "finisher", "4": "withdrawal" };
      const stg = map[choice];
      if (!stg) {
        twiml.message(`Reply 1–4.\n\n1) Starter\n2) Grower\n3) Finisher\n4) Withdrawal`);
        return res.type("text/xml").status(200).send(twiml.toString());
      }
      session.fr.stage = stg;
      session.step = "FR_FORM";
      twiml.message(`Feed form?\n\n1) Mash\n2) Crumble\n3) Pellet\n\nReply 1–3.`);
      return res.type("text/xml").status(200).send(twiml.toString());
    }

    /* ---------------- Feed form ---------------- */
    if (session.step === "FR_FORM") {
      const map = { "1": "mash", "2": "crumble", "3": "pellet" };
      const f = map[choice];
      if (!f) {
        twiml.message(`Reply 1–3.\n\n1) Mash\n2) Crumble\n3) Pellet`);
        return res.type("text/xml").status(200).send(twiml.toString());
      }
      session.fr.feedForm = f;
      session.step = "FR_METHOD";
      twiml.message(FORMULA_REVIEW_METHOD);
      return res.type("text/xml").status(200).send(twiml.toString());
    }

    /* ---------------- Method ---------------- */
    if (session.step === "FR_METHOD") {
      session.fr.items = []; // reset
      if (choice === "1") {
        session.fr.method = "manual";
        session.step = "FR_MANUAL";
        twiml.message(
          `Manual Entry (% only)\n\n` +
          `Send one ingredient per message:\n` +
          `ADD <ingredient> <percent>\n\n` +
          `Examples:\n` +
          `ADD Maize 27.45\n` +
          `ADD SBM44% 25.34\n` +
          `ADD Sunflower meal26-28% 5\n\n` +
          `Commands:\nLIST\nREMOVE <name>\nDONE\nMENU`
        );
      } else if (choice === "2") {
        session.fr.method = "bulk";
        session.step = "FR_BULK";
        twiml.message(
          `Bulk paste (% only)\n\n` +
          `Paste your whole formula in ONE message.\n` +
          `Commas/lines/semicolons are OK.\n\n` +
          `Example:\nMaize27.45, SBM44% 25.34, Fishmeal54%12.26, Salt0.30\n\n` +
          `After paste: paste more or type DONE.\n` +
          `Commands: LIST / REMOVE <name> / DONE / MENU`
        );
      } else {
        twiml.message(FORMULA_REVIEW_METHOD);
      }
      return res.type("text/xml").status(200).send(twiml.toString());
    }

    /* ---------------- Manual mode ---------------- */
    if (session.step === "FR_MANUAL") {
      const fr = session.fr;

      if (msg === "list") {
        const lines = fr.items.map(x => `- ${x.name} = ${fmt(x.pct, 3)}%`).join("\n") || "(empty)";
        twiml.message(`Items: ${fr.items.length} | Total: ${fmt(totalPct(fr), 2)}%\n\n${lines}\n\nDONE when finished.`);
        return res.type("text/xml").status(200).send(twiml.toString());
      }

      if (msg.startsWith("remove ")) {
        const name = raw.slice(7).trim();
        removeItem(fr, name);
        twiml.message(`Removed (if existed): ${name}\nItems: ${fr.items.length} | Total: ${fmt(totalPct(fr), 2)}%\n\nSend next: ADD <name> <pct>`);
        return res.type("text/xml").status(200).send(twiml.toString());
      }

      if (msg === "done") {
        // For now just confirm capture (nutrient calc comes next stage)
        twiml.message(
          `✅ Formula captured.\n` +
          `Items: ${fr.items.length} | Total: ${fmt(totalPct(fr), 2)}%\n\n` +
          `Next stage: nutrient estimation + target comparison.\n\n` +
          `Type MENU.`
        );
        session.lastReport = `Items: ${fr.items.length} | Total: ${fmt(totalPct(fr), 2)}%`;
        session.step = "MAIN";
        return res.type("text/xml").status(200).send(twiml.toString());
      }

      const parsed = parseAddLine(raw);
      if (!parsed) {
        twiml.message(
          `I couldn’t read that.\n\n` +
          `Send: ADD <ingredient> <percent>\nExample: ADD Bajra 4\n\n` +
          `Commands: LIST / REMOVE <name> / DONE / MENU`
        );
        return res.type("text/xml").status(200).send(twiml.toString());
      }

      addItem(fr, parsed);
      twiml.message(
        `✅ Added: ${parsed.name} = ${fmt(parsed.pct, 3)}%\n` +
        `Items: ${fr.items.length} | Total: ${fmt(totalPct(fr), 2)}%\n\n` +
        `Send next: ADD <name> <pct>\nOr LIST / REMOVE <name> / DONE`
      );
      return res.type("text/xml").status(200).send(twiml.toString());
    }

    /* ---------------- Bulk mode ---------------- */
    if (session.step === "FR_BULK") {
      const fr = session.fr;

      if (msg === "list") {
        const lines = fr.items.map(x => `- ${x.name} = ${fmt(x.pct, 3)}%`).join("\n") || "(empty)";
        twiml.message(`Items: ${fr.items.length} | Total: ${fmt(totalPct(fr), 2)}%\n\n${lines}\n\nPaste more or DONE.`);
        return res.type("text/xml").status(200).send(twiml.toString());
      }

      if (msg.startsWith("remove ")) {
        const name = raw.slice(7).trim();
        removeItem(fr, name);
        twiml.message(`Removed (if existed): ${name}\nItems: ${fr.items.length} | Total: ${fmt(totalPct(fr), 2)}%\n\nPaste more or DONE.`);
        return res.type("text/xml").status(200).send(twiml.toString());
      }

      if (msg === "done") {
        twiml.message(
          `✅ Formula captured.\n` +
          `Items: ${fr.items.length} | Total: ${fmt(totalPct(fr), 2)}%\n\n` +
          `Next stage: nutrient estimation + target comparison.\n\n` +
          `Type MENU.`
        );
        session.lastReport = `Items: ${fr.items.length} | Total: ${fmt(totalPct(fr), 2)}%`;
        session.step = "MAIN";
        return res.type("text/xml").status(200).send(twiml.toString());
      }

      const { items, unreadable } = parseBulkPaste(raw);
      for (const it of items) addItem(fr, it);

      twiml.message(
        `Bulk paste processed.\n` +
        `Added: ${items.length} | Unreadable: ${unreadable.length}\n` +
        `Items: ${fr.items.length} | Total: ${fmt(totalPct(fr), 2)}%\n\n` +
        `Paste more, or type DONE.\n` +
        `Commands: LIST / REMOVE <name> / DONE / MENU`
      );
      return res.type("text/xml").status(200).send(twiml.toString());
    }

    // Default fallback so it NEVER goes silent
    twiml.message(`Type MENU.\n\n${VERSION}`);
    return res.type("text/xml").status(200).send(twiml.toString());
  } catch (err) {
    console.error("Webhook error:", err);
    // Even on error: return TwiML so Twilio doesn't fail silently
    twiml.message("⚠️ NutriPilot error. Type MENU and try again.");
    return res.type("text/xml").status(200).send(twiml.toString());
  }
});

/* -------------------------- START -------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NutriPilot running on port ${PORT} — ${VERSION}`));
