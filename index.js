try { require("dotenv").config(); } catch (e) {}

const express = require("express");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

/* =========================
   SESSION STORE (MVP)
========================= */
const sessions = new Map();

function getSession(from) {
  if (!sessions.has(from)) {
    sessions.set(from, { state: "MAIN", data: {}, lastReport: null });
  }
  return sessions.get(from);
}

function resetSession(from) {
  sessions.set(from, { state: "MAIN", data: {}, lastReport: null });
}

function firstDigit(text) {
  const m = (text || "").trim().match(/^([1-9])/);
  return m ? m[1] : null;
}

/* =========================
   FLEXIBLE FORMULA READER
   (accepts ANY format)
========================= */
function parsePastedFormula(text) {
  if (!text) return [];

  let clean = text
    .replace(/o\./gi, "0.")   // fix o.122 typo
    .replace(/\r/g, "\n");

  const chunks = clean
    .split(/[,;\n]+/)
    .map(c => c.trim())
    .filter(Boolean);

  const items = [];

  for (const chunk of chunks) {
    const numbers = chunk.match(/-?\d+(\.\d+)?/g);
    if (!numbers) continue;

    const inclusion = Number(numbers[numbers.length - 1]);
    if (!Number.isFinite(inclusion)) continue;

    const idx = chunk.lastIndexOf(numbers[numbers.length - 1]);
    let name = chunk.substring(0, idx).trim();

    name = name
      .replace(/[%:]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!name) name = "Custom ingredient";

    items.push({ name, inclusion });
  }

  return items;
}

/* =========================
   SIMPLE ANALYSIS (MVP)
========================= */
function analyzeFormula({ species, phase, feedForm, items }) {
  const total = items.reduce((s, i) => s + i.inclusion, 0);

  const lower = items.map(i => i.name.toLowerCase());
  const hasSalt = lower.some(n => n.includes("salt") || n.includes("nacl"));
  const hasPremix = lower.some(n => n.includes("premix"));
  const hasLime = lower.some(n => n.includes("lime") || n.includes("caco3"));

  const flags = [];
  if (total < 95 || total > 105) flags.push(`Total inclusion ≈ ${total.toFixed(2)}%`);
  if (!hasPremix) flags.push("Premix not detected");
  if (!hasSalt) flags.push("Salt not detected");
  if (species === "Layer" && !hasLime) flags.push("No limestone/Ca source detected");

  const list = items.slice(0, 15)
    .map(i => `- ${i.name}: ${i.inclusion}%`)
    .join("\n");

  return (
    `✅ Formula captured successfully\n\n` +
    `Species: ${species}\n` +
    `Phase: ${phase}\n` +
    `Feed form: ${feedForm}\n` +
    `Ingredients detected: ${items.length}\n` +
    `Total: ${total.toFixed(2)}%\n\n` +
    `Ingredients:\n${list}\n\n` +
    (flags.length ? `⚠️ Flags:\n- ${flags.join("\n- ")}` : `✅ No major formulation flags detected`) +
    `\n\nIngredient names accepted as entered.\nType MENU to start again.`
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
5) Nutrition Partner Program`;

app.get("/", (req, res) => {
  res.send("NutriPilot AI router – FULL flexible intake ✅");
});

/* =========================
   WHATSAPP WEBHOOK
========================= */
app.post("/whatsapp", (req, res) => {
  const from = req.body.From;
  const body = (req.body.Body || "").trim();
  const msg = body.toLowerCase();
  const choice = firstDigit(body);

  const twiml = new twilio.twiml.MessagingResponse();
  const session = getSession(from);

  /* GLOBAL */
  if (!body || msg === "hi" || msg === "menu" || msg === "start") {
    resetSession(from);
    twiml.message(MAIN_MENU);
    return res.type("text/xml").send(twiml.toString());
  }

  /* MAIN MENU */
  if (session.state === "MAIN") {
    if (choice === "1") {
      session.state = "SPECIES";
      twiml.message("Select species:\n1) Broiler\n2) Layer");
    } else {
      twiml.message(MAIN_MENU);
    }
    return res.type("text/xml").send(twiml.toString());
  }

  /* SPECIES */
  if (session.state === "SPECIES") {
    session.data.species = choice === "2" ? "Layer" : "Broiler";
    session.state = "PHASE";
    twiml.message("Enter phase (Starter / Grower / Finisher / Peak):");
    return res.type("text/xml").send(twiml.toString());
  }

  /* PHASE */
  if (session.state === "PHASE") {
    session.data.phase = body;
    session.state = "FORM";
    twiml.message("Feed form? (Mash / Pellet):");
    return res.type("text/xml").send(twiml.toString());
  }

  /* FEED FORM */
  if (session.state === "FORM") {
    session.data.feedForm = body;
    session.state = "PASTE";
    twiml.message("Paste your full formula now (any format, very flexible):");
    return res.type("text/xml").send(twiml.toString());
  }

  /* FORMULA PASTE */
  if (session.state === "PASTE") {
    const items = parsePastedFormula(body);

    if (items.length < 2) {
      twiml.message(
        "I couldn’t extract enough ingredients.\n\n" +
        "Please paste the full formula again (any format is fine)."
      );
      return res.type("text/xml").send(twiml.toString());
    }

    const report = analyzeFormula({
      species: session.data.species,
      phase: session.data.phase,
      feedForm: session.data.feedForm,
      items
    });

    session.lastReport = report;
    session.state = "MAIN";
    twiml.message(report);
    return res.type("text/xml").send(twiml.toString());
  }

  twiml.message("Type MENU to continue.");
  res.type("text/xml").send(twiml.toString());
});

/* =========================
   SERVER
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("NutriPilot AI running"));
