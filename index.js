try { require("dotenv").config(); } catch (e) {}

const express = require("express");
const twilio = require("twilio");
const Redis = require("ioredis");

const app = express();
app.use(express.urlencoded({ extended: false }));

const VERSION = "NutriPilot AI vFinal+BulkPaste v3 ✅ (Lab-assisted DM+CP for majors ≥10%)";

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
    ctx: {},                 // animal/poultry/genetics/stage/feedform
    formula: [],             // [{name, pct}]
    // Lab-assisted flow
    estimateMode: null,      // "quick" | "lab"
    majorQueue: [],          // [{name, pct}]
    majorIdx: 0,
    lab: {
      overrides: {}          // key=normalized ingredient name -> {dm, cpDm}  (percent)
    }
  };
}

// -------------------- Helpers --------------------
function normUpper(x) { return String(x || "").trim().toUpperCase(); }
function normLower(x) { return String(x || "").trim().toLowerCase(); }

function firstDigit(x) {
  const m = String(x || "").trim().match(/^([1-9])$/);
  return m ? m[1] : null;
}

function normalizeNumericTypos(text) {
  return String(text || "")
    .replace(/o\./gi, "0.")                 // o.122 -> 0.122
    .replace(/(^|[^\d])\.(\d+)/g, "$10.$2") // .122 -> 0.122
    .replace(/,\s*(\d)/g, ".$1");           // 0,12 -> 0.12 (basic EU decimal)
}

function safeNum(x) {
  const s = normalizeNumericTypos(x).replace(/[^\d.\-]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function extractNumbers(text) {
  const t = normalizeNumericTypos(text);
  const m = t.match(/-?(?:\d*\.\d+|\d+)/g);
  if (!m) return [];
  return m.map(x => Number(x)).filter(n => Number.isFinite(n));
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
  const raw0 = String(text || "").trim();
  if (!raw0) return null;

  const raw = normalizeNumericTypos(raw0).replace(/[,;]+$/g, "").trim();
  const withoutAdd = raw.replace(/^ADD\s+/i, "");

  // last number at end = inclusion
  const m = withoutAdd.match(/^(.*?)(-?(?:\d*\.\d+|\d+))\s*%?\s*$/);
  if (!m) return null;

  const name = m[1].trim().replace(/[:\-]+$/g, "").trim();
  const pct = safeNum(m[2]);
  if (!name || pct === null) return null;
  if (pct > 100) return null;

  return { name, pct };
}

// Flexible bulk token: keeps CP% inside name, uses last number at end as inclusion
function parseTokenFlexible(token) {
  const t0 = String(token || "").trim();
  if (!t0) return null;

  const t1 = normalizeNumericTypos(t0)
    .replace(/^[\-\u2022•\*]+\s*/g, "")
    .replace(/[,;]+$/g, "")
    .trim();

  const m = t1.match(/^(.*?)(-?(?:\d*\.\d+|\d+))\s*%?\s*$/);
  if (!m) return null;

  const name = m[1].trim().replace(/[:\-]+$/g, "").trim();
  const pct = safeNum(m[2]);
  if (!name || pct === null) return null;
  if (pct > 100) return null;

  return { name, pct };
}

function splitBulkText(text) {
  const base = String(text || "")
    .split(/[\n;\r]+/g)
    .map(s => s.trim())
    .filter(Boolean);

  const out = [];
  for (const line of base) {
    const parts = line.split(",").map(x => x.trim()).filter(Boolean);
    out.push(...parts);
  }
  return out;
}

function contextBlock(ctx) {
  return [
    `Animal: ${ctx.animal || "-"}`,
    ctx.poultryCategory ? `Poultry: ${ctx.poultryCategory}` : null,
    ctx.geneticLine ? `Genetic line: ${ctx.geneticLine}` : null,
    ctx.stage ? `Stage: ${ctx.stage}` : null,
    ctx.feedForm ? `Feed form: ${ctx.feedForm}` : null,
  ].filter(Boolean).join("\n");
}

// -------------------- Simple default nutrient library (DM%, CP% on DM basis) --------------------
// You can expand later. This is enough for v1.
function getDefaultDMCP(nameRaw) {
  const n = normLower(nameRaw);

  // grains / energy
  if (/(maize|corn)/.test(n)) return { dm: 88, cpDm: 9.0 };
  if (/(wheat)/.test(n)) return { dm: 88, cpDm: 12.0 };
  if (/(sorghum|milo)/.test(n)) return { dm: 88, cpDm: 10.0 };
  if (/(rice broken|broken rice|rice)/.test(n)) return { dm: 88, cpDm: 8.0 };
  if (/(barley)/.test(n)) return { dm: 88, cpDm: 11.0 };
  if (/(millet|bajra)/.test(n)) return { dm: 88, cpDm: 11.0 };

  // protein meals
  if (/(soybean meal|sbm)/.test(n)) return { dm: 89, cpDm: 48.0 };
  if (/(canola meal|rapeseed meal)/.test(n)) return { dm: 89, cpDm: 38.0 };
  if (/(sunflower meal)/.test(n)) return { dm: 90, cpDm: 32.0 };
  if (/(ddgs)/.test(n)) return { dm: 90, cpDm: 30.0 };
  if (/(fishmeal|fish meal)/.test(n)) return { dm: 92, cpDm: 60.0 };
  if (/(meat bone|mbm)/.test(n)) return { dm: 93, cpDm: 50.0 };
  if (/(corn gluten)/.test(n)) return { dm: 90, cpDm: 60.0 };

  // fats/oils (CP=0)
  if (/(oil|fat|tallow|grease)/.test(n)) return { dm: 99, cpDm: 0.0 };

  // minerals/premix/additives (CP=0; DM ~ 95–99)
  if (/(salt|nacl)/.test(n)) return { dm: 99, cpDm: 0.0 };
  if (/(limestone|calcite|calcium carbonate)/.test(n)) return { dm: 98, cpDm: 0.0 };
  if (/(dcp|mcp|mdcp|phosphate)/.test(n)) return { dm: 98, cpDm: 0.0 };
  if (/(premix|vitamin|mineral)/.test(n)) return { dm: 95, cpDm: 0.0 };
  if (/(dlm|methionine|lysine|threonine|valine|tryptophan)/.test(n)) return { dm: 99, cpDm: 0.0 };

  // fallback
  return { dm: 88, cpDm: 12.0 };
}

// Extract a CP tag embedded in ingredient name, e.g. "SBM44%" or "Fishmeal54%" or "Sunflower meal26-28%"
function extractCPTagFromName(nameRaw) {
  const s = String(nameRaw || "");

  // range like 26-28%
  const r = s.match(/(\d{1,2})(?:\.\d+)?\s*-\s*(\d{1,2})(?:\.\d+)?\s*%/);
  if (r) {
    const a = Number(r[1]), b = Number(r[2]);
    if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0) {
      const mid = (a + b) / 2;
      // plausible CP range
      if (mid >= 5 && mid <= 80) return mid;
    }
  }

  // single like 44%
  const m = s.match(/(\d{1,2})(?:\.\d+)?\s*%/);
  if (m) {
    const v = Number(m[1]);
    if (Number.isFinite(v) && v >= 5 && v <= 80) return v;
  }

  return null;
}

function calcDietDMCP(formula, overrides) {
  // overrides: normalized name -> {dm, cpDm}
  let dmSum = 0;      // sum(inclusion * dm%)
  let cpKg = 0;       // CP contribution in "percent points" on as-fed basis

  for (const it of formula) {
    const inc = safeNum(it.pct);
    if (!Number.isFinite(inc)) continue;

    const key = normLower(it.name);
    const ov = overrides && overrides[key] ? overrides[key] : null;

    let dm = ov?.dm;
    let cpDm = ov?.cpDm;

    // if no override cpDm, try CP tag inside name as default CP DM
    if (cpDm === undefined || cpDm === null) {
      const tag = extractCPTagFromName(it.name);
      if (tag !== null) cpDm = tag;
    }

    const def = getDefaultDMCP(it.name);
    if (dm === undefined || dm === null) dm = def.dm;
    if (cpDm === undefined || cpDm === null) cpDm = def.cpDm;

    // Convert CP on DM basis to as-fed CP
    const cpAsFed = (cpDm * (dm / 100));

    dmSum += inc * dm;
    cpKg += inc * (cpAsFed / 100); // CP% contribution = inclusion% * (CP_asfed%)/100
  }

  // Diet DM% = dmSum/100
  const dietDM = dmSum / 100;

  // Diet CP% (as-fed) = sum contributions
  const dietCP = cpKg;

  return {
    dietDM: Number.isFinite(dietDM) ? dietDM : null,
    dietCP: Number.isFinite(dietCP) ? dietCP : null
  };
}

function buildMvpReport(ctx, formula, overrides, modeLabel) {
  const total = sumPct(formula);

  const names = formula.map(x => normLower(x.name));
  const hasSalt = names.some(n => n.includes("salt") || n.includes("nacl"));
  const hasPremix = names.some(n => n.includes("premix"));

  const flags = [];
  if (total < 99 || total > 101) flags.push(`Total inclusion = ${total.toFixed(2)}% (target ~100%)`);
  if (!hasSalt) flags.push("Salt not detected (check Na/Cl source).");
  if (!hasPremix) flags.push("Premix not detected (vit/min premix may be missing).");

  // Micro load check (sum of <0.5%)
  const microSum = formula.reduce((s, it) => {
    const p = safeNum(it.pct);
    if (!Number.isFinite(p)) return s;
    return p < 0.5 ? s + p : s;
  }, 0);
  if (microSum > 2.5) flags.push(`High micro-ingredient load (<0.5% items sum = ${microSum.toFixed(2)}%)`);

  // duplicates (exact same name)
  const seen = new Set();
  const dupes = [];
  for (const it of formula) {
    const k = normLower(it.name);
    if (seen.has(k)) dupes.push(it.name);
    seen.add(k);
  }
  if (dupes.length) flags.push(`Duplicate ingredient names detected: ${dupes.slice(0, 3).join(", ")}${dupes.length > 3 ? "…" : ""}`);

  const est = calcDietDMCP(formula, overrides || {});
  const ctxBlock = contextBlock(ctx);
  const top = formula.slice(0, 15).map(it => `- ${it.name}: ${it.pct}%`).join("\n");

  const estBlock = [
    `Estimate mode: ${modeLabel}`,
    est.dietDM !== null ? `Estimated diet DM: ${est.dietDM.toFixed(1)}%` : `Estimated diet DM: n/a`,
    est.dietCP !== null ? `Estimated diet CP (as-fed): ${est.dietCP.toFixed(2)}%` : `Estimated diet CP: n/a`,
  ].join("\n");

  return (
`✅ Formula Review (MVP + DM/CP estimate)

${ctxBlock}

${estBlock}

Ingredients: ${formula.length}
Total: ${total.toFixed(2)}%

Top items:
${top}

${flags.length ? `⚠️ Flags:\n- ${flags.join("\n- ")}` : "✅ No major MVP flags detected."}

Type MENU to start again.

${VERSION}`
  );
}

function buildEstimateModeMenu() {
  return (
`Nutrient Estimate Mode

1) Quick estimate (defaults)
2) Lab-assisted estimate (recommended)

Reply 1 or 2.
(Type MENU anytime)`
  );
}

function buildMajorListMessage(majors) {
  if (!majors.length) {
    return `No major ingredients (≥10%) detected. Using defaults.\n\n${VERSION}`;
  }
  const lines = majors.map((x, i) => `${i + 1}) ${x.name} — ${x.pct}%`).join("\n");
  return (
`Major ingredients detected (≥10%):

${lines}

We will ask DM% and CP% for each major ingredient (including grains).
Reply OK to start, or SKIP to use defaults.`
  );
}

function buildAskMajorPrompt(ctx, item) {
  const key = normLower(item.name);
  const cpTag = extractCPTagFromName(item.name);
  const note = cpTag !== null ? `CP tag detected in name: ${cpTag}% (you can override)` : `No CP tag in name (defaults will be used if you SKIP).`;

  return (
`Lab values needed (Major ingredient)

${contextBlock(ctx)}

Ingredient: ${item.name}
Inclusion: ${item.pct}%

Send: DM, CP
Example: 88, 8.5

- DM = dry matter %
- CP = crude protein % (on DM basis)

Type SKIP to use defaults for this ingredient.
(Type MENU anytime)

${note}`
  );
}

function parseLabReply(text) {
  const up = normUpper(text);
  if (up === "SKIP") return { skip: true };

  const nums = extractNumbers(text);
  if (!nums.length) return { ok: false };

  // DM must be 50–99 typical; CP 0–80
  const dm = nums[0];
  const cp = nums.length >= 2 ? nums[1] : null;

  if (!(dm > 40 && dm <= 100)) return { ok: false };

  if (cp !== null && !(cp >= 0 && cp <= 80)) return { ok: false };

  return { ok: true, dm, cp };
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

function manualEntryHelp(ctx) {
  return (
`Manual Entry (% only)

${contextBlock(ctx)}

Send each ingredient in ONE message:
ADD <ingredient name> <percent>

Examples:
ADD Maize 27.45
ADD SBM44% 25.34
ADD Sunflower meal26-28% 5
ADD DLM99% o.122

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
SBM44% 25.34
Sunflower meal26-28%5
DLM99% o.122
Salt 0.30

Commands:
LIST
REMOVE <ingredient name>
DONE
MENU`
  );
}

// -------------------- Health check --------------------
app.get(["/", "/whatsapp"], (req, res) => {
  res.status(200).send(VERSION);
});

// -------------------- Webhook --------------------
app.post(["/", "/whatsapp"], async (req, res) => {
  const from = req.body.From || "unknown";
  const raw = req.body.Body || "";
  const msgLower = normLower(raw);
  const msgUpper = normUpper(raw);
  const d = firstDigit(raw);

  const twiml = new twilio.twiml.MessagingResponse();

  // Global reset shortcuts
  if (!msgLower || ["hi", "hello", "menu", "start"].includes(msgLower)) {
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
      s.estimateMode = null;
      s.majorQueue = [];
      s.majorIdx = 0;
      s.lab = { overrides: {} };
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
    const map = { "1":"Broiler", "2":"Layer", "3":"Broiler Breeder", "4":"Layer Breeder" };
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

      // NEW: go to estimate mode choice
      s.state = "EST_MODE";
      s.estimateMode = null;
      s.majorQueue = [];
      s.majorIdx = 0;
      s.lab = { overrides: {} };
      await saveSession(from, s);
      twiml.message(buildEstimateModeMenu());
      return res.type("text/xml").send(twiml.toString());
    }

    const item = parseAddLine(raw);
    if (!item) {
      twiml.message(`I couldn’t read that.\n\n${manualEntryHelp(s.ctx)}`);
      return res.type("text/xml").send(twiml.toString());
    }

    s.formula.push(item);
    if (s.formula.length > 250) s.formula = s.formula.slice(0, 250);
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

      // NEW: go to estimate mode choice
      s.state = "EST_MODE";
      s.estimateMode = null;
      s.majorQueue = [];
      s.majorIdx = 0;
      s.lab = { overrides: {} };
      await saveSession(from, s);
      twiml.message(buildEstimateModeMenu());
      return res.type("text/xml").send(twiml.toString());
    }

    const parts = splitBulkText(raw);
    let added = 0;
    let bad = 0;

    for (const p of parts) {
      const item = parseTokenFlexible(p);
      if (!item) { bad++; continue; }
      s.formula.push(item);
      added++;
      if (s.formula.length > 250) break;
    }

    await saveSession(from, s);

    const total = sumPct(s.formula);
    twiml.message(
      `✅ Bulk paste processed.\n` +
      `Added: ${added} | Unreadable: ${bad}\n` +
      `Items: ${s.formula.length} | Total: ${total.toFixed(2)}%\n\n` +
      `Paste more, or type DONE.\n` +
      `Commands: LIST / REMOVE <name> / DONE / MENU\n\n${VERSION}`
    );
    return res.type("text/xml").send(twiml.toString());
  }

  // ESTIMATE MODE (after DONE)
  if (s.state === "EST_MODE") {
    if (d === "1") {
      // Quick defaults -> report now
      const report = buildMvpReport(s.ctx, s.formula, {}, "Quick defaults");
      await resetSession(from);
      twiml.message(report);
      return res.type("text/xml").send(twiml.toString());
    }

    if (d === "2") {
      s.estimateMode = "lab";

      // Detect major ingredients ≥10%
      const majors = s.formula
        .map(it => ({ name: it.name, pct: safeNum(it.pct) }))
        .filter(it => Number.isFinite(it.pct) && it.pct >= 10)
        .map(it => ({ name: it.name, pct: Number(it.pct.toFixed(3)) }));

      s.majorQueue = majors;
      s.majorIdx = 0;
      s.lab = { overrides: {} };

      s.state = "LAB_MAJOR_LIST";
      await saveSession(from, s);
      twiml.message(buildMajorListMessage(majors));
      return res.type("text/xml").send(twiml.toString());
    }

    twiml.message(buildEstimateModeMenu());
    return res.type("text/xml").send(twiml.toString());
  }

  // Confirmation before asking lab values
  if (s.state === "LAB_MAJOR_LIST") {
    const up = msgUpper;

    if (up === "SKIP") {
      // use defaults
      const report = buildMvpReport(s.ctx, s.formula, {}, "Defaults (lab skipped)");
      await resetSession(from);
      twiml.message(report);
      return res.type("text/xml").send(twiml.toString());
    }

    if (up === "OK" || up === "YES") {
      if (!s.majorQueue.length) {
        const report = buildMvpReport(s.ctx, s.formula, {}, "Defaults (no majors)");
        await resetSession(from);
        twiml.message(report);
        return res.type("text/xml").send(twiml.toString());
      }

      s.state = "LAB_ASK";
      s.majorIdx = 0;
      await saveSession(from, s);

      const item = s.majorQueue[s.majorIdx];
      twiml.message(buildAskMajorPrompt(s.ctx, item));
      return res.type("text/xml").send(twiml.toString());
    }

    twiml.message(buildMajorListMessage(s.majorQueue));
    return res.type("text/xml").send(twiml.toString());
  }

  // LAB_ASK: ask DM,CP per major ingredient
  if (s.state === "LAB_ASK") {
    const up = msgUpper;

    // allow LIST anytime
    if (up === "LIST") {
      twiml.message(`${listFormula(s.formula)}\n\n${VERSION}`);
      return res.type("text/xml").send(twiml.toString());
    }

    const current = s.majorQueue[s.majorIdx];
    if (!current) {
      // safety
      const report = buildMvpReport(s.ctx, s.formula, s.lab.overrides, "Lab-assisted");
      await resetSession(from);
      twiml.message(report);
      return res.type("text/xml").send(twiml.toString());
    }

    const parsed = parseLabReply(raw);

    const key = normLower(current.name);
    const def = getDefaultDMCP(current.name);

    if (parsed.skip) {
      // do nothing (defaults will be used)
    } else if (parsed.ok) {
      const dm = parsed.dm;
      // If CP not provided, use CP tag from name or default
      let cpDm = parsed.cp;
      if (cpDm === null) {
        const tag = extractCPTagFromName(current.name);
        cpDm = tag !== null ? tag : def.cpDm;
      }
      s.lab.overrides[key] = { dm, cpDm };
    } else {
      twiml.message(`I couldn’t read that. Send DM, CP like: 88, 8.5  (or SKIP)\n\n${buildAskMajorPrompt(s.ctx, current)}`);
      return res.type("text/xml").send(twiml.toString());
    }

    // Next ingredient
    s.majorIdx += 1;

    if (s.majorIdx >= s.majorQueue.length) {
      // Finish -> report
      const report = buildMvpReport(s.ctx, s.formula, s.lab.overrides, "Lab-assisted (majors)");
      await resetSession(from);
      twiml.message(report);
      return res.type("text/xml").send(twiml.toString());
    }

    await saveSession(from, s);

    const nextItem = s.majorQueue[s.majorIdx];
    twiml.message(buildAskMajorPrompt(s.ctx, nextItem));
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
