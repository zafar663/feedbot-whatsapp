/**
 * NutriPilot AI – FULL index.js (single-file replacement)
 * - Replies on BOTH endpoints: "/" and "/whatsapp" (prevents sandbox path issues)
 * - Numeric-only UX (1/2/3…) for all menus
 * - All animals included (Poultry/Swine/Dairy/Beef/Small Ruminants/Equine/Other)
 * - Poultry requires: Type → Genetic line → Stage (includes Withdrawal; no “whole life”)
 * - Formula intake:
 *    1) Paste full formula (VERY flexible, supports: Maize27.45, SBM44% 25.34, DLM99%o.122, etc.)
 *    2) Manual entry (A guided + B bulk paste)
 * - "MENU" always returns to main
 */

try { require("dotenv").config(); } catch (e) {}

const express = require("express");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

/* =========================
   VERSION
========================= */
const VERSION = "NutriPilot AI router v7 ✅ (All animals + Poultry type/strain/stage + Flexible intake + / & /whatsapp)";

/* =========================
   SESSION STORE (MVP)
========================= */
const sessions = new Map();

function resetSession(from) {
  sessions.set(from, { state: "MAIN", data: {}, lastReport: null });
}

function getSession(from) {
  if (!sessions.has(from)) resetSession(from);
  return sessions.get(from);
}

function firstDigit(text) {
  const m = (text || "").trim().match(/^([1-9])/);
  return m ? m[1] : null;
}

function safeNum(x) {
  const n = Number(String(x ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/* =========================
   FLEXIBLE FORMULA PARSER
   Accepts:
   - "Maize27.45, SBM44% 25.34, Rice broken15, Fishmeal54%12.26, ..."
   - commas/semicolons/newlines
   - typo "o.122" -> "0.122"
========================= */
function parseFlexibleFormula(text) {
  if (!text) return [];

  let clean = text
    .replace(/o\./gi, "0.")
    .replace(/\r/g, "\n");

  const chunks = clean
    .split(/[,;\n]+/)
    .map(c => c.trim())
    .filter(Boolean);

  const items = [];

  for (const chunk of chunks) {
    const nums = chunk.match(/-?\d+(\.\d+)?/g);
    if (!nums) continue;

    const last = nums[nums.length - 1];
    const inclusion = Number(last);
    if (!Number.isFinite(inclusion)) continue;

    const idx = chunk.lastIndexOf(last);
    let name = chunk.substring(0, idx).trim();

    name = name
      .replace(/[%:]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!name) name = "Custom ingredient";

    items.push({ name, inclusion });
  }

  return items.slice(0, 120);
}

/* =========================
   MANUAL BULK PARSER
   Accepts lines like:
   Corn | 58
   SBM44% , 25.34
========================= */
function parseBulkManual(text) {
  if (!text) return [];
  const lines = String(text).split(/\n+/).map(l => l.trim()).filter(Boolean);
  const items = [];

  for (const line of lines) {
    let parts = null;
    if (line.includes("|")) parts = line.split("|").map(s => s.trim());
    else if (line.includes(",")) parts = line.split(",").map(s => s.trim());
    if (!parts || parts.length < 2) continue;

    const name = parts[0];
    const inc = safeNum(parts[1]);
    if (!name || inc === null) continue;

    items.push({ name, inclusion: inc });
  }

  return items.slice(0, 120);
}

function listItems(items) {
  if (!items || !items.length) return "No ingredients added yet.";
  const lines = items.slice(0, 25).map((x, i) => `${i + 1}. ${x.name} = ${x.inclusion}%`);
  const extra = items.length > 25 ? `\n...and ${items.length - 25} more` : "";
  return `Current formula:\n${lines.join("\n")}${extra}`;
}

function removeItem(items, nameToRemove) {
  const key = (nameToRemove || "").trim().toLowerCase();
  if (!key) return { items, removed: false };
  const before = items.length;
  const filtered = items.filter(x => String(x.name).trim().toLowerCase() !== key);
  return { items: filtered, removed: filtered.length !== before };
}

/* =========================
   SIMPLE ANALYSIS (MVP)
========================= */
function analyzeFormula(ctx, items) {
  const total = items.reduce((s, x) => s + (safeNum(x.inclusion) || 0), 0);

  const lower = items.map(i => String(i.name).toLowerCase());
  const hasSalt = lower.some(n => n.includes("salt") || n.includes("nacl"));
  const hasPremix = lower.some(n => n.includes("premix") || (n.includes("vit") && n.includes("pre")) || (n.includes("min") && n.includes("pre")));
  const hasLime = lower.some(n => n.includes("lime") || n.includes("limestone") || n.includes("caco3") || n.includes("calcium carbonate"));

  const flags = [];
  if (total < 95 || total > 105) flags.push(`Total inclusion: ${total.toFixed(2)}% (expected ~100%)`);
  if (!hasPremix) flags.push("Premix not detected (vit/min premix may be missing)");
  if (!hasSalt) flags.push("Salt not detected (Na/Cl source may be missing)");
  if (ctx.animal === "Poultry" && ctx.poultryType === "Layer" && !hasLime) flags.push("No limestone/Ca source detected (critical for layers)");

  const top = items.slice(0, 18).map(i => `- ${i.name}: ${i.inclusion}%`).join("\n");

  return (
    `✅ Formula captured (MVP)\n\n` +
    `Animal: ${ctx.animal}\n` +
    (ctx.poultryType ? `Poultry type: ${ctx.poultryType}\n` : "") +
    (ctx.geneticLine ? `Genetic line: ${ctx.geneticLine}\n` : "") +
    (ctx.stage ? `Stage: ${ctx.stage}\n` : "") +
    (ctx.feedForm ? `Feed form: ${ctx.feedForm}\n` : "") +
    `Items: ${items.length}\n` +
    `Total: ${total.toFixed(2)}%\n\n` +
    `Ingredients:\n${top}\n\n` +
    (flags.length ? `⚠️ Flags:\n- ${flags.join("\n- ")}\n\n` : `✅ No major flags detected (MVP checks).\n\n`) +
    `Note: Ingredient names accepted as entered.\n` +
    `Type MENU to start again.\n\n` +
    `${VERSION}`
  );
}

/* =========================
   MENUS
========================= */
const MAIN_MENU =
`NutriPilot AI

How can we help you today?

1) Formulation & Diet Control
2) Performance & Production Intelligence
3) Raw Materials, Feed Mill & Quality
4) Expert Review
5) Nutrition Partner Program

Type MENU anytime.`;

const CORE1_MENU =
`Formulation & Diet Control

1) Build a new formula (MVP)

Reply 1, or MENU.`;

const ANIMAL_MENU =
`Select animal category:

1) Poultry
2) Swine
3) Dairy Cattle
4) Beef Cattle
5) Small Ruminants (Sheep/Goats)
6) Equine (Horses)
7) Other / Custom

Reply 1–7.`;

const POULTRY_TYPE_MENU =
`Select poultry type:

1) Broiler
2) Layer
3) Breeder (Parent Stock)

Reply 1–3.`;

const GENETIC_LINE_MENU =
`Select genetic line (required):

1) Ross
2) Cobb
3) Hubbard
4) Arbor Acres
5) Hy-Line
6) Lohmann
7) Other / Custom

Reply 1–7.`;

const FEED_FORM_MENU =
`Feed form:

1) Mash
2) Pellet
3) Crumble
4) TMR (ruminants)
5) Other

Reply 1–5.`;

const FORMULA_INPUT_MENU =
`Provide your formula:

1) Paste full formula (any format)
2) Manual entry (guided / bulk)
3) Upload Excel/CSV (later)
4) Upload photo (later)

Reply 1–4.`;

const MANUAL_HOME_MSG =
`Manual Entry (% only)

Choose one:
A) Type ADD to enter items one-by-one
B) Paste multiple lines like:
Corn | 58
SBM44% | 25.34
Fishmeal54% | 12.26

Commands: ADD, LIST, REMOVE <name>, DONE, MENU`;

/* =========================
   HEALTH CHECK
========================= */
app.get("/", (req, res) => {
  res.status(200).send(VERSION);
});

/* =========================
   WEBHOOK (IMPORTANT)
   Accept BOTH "/" and "/whatsapp"
========================= */
app.post(["/", "/whatsapp"], (req, res) => {
  const from = req.body.From || "unknown";
  const raw = (req.body.Body || "").trim();
  const msg = raw.toLowerCase();
  const choice = firstDigit(raw);

  const twiml = new twilio.twiml.MessagingResponse();
  const session = getSession(from);

  // Global commands
  if (!raw || ["hi", "hello", "start", "menu"].includes(msg)) {
    resetSession(from);
    twiml.message(MAIN_MENU);
    return res.type("text/xml").send(twiml.toString());
  }
  if (msg === "back") {
    resetSession(from);
    twiml.message(MAIN_MENU);
    return res.type("text/xml").send(twiml.toString());
  }
  if (msg === "result") {
    twiml.message(session.lastReport || `No report yet. Type MENU.\n\n${VERSION}`);
    return res.type("text/xml").send(twiml.toString());
  }

  /* ===== MAIN ===== */
  if (session.state === "MAIN") {
    if (choice === "1") {
      session.state = "CORE1_MENU";
      session.data = {};
      twiml.message(CORE1_MENU);
    } else if (["2","3","4","5"].includes(choice)) {
      twiml.message(`This core is coming next.\nType MENU.\n\n${VERSION}`);
    } else {
      twiml.message(`${MAIN_MENU}\n\n${VERSION}`);
    }
    return res.type("text/xml").send(twiml.toString());
  }

  /* ===== CORE1 ===== */
  if (session.state === "CORE1_MENU") {
    if (choice === "1") {
      session.state = "ANIMAL";
      session.data = {};
      twiml.message(ANIMAL_MENU);
    } else {
      twiml.message(CORE1_MENU);
    }
    return res.type("text/xml").send(twiml.toString());
  }

  /* ===== ANIMAL ===== */
  if (session.state === "ANIMAL") {
    const map = {
      "1": "Poultry",
      "2": "Swine",
      "3": "Dairy Cattle",
      "4": "Beef Cattle",
      "5": "Small Ruminants",
      "6": "Equine",
      "7": "Other"
    };
    if (!map[choice]) {
      twiml.message(`${ANIMAL_MENU}\n\n${VERSION}`);
      return res.type("text/xml").send(twiml.toString());
    }

    session.data.animal = map[choice];

    if (session.data.animal === "Poultry") {
      session.state = "POULTRY_TYPE";
      twiml.message(POULTRY_TYPE_MENU);
      return res.type("text/xml").send(twiml.toString());
    }

    // Non-poultry stage menus
    if (session.data.animal === "Swine") {
      session.state = "NONPOULTRY_STAGE";
      twiml.message(
        `Select swine stage:\n\n` +
        `1) Nursery\n2) Grower\n3) Finisher\n4) Gilt / Gestation\n5) Lactation\n\nReply 1–5.`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    if (session.data.animal === "Dairy Cattle") {
      session.state = "NONPOULTRY_STAGE";
      twiml.message(
        `Select dairy stage:\n\n` +
        `1) Calf\n2) Heifer\n3) Dry cow\n4) Fresh cow\n5) Lactating cow\n\nReply 1–5.`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    if (session.data.animal === "Beef Cattle") {
      session.state = "NONPOULTRY_STAGE";
      twiml.message(
        `Select beef stage:\n\n` +
        `1) Backgrounding\n2) Growing\n3) Finishing\n4) Cow–calf\n\nReply 1–4.`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    if (session.data.animal === "Small Ruminants") {
      session.state = "SMALLRUM_SPECIES";
      twiml.message(`Select small ruminant:\n\n1) Sheep\n2) Goat\n\nReply 1–2.`);
      return res.type("text/xml").send(twiml.toString());
    }

    if (session.data.animal === "Equine") {
      session.state = "NONPOULTRY_STAGE";
      twiml.message(
        `Select horse category:\n\n` +
        `1) Maintenance\n2) Performance\n3) Breeding\n4) Growth\n\nReply 1–4.`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    // Other / custom
    session.state = "NONPOULTRY_STAGE";
    twiml.message(
      `Select custom group:\n\n1) Monogastric\n2) Ruminant\n3) Aquatic\n4) Other\n\nReply 1–4.`
    );
    return res.type("text/xml").send(twiml.toString());
  }

  /* ===== POULTRY TYPE ===== */
  if (session.state === "POULTRY_TYPE") {
    const map = { "1": "Broiler", "2": "Layer", "3": "Breeder" };
    if (!map[choice]) {
      twiml.message(`${POULTRY_TYPE_MENU}\n\n${VERSION}`);
      return res.type("text/xml").send(twiml.toString());
    }
    session.data.poultryType = map[choice];
    session.state = "GENETIC_LINE";
    twiml.message(GENETIC_LINE_MENU);
    return res.type("text/xml").send(twiml.toString());
  }

  /* ===== GENETIC LINE ===== */
  if (session.state === "GENETIC_LINE") {
    const map = {
      "1": "Ross", "2": "Cobb", "3": "Hubbard", "4": "Arbor Acres",
      "5": "Hy-Line", "6": "Lohmann", "7": "Other / Custom"
    };
    if (!map[choice]) {
      twiml.message(`${GENETIC_LINE_MENU}\n\n${VERSION}`);
      return res.type("text/xml").send(twiml.toString());
    }
    session.data.geneticLine = map[choice];

    session.state = "POULTRY_STAGE";
    if (session.data.poultryType === "Broiler") {
      twiml.message(`Select broiler stage:\n\n1) Starter\n2) Grower\n3) Finisher\n4) Withdrawal\n\nReply 1–4.`);
    } else if (session.data.poultryType === "Layer") {
      twiml.message(`Select layer stage:\n\n1) Chick\n2) Grower/Developer\n3) Pre-lay\n4) Peak lay\n5) Post-peak/Late lay\n\nReply 1–5.`);
    } else {
      twiml.message(`Select breeder stage:\n\n1) Rearing\n2) Pre-breeder\n3) Production\n\nReply 1–3.`);
    }
    return res.type("text/xml").send(twiml.toString());
  }

  /* ===== POULTRY STAGE ===== */
  if (session.state === "POULTRY_STAGE") {
    const broiler = ["Starter", "Grower", "Finisher", "Withdrawal"];
    const layer = ["Chick", "Grower/Developer", "Pre-lay", "Peak lay", "Post-peak/Late lay"];
    const breeder = ["Rearing", "Pre-breeder", "Production"];

    let stage = null;
    if (session.data.poultryType === "Broiler") stage = broiler[Number(choice) - 1];
    else if (session.data.poultryType === "Layer") stage = layer[Number(choice) - 1];
    else stage = breeder[Number(choice) - 1];

    if (!stage) {
      twiml.message(`Invalid selection. Reply again.\n\n${VERSION}`);
      return res.type("text/xml").send(twiml.toString());
    }

    session.data.stage = stage;
    session.state = "FEED_FORM";
    twiml.message(FEED_FORM_MENU);
    return res.type("text/xml").send(twiml.toString());
  }

  /* ===== SMALL RUMINANTS ===== */
  if (session.state === "SMALLRUM_SPECIES") {
    const map = { "1": "Sheep", "2": "Goat" };
    if (!map[choice]) {
      twiml.message(`Select small ruminant:\n\n1) Sheep\n2) Goat\n\nReply 1–2.\n\n${VERSION}`);
      return res.type("text/xml").send(twiml.toString());
    }
    session.data._smallRum = map[choice];
    session.state = "SMALLRUM_STAGE";
    twiml.message(`Select production stage:\n\n1) Growing\n2) Breeding\n3) Lactation\n4) Finishing\n\nReply 1–4.`);
    return res.type("text/xml").send(twiml.toString());
  }

  if (session.state === "SMALLRUM_STAGE") {
    const map = { "1": "Growing", "2": "Breeding", "3": "Lactation", "4": "Finishing" };
    if (!map[choice]) {
      twiml.message(`Reply 1–4.\n\n${VERSION}`);
      return res.type("text/xml").send(twiml.toString());
    }
    session.data.stage = `${session.data._smallRum} - ${map[choice]}`;
    delete session.data._smallRum;
    session.state = "FEED_FORM";
    twiml.message(FEED_FORM_MENU);
    return res.type("text/xml").send(twiml.toString());
  }

  /* ===== NON-POULTRY STAGE ===== */
  if (session.state === "NONPOULTRY_STAGE") {
    let stage = null;

    if (session.data.animal === "Swine") {
      const map = { "1": "Nursery", "2": "Grower", "3": "Finisher", "4": "Gilt / Gestation", "5": "Lactation" };
      stage = map[choice];
    } else if (session.data.animal === "Dairy Cattle") {
      const map = { "1": "Calf", "2": "Heifer", "3": "Dry cow", "4": "Fresh cow", "5": "Lactating cow" };
      stage = map[choice];
    } else if (session.data.animal === "Beef Cattle") {
      const map = { "1": "Backgrounding", "2": "Growing", "3": "Finishing", "4": "Cow–calf" };
      stage = map[choice];
    } else if (session.data.animal === "Equine") {
      const map = { "1": "Maintenance", "2": "Performance", "3": "Breeding", "4": "Growth" };
      stage = map[choice];
    } else {
      const map = { "1": "Monogastric", "2": "Ruminant", "3": "Aquatic", "4": "Other" };
      stage = map[choice];
    }

    if (!stage) {
      twiml.message(`Invalid selection. Type MENU.\n\n${VERSION}`);
      return res.type("text/xml").send(twiml.toString());
    }

    session.data.stage = stage;
    session.state = "FEED_FORM";
    twiml.message(FEED_FORM_MENU);
    return res.type("text/xml").send(twiml.toString());
  }

  /* ===== FEED FORM ===== */
  if (session.state === "FEED_FORM") {
    const map = { "1": "Mash", "2": "Pellet", "3": "Crumble", "4": "TMR", "5": "Other" };
    if (!map[choice]) {
      twiml.message(`${FEED_FORM_MENU}\n\n${VERSION}`);
      return res.type("text/xml").send(twiml.toString());
    }
    session.data.feedForm = map[choice];
    session.state = "FORMULA_INPUT_METHOD";
    twiml.message(FORMULA_INPUT_MENU);
    return res.type("text/xml").send(twiml.toString());
  }

  /* ===== FORMULA INPUT METHOD ===== */
  if (session.state === "FORMULA_INPUT_METHOD") {
    if (choice === "1") {
      session.state = "PASTE_FORMULA";
      twiml.message(
        `Paste your full formula now (any format accepted).\n\n` +
        `Example:\nMaize27.45, SBM44% 25.34, Rice broken15, Fishmeal54%12.26, Salt0.099, Vitamin Premix 0.05\n\n${VERSION}`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    if (choice === "2") {
      session.state = "MANUAL_HOME";
      session.data.manualItems = [];
      twiml.message(`${MANUAL_HOME_MSG}\n\n${VERSION}`);
      return res.type("text/xml").send(twiml.toString());
    }

    if (choice === "3") {
      twiml.message(`Upload Excel/CSV will be added later.\nUse: 1) Paste OR 2) Manual.\n\n${VERSION}`);
      return res.type("text/xml").send(twiml.toString());
    }

    if (choice === "4") {
      twiml.message(`Photo upload will be added later.\nUse: 1) Paste OR 2) Manual.\n\n${VERSION}`);
      return res.type("text/xml").send(twiml.toString());
    }

    twiml.message(`${FORMULA_INPUT_MENU}\n\n${VERSION}`);
    return res.type("text/xml").send(twiml.toString());
  }

  /* ===== PASTE FORMULA ===== */
  if (session.state === "PASTE_FORMULA") {
    const items = parseFlexibleFormula(raw);

    if (items.length < 2) {
      twiml.message(`I couldn't extract enough ingredients. Paste again.\n\n${VERSION}`);
      return res.type("text/xml").send(twiml.toString());
    }

    const report = analyzeFormula(session.data, items);
    session.lastReport = report;
    resetSession(from);
    twiml.message(report);
    return res.type("text/xml").send(twiml.toString());
  }

  /* ===== MANUAL HOME ===== */
  if (session.state === "MANUAL_HOME") {
    // Bulk paste path
    const bulk = parseBulkManual(raw);
    if (bulk.length >= 2) {
      session.data.manualItems = [...(session.data.manualItems || []), ...bulk].slice(0, 120);
      twiml.message(`✅ Added ${bulk.length} items.\n\n${listItems(session.data.manualItems)}\n\nType DONE to analyze or ADD to continue.\n\n${VERSION}`);
      return res.type("text/xml").send(twiml.toString());
    }

    if (msg === "add") {
      session.state = "MANUAL_ADD_NAME";
      twiml.message(`Send ingredient name (example: Maize, SBM44%, Fishmeal54%).\n\n${VERSION}`);
      return res.type("text/xml").send(twiml.toString());
    }

    if (msg === "list") {
      twiml.message(`${listItems(session.data.manualItems)}\n\n${VERSION}`);
      return res.type("text/xml").send(twiml.toString());
    }

    if (msg.startsWith("remove")) {
      const nameToRemove = raw.replace(/^remove/i, "").trim();
      const out = removeItem(session.data.manualItems || [], nameToRemove);
      session.data.manualItems = out.items;
      twiml.message(
        out.removed
          ? `✅ Removed: ${nameToRemove}\n\n${listItems(session.data.manualItems)}\n\n${VERSION}`
          : `Couldn't find: ${nameToRemove}\n\n${listItems(session.data.manualItems)}\n\n${VERSION}`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    if (msg === "done") {
      const items = session.data.manualItems || [];
      if (items.length < 2) {
        twiml.message(`Please add at least 2 ingredients first.\nType ADD or paste bulk lines.\n\n${VERSION}`);
        return res.type("text/xml").send(twiml.toString());
      }

      const report = analyzeFormula(session.data, items);
      session.lastReport = report;
      resetSession(from);
      twiml.message(report);
      return res.type("text/xml").send(twiml.toString());
    }

    twiml.message(`${MANUAL_HOME_MSG}\n\n${VERSION}`);
    return res.type("text/xml").send(twiml.toString());
  }

  /* ===== MANUAL ADD NAME ===== */
  if (session.state === "MANUAL_ADD_NAME") {
    session.data.pendingName = raw;
    session.state = "MANUAL_ADD_INCLUSION";
    twiml.message(`Inclusion % for "${session.data.pendingName}"? (example: 27.45)\n\n${VERSION}`);
    return res.type("text/xml").send(twiml.toString());
  }

  /* ===== MANUAL ADD INCLUSION ===== */
  if (session.state === "MANUAL_ADD_INCLUSION") {
    const inc = safeNum(raw);
    if (inc === null) {
      twiml.message(`Please send a number (example: 27.45 or 0.05)\n\n${VERSION}`);
      return res.type("text/xml").send(twiml.toString());
    }

    session.data.manualItems = session.data.manualItems || [];
    session.data.manualItems.push({ name: session.data.pendingName, inclusion: inc });
    delete session.data.pendingName;

    session.state = "MANUAL_HOME";
    twiml.message(`✅ Added.\n\n${listItems(session.data.manualItems)}\n\nType ADD or DONE.\n\n${VERSION}`);
    return res.type("text/xml").send(twiml.toString());
  }

  /* ===== FALLBACK ===== */
  twiml.message(`Type MENU to restart.\n\n${VERSION}`);
  return res.type("text/xml").send(twiml.toString());
});

/* =========================
   SERVER
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(VERSION));
