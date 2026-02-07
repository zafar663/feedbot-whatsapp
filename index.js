try { require("dotenv").config(); } catch (e) {}

const express = require("express");
const twilio = require("twilio");
const Redis = require("ioredis");

const app = express();
app.use(express.urlencoded({ extended: false }));

const VERSION = "NutriPilot AI vFinal+BulkPaste ✅ (All animals + Poultry split + Separate genetic lines + Full egg-layer stages + Redis sessions + Bulk Paste)";

// -------------------- Redis (prevents sleep/mix) --------------------
const REDIS_URL = process.env.REDIS_URL || "";
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 86400);

let redis = null;
if (REDIS_URL) {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
  redis.on("error", () => {});
}

// Fallback (only if Redis not set)
const mem = new Map();

async function getSession(from) {
  const key = `sess:${from}`;
  if (redis) {
    const raw = await redis.get(key);
    if (raw) return JSON.parse(raw);
    const s = makeFreshSession();
    await redis.set(key, JSON.stringify(s), "EX", SESSION_TTL_SECONDS);
    return s;
  }
  if (!mem.has(key)) mem.set(key, makeFreshSession());
  return mem.get(key);
}

async function saveSession(from, s) {
  const key = `sess:${from}`;
  if (redis) {
    await redis.set(key, JSON.stringify(s), "EX", SESSION_TTL_SECONDS);
  } else {
    mem.set(key, s);
  }
}

async function resetSession(from) {
  const s = makeFreshSession();
  await saveSession(from, s);
  return s;
}

function makeFreshSession() {
  return {
    state: "MAIN",
    ctx: {},      // animal/poultry/genetics/stage/feedform
    formula: [],  // [{name, pct}]
  };
}

// -------------------- Helpers --------------------
function normUpper(x) { return String(x || "").trim().toUpperCase(); }
function normLower(x) { return String(x || "").trim().toLowerCase(); }

function firstDigit(x) {
  const m = String(x || "").trim().match(/^([1-9])$/);
  return m ? m[1] : null;
}

function safeNum(x) {
  const s = String(x || "")
    .replace(/o\./gi, "0.")         // common typo: o.122 -> 0.122
    .replace(/[^\d.\-]/g, "");      // strip non-numeric (keeps dot and minus)
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function sumPct(items) {
  return items.reduce((s, it) => s + (safeNum(it.pct) || 0), 0);
}

function listFormula(items) {
  if (!items.length) return "No ingredients added yet.";
  const lines = items.slice(0, 25).map((it, i) => `${i + 1}) ${it.name} — ${it.pct}%`);
  const more = items.length > 25 ? `\n...and ${items.length - 25} more` : "";
  return `Current formula:\n${lines.join("\n")}${more}`;
}

function removeByName(items, name) {
  const key = normLower(name);
  const before = items.length;
  const after = items.filter(it => normLower(it.name) !== key);
  return { after, removed: after.length !== before };
}

// Strict line: "ADD Maize 27.45" OR "Maize 27.45"
function parseAddLine(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const withoutAdd = raw.replace(/^ADD\s+/i, "");
  const m = withoutAdd.match(/^(.*?)(-?\d+(?:\.\d+)?)\s*%?\s*$/);
  if (!m) return null;

  const name = m[1].trim().replace(/[,;]+$/g, "").trim();
  const pct = safeNum(m[2]);

  if (!name || pct === null) return null;
  return { name, pct };
}

// Flexible token for bulk paste: accepts "Maize27.45," "SBM44% 25.34" "Millet/Bajra 4,"
function parseTokenFlexible(token) {
  const t = String(token || "").trim().replace(/^[\-\u2022•\*]+\s*/g, ""); // remove bullet starts
  if (!t) return null;

  // remove trailing punctuation
  const cleaned = t.replace(/[,;]+$/g, "").trim();

  // try to capture last number at end (space or no-space)
  const m = cleaned.match(/^(.*?)(-?\d+(?:\.\d+)?)\s*%?\s*$/);
  if (!m) return null;

  const name = m[1].trim().replace(/[:\-]+$/g, "").trim();
  const pct = safeNum(m[2]);
  if (!name || pct === null) return null;

  return { name, pct };
}

function splitBulkText(text) {
  // split by newline, semicolon, comma
  return String(text || "")
    .split(/[\n;\r]+|,(?!\d)/g) // comma split but avoids some numeric formats; still OK for our use
    .map(s => s.trim())
    .filter(Boolean);
}

// -------------------- Menus --------------------
const MAIN_MENU =
`NutriPilot AI

How can we help you today?

1) Formulation & Diet Control
2) Performance & Production Intelligence
3) Raw Materials, Feed Mill & Quality
4) Expert Review
5) Nutrition Partner Program

Reply with a number or type MENU.`;

const CORE1_MENU =
`Formulation & Diet Control

1) Formula review (MVP)
2) Reformulation (next)
3) Diet approval / risk check (next)
4) Additives & enzymes guidance (next)

Reply 1 for now, or type MENU.`;

const ANIMAL_MENU =
`Formula Review – Context

Select animal category:
1) Poultry
2) Swine
3) Dairy Cattle
4) Beef Cattle
5) Small Ruminants (Sheep/Goat)
6) Equine (Horse)
7) Other / Custom

Reply 1–7.`;

const POULTRY_CATEGORY_MENU =
`Select poultry category:
1) Broiler
2) Layer
3) Broiler Breeder
4) Layer Breeder

Reply 1–4.`;

const GENETIC_BROILER_MENU =
`Select genetic line:
1) Ross
2) Cobb
3) Hubbard
4) Arbor Acres
5) Other

Reply 1–5.`;

const GENETIC_LAYER_MENU =
`Select genetic line:
1) Hy-Line
2) Lohmann
3) ISA
4) Bovans
5) Other

Reply 1–5.`;

const EGG_LAYER_STAGE_MENU =
`Select life stage (egg-laying birds):

1) Pre-Starter (0–2 wk)
2) Starter (2–6 wk)
3) Grower (6–12 wk)
4) Developer (12–16 wk)
5) Pre-Lay (16–18 wk)
6) Early Lay / Onset (18–25 wk)
7) Peak Production (25–40 wk)
8) Mid-Lay (40–55 wk)
9) Late Lay (55+ wk)

Reply 1–9.`;

const BROILER_STAGE_MENU =
`Select stage (broiler meat birds):
1) Starter
2) Grower
3) Finisher
4) Withdrawal

Reply 1–4.`;

const FEED_FORM_MENU =
`Feed form:
1) Mash
2) Pellet
3) Crumble
4) Other

Reply 1–4.`;

const INPUT_METHOD_MENU =
`Formula Review – Submit your diet

Choose input method:

1) Guided manual entry (% only)
2) Bulk paste (% only)
3) Upload Excel/CSV (next)
4) Upload photo/PDF (next)

Reply 1 or 2 for now, or type MENU.`;

function nonPoultryStageMenu(animal) {
  switch (animal) {
    case "Swine":
      return `Select stage (Swine):
1) Nursery
2) Grower
3) Finisher
4) Gestation
5) Lactation
Reply 1–5.`;
    case "Dairy Cattle":
      return `Select stage (Dairy):
1) Calf
2) Heifer
3) Dry cow
4) Fresh cow
5) Lactating cow
Reply 1–5.`;
    case "Beef Cattle":
      return `Select stage (Beef):
1) Backgrounding
2) Growing
3) Finishing
4) Cow–calf
Reply 1–4.`;
    case "Small Ruminants":
      return `Select stage (Sheep/Goat):
1) Growing
2) Breeding
3) Lactation
4) Finishing
Reply 1–4.`;
    case "Equine":
      return `Select stage (Horse):
1) Maintenance
2) Performance
3) Breeding
4) Growth
Reply 1–4.`;
    default:
      return `Select group (Custom):
1) Monogastric
2) Ruminant
3) Aquatic
4) Other
Reply 1–4.`;
  }
}

function stageLabelEgg(n) {
  const map = {
    "1":"Pre-Starter (0–2 wk)",
    "2":"Starter (2–6 wk)",
    "3":"Grower (6–12 wk)",
    "4":"Developer (12–16 wk)",
    "5":"Pre-Lay (16–18 wk)",
    "6":"Early Lay / Onset (18–25 wk)",
    "7":"Peak Production (25–40 wk)",
    "8":"Mid-Lay (40–55 wk)",
    "9":"Late Lay (55+ wk)"
  };
  return map[n] || null;
}
function stageLabelBroiler(n) {
  const map = {"1":"Starter","2":"Grower","3":"Finisher","4":"Withdrawal"};
  return map[n] || null;
}
function feedFormLabel(n) {
  const map = {"1":"Mash","2":"Pellet","3":"Crumble","4":"Other"};
  return map[n] || null;
}

// -------------------- Manual/Bulk Help --------------------
function contextBlock(ctx) {
  return [
    `Animal: ${ctx.animal || "-"}`,
    ctx.poultryCategory ? `Poultry: ${ctx.poultryCategory}` : null,
    ctx.geneticLine ? `Genetic line: ${ctx.geneticLine}` : null,
    ctx.stage ? `Stage: ${ctx.stage}` : null,
    ctx.feedForm ? `Feed form: ${ctx.feedForm}` : null,
  ].filter(Boolean).join("\n");
}

function manualEntryHelp(ctx) {
  return (
`Manual Entry (% only)

${contextBlock(ctx)}

Send each ingredient in ONE message:
ADD <ingredient name> <percent>

Examples:
ADD Maize 27.45
ADD SBM44% 25.34
ADD Salt 0.30

Commands:
LIST
REMOVE <ingredient name>
DONE
MENU`
  );
}

function bulkPasteHelp(ctx) {
  return (
`Bulk Paste (% only)

${contextBlock(ctx)}

Paste your formula in any format (comma/newline/semicolon).

Examples:
Maize27.45, SBM44% 25.34
Rice broken 15
Fishmeal54%12.26
Salt 0.30

Commands:
LIST
REMOVE <ingredient name>
DONE
MENU`
  );
}

// -------------------- Final “Review” (MVP) --------------------
function buildMvpReport(ctx, formula) {
  const total = sumPct(formula);
  const names = formula.map(x => normLower(x.name));
  const hasSalt = names.some(n => n.includes("salt") || n.includes("nacl"));
  const hasPremix = names.some(n => n.includes("premix"));

  const flags = [];
  if (total < 99 || total > 101) flags.push(`Total inclusion = ${total.toFixed(2)}% (target ~100%)`);
  if (!hasSalt) flags.push("Salt not detected (check Na/Cl source).");
  if (!hasPremix) flags.push("Premix not detected (vit/min premix may be missing).");

  const ctxBlock = contextBlock(ctx);

  const top = formula.slice(0, 20).map(it => `- ${it.name}: ${it.pct}%`).join("\n");

  return (
`✅ Formula Review (MVP)

${ctxBlock}

Ingredients: ${formula.length}
Total: ${total.toFixed(2)}%

Top items:
${top}

${flags.length ? `⚠️ Flags:\n- ${flags.join("\n- ")}` : "✅ No major MVP flags detected."}

Type MENU to start again.

${VERSION}`
  );
}

// -------------------- Health check --------------------
app.get(["/", "/whatsapp"], (req, res) => {
  res.status(200).send(VERSION);
});

// -------------------- Webhook (accept both) --------------------
app.post(["/", "/whatsapp"], async (req, res) => {
  const from = req.body.From || "unknown";
  const raw = req.body.Body || "";
  const msgLower = normLower(raw);
  const msgUpper = normUpper(raw);
  const d = firstDigit(raw);

  const twiml = new twilio.twiml.MessagingResponse();

  // Global: MENU/START/HI resets
  if (!msgLower || ["hi","hello","menu","start"].includes(msgLower)) {
    await resetSession(from);
    twiml.message(MAIN_MENU);
    return res.type("text/xml").send(twiml.toString());
  }

  let s = await getSession(from);

  // MAIN
  if (s.state === "MAIN") {
    if (d === "1") {
      s.state = "CORE1";
      await saveSession(from, s);
      twiml.message(CORE1_MENU);
    } else {
      twiml.message(MAIN_MENU);
    }
    return res.type("text/xml").send(twiml.toString());
  }

  // CORE1
  if (s.state === "CORE1") {
    if (d === "1") {
      s.state = "ANIMAL";
      s.ctx = {};
      s.formula = [];
      await saveSession(from, s);
      twiml.message(ANIMAL_MENU);
    } else {
      twiml.message(CORE1_MENU);
    }
    return res.type("text/xml").send(twiml.toString());
  }

  // ANIMAL
  if (s.state === "ANIMAL") {
    const map = {
      "1":"Poultry",
      "2":"Swine",
      "3":"Dairy Cattle",
      "4":"Beef Cattle",
      "5":"Small Ruminants",
      "6":"Equine",
      "7":"Other"
    };
    const animal = map[d];
    if (!animal) {
      twiml.message(`${ANIMAL_MENU}\n\n${VERSION}`);
      return res.type("text/xml").send(twiml.toString());
    }
    s.ctx.animal = animal;

    if (animal === "Poultry") {
      s.state = "POULTRY_CAT";
      await saveSession(from, s);
      twiml.message(POULTRY_CATEGORY_MENU);
      return res.type("text/xml").send(twiml.toString());
    }

    s.state = "NONPOULTRY_STAGE";
    await saveSession(from, s);
    twiml.message(nonPoultryStageMenu(animal));
    return res.type("text/xml").send(twiml.toString());
  }

  // POULTRY CATEGORY
  if (s.state === "POULTRY_CAT") {
    const map = {
      "1":"Broiler",
      "2":"Layer",
      "3":"Broiler Breeder",
      "4":"Layer Breeder"
    };
    const cat = map[d];
    if (!cat) {
      twiml.message(`${POULTRY_CATEGORY_MENU}\n\n${VERSION}`);
      return res.type("text/xml").send(twiml.toString());
    }
    s.ctx.poultryCategory = cat;

    s.state = "POULTRY_GENETIC";
    await saveSession(from, s);
    if (cat === "Layer" || cat === "Layer Breeder") twiml.message(GENETIC_LAYER_MENU);
    else twiml.message(GENETIC_BROILER_MENU);
    return res.type("text/xml").send(twiml.toString());
  }

  // POULTRY GENETIC
  if (s.state === "POULTRY_GENETIC") {
    const isLayerGroup = (s.ctx.poultryCategory === "Layer" || s.ctx.poultryCategory === "Layer Breeder");

    const mapBroiler = {"1":"Ross","2":"Cobb","3":"Hubbard","4":"Arbor Acres","5":"Other"};
    const mapLayer = {"1":"Hy-Line","2":"Lohmann","3":"ISA","4":"Bovans","5":"Other"};

    const gl = isLayerGroup ? mapLayer[d] : mapBroiler[d];
    if (!gl) {
      twiml.message(`${isLayerGroup ? GENETIC_LAYER_MENU : GENETIC_BROILER_MENU}\n\n${VERSION}`);
      return res.type("text/xml").send(twiml.toString());
    }
    s.ctx.geneticLine = gl;

    s.state = "POULTRY_STAGE";
    await saveSession(from, s);

    if (s.ctx.poultryCategory === "Broiler") twiml.message(BROILER_STAGE_MENU);
    else twiml.message(EGG_LAYER_STAGE_MENU);
    return res.type("text/xml").send(twiml.toString());
  }

  // POULTRY STAGE
  if (s.state === "POULTRY_STAGE") {
    let stage = null;
    if (s.ctx.poultryCategory === "Broiler") stage = stageLabelBroiler(d);
    else stage = stageLabelEgg(d);

    if (!stage) {
      const menu = (s.ctx.poultryCategory === "Broiler") ? BROILER_STAGE_MENU : EGG_LAYER_STAGE_MENU;
      twiml.message(`${menu}\n\n${VERSION}`);
      return res.type("text/xml").send(twiml.toString());
    }
    s.ctx.stage = stage;

    s.state = "FEED_FORM";
    await saveSession(from, s);
    twiml.message(FEED_FORM_MENU);
    return res.type("text/xml").send(twiml.toString());
  }

  // NON-POULTRY STAGE
  if (s.state === "NONPOULTRY_STAGE") {
    const animal = s.ctx.animal;
    const menu = nonPoultryStageMenu(animal);
    const lines = menu.split("\n").filter(Boolean);
    const picked = lines.find(l => l.trim().startsWith(`${d})`));
    if (!picked) {
      twiml.message(`${menu}\n\n${VERSION}`);
      return res.type("text/xml").send(twiml.toString());
    }
    s.ctx.stage = picked.replace(/^\d\)\s*/, "").trim();

    s.state = "FEED_FORM";
    await saveSession(from, s);
    twiml.message(FEED_FORM_MENU);
    return res.type("text/xml").send(twiml.toString());
  }

  // FEED FORM
  if (s.state === "FEED_FORM") {
    const ff = feedFormLabel(d);
    if (!ff) {
      twiml.message(`${FEED_FORM_MENU}\n\n${VERSION}`);
      return res.type("text/xml").send(twiml.toString());
    }
    s.ctx.feedForm = ff;

    s.state = "INPUT_METHOD";
    await saveSession(from, s);
    twiml.message(INPUT_METHOD_MENU);
    return res.type("text/xml").send(twiml.toString());
  }

  // INPUT METHOD
  if (s.state === "INPUT_METHOD") {
    if (d === "1") {
      s.state = "MANUAL_ENTRY";
      s.formula = [];
      await saveSession(from, s);
      twiml.message(manualEntryHelp(s.ctx));
      return res.type("text/xml").send(twiml.toString());
    }
    if (d === "2") {
      s.state = "BULK_PASTE";
      s.formula = [];
      await saveSession(from, s);
      twiml.message(bulkPasteHelp(s.ctx));
      return res.type("text/xml").send(twiml.toString());
    }
    twiml.message(INPUT_METHOD_MENU);
    return res.type("text/xml").send(twiml.toString());
  }

  // MANUAL ENTRY
  if (s.state === "MANUAL_ENTRY") {
    const up = msgUpper;

    if (up === "LIST") {
      twiml.message(`${listFormula(s.formula)}\n\n${VERSION}`);
      return res.type("text/xml").send(twiml.toString());
    }

    if (up.startsWith("REMOVE ")) {
      const name = raw.trim().slice(7).trim();
      const out = removeByName(s.formula, name);
      s.formula = out.after;
      await saveSession(from, s);
      twiml.message(
        (out.removed ? `✅ Removed: ${name}\n\n` : `Couldn't find: ${name}\n\n`) +
        `${listFormula(s.formula)}\n\nType DONE when finished.\n\n${VERSION}`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    if (up === "DONE") {
      if (s.formula.length < 2) {
        twiml.message(`Please add at least 2 ingredients first.\n\n${manualEntryHelp(s.ctx)}`);
        return res.type("text/xml").send(twiml.toString());
      }
      const report = buildMvpReport(s.ctx, s.formula);
      await resetSession(from);
      twiml.message(report);
      return res.type("text/xml").send(twiml.toString());
    }

    const item = parseAddLine(raw);
    if (!item) {
      twiml.message(`I couldn’t read that.\n\n${manualEntryHelp(s.ctx)}`);
      return res.type("text/xml").send(twiml.toString());
    }

    s.formula.push(item);
    if (s.formula.length > 200) s.formula = s.formula.slice(0, 200);
    await saveSession(from, s);

    const total = sumPct(s.formula);
    twiml.message(
      `✅ Added: ${item.name} = ${item.pct}%\n` +
      `Items: ${s.formula.length} | Total: ${total.toFixed(2)}%\n\n` +
      `Send next: ADD <name> <pct>\n` +
      `Or LIST / REMOVE <name> / DONE\n\n${VERSION}`
    );
    return res.type("text/xml").send(twiml.toString());
  }

  // BULK PASTE
  if (s.state === "BULK_PASTE") {
    const up = msgUpper;

    if (up === "LIST") {
      twiml.message(`${listFormula(s.formula)}\n\n${VERSION}`);
      return res.type("text/xml").send(twiml.toString());
    }

    if (up.startsWith("REMOVE ")) {
      const name = raw.trim().slice(7).trim();
      const out = removeByName(s.formula, name);
      s.formula = out.after;
      await saveSession(from, s);
      twiml.message(
        (out.removed ? `✅ Removed: ${name}\n\n` : `Couldn't find: ${name}\n\n`) +
        `${listFormula(s.formula)}\n\nPaste more lines, or type DONE.\n\n${VERSION}`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    if (up === "DONE") {
      if (s.formula.length < 2) {
        twiml.message(`Please paste at least 2 ingredients first.\n\n${bulkPasteHelp(s.ctx)}`);
        return res.type("text/xml").send(twiml.toString());
      }
      const report = buildMvpReport(s.ctx, s.formula);
      await resetSession(from);
      twiml.message(report);
      return res.type("text/xml").send(twiml.toString());
    }

    // parse bulk paste content
    const parts = splitBulkText(raw);
    let added = 0;
    let bad = 0;

    for (const p of parts) {
      const item = parseTokenFlexible(p);
      if (!item) { bad++; continue; }
      s.formula.push(item);
      added++;
      if (s.formula.length > 200) {
        s.formula = s.formula.slice(0, 200);
        break;
      }
    }

    await saveSession(from, s);

    const total = sumPct(s.formula);

    twiml.message(
      `✅ Bulk paste processed.\n` +
      `Added: ${added} | Unreadable: ${bad}\n` +
      `Items: ${s.formula.length} | Total: ${total.toFixed(2)}%\n\n` +
      `You can paste more, or type DONE.\n` +
      `Commands: LIST / REMOVE <name> / DONE / MENU\n\n${VERSION}`
    );
    return res.type("text/xml").send(twiml.toString());
  }

  // Fallback
  await resetSession(from);
  twiml.message(`${MAIN_MENU}\n\n${VERSION}`);
  return res.type("text/xml").send(twiml.toString());
});

// -------------------- Server --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(VERSION));
