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
    sessions.set(from, { state: "MAIN", data: {} });
  }
  return sessions.get(from);
}

function resetSession(from) {
  sessions.set(from, { state: "MAIN", data: {} });
}

function firstDigit(text) {
  const m = (text || "").trim().match(/^([1-9])/);
  return m ? m[1] : null;
}

/* =========================
   FLEXIBLE FORMULA INTAKE
========================= */
function parsePastedFormula(text) {
  if (!text) return [];

  let clean = text
    .replace(/o\./gi, "0.")
    .replace(/\r/g, "\n");

  const chunks = clean.split(/[,;\n]+/).map(c => c.trim()).filter(Boolean);
  const items = [];

  for (const chunk of chunks) {
    const nums = chunk.match(/-?\d+(\.\d+)?/g);
    if (!nums) continue;

    const inclusion = Number(nums[nums.length - 1]);
    if (!Number.isFinite(inclusion)) continue;

    const idx = chunk.lastIndexOf(nums[nums.length - 1]);
    let name = chunk.substring(0, idx).trim();

    name = name.replace(/[%:]+$/g, "").replace(/\s+/g, " ").trim();
    if (!name) name = "Custom ingredient";

    items.push({ name, inclusion });
  }

  return items;
}

/* =========================
   SIMPLE ANALYSIS (MVP)
========================= */
function analyzeFormula(ctx, items) {
  const total = items.reduce((s, i) => s + i.inclusion, 0);

  return (
    `✅ Formula captured successfully\n\n` +
    `Animal: Poultry\n` +
    `Type: ${ctx.poultryType}\n` +
    `Genetic line: ${ctx.geneticLine}\n` +
    `Stage: ${ctx.stage}\n` +
    `Feed form: ${ctx.feedForm}\n` +
    `Ingredients: ${items.length}\n` +
    `Total inclusion: ${total.toFixed(2)}%\n\n` +
    `Ingredient names accepted as entered.\n\n` +
    `Type MENU to start again.`
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
  res.send("NutriPilot AI – Poultry flow locked ✅");
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

  /* MAIN */
  if (session.state === "MAIN") {
    if (choice === "1") {
      session.state = "ANIMAL";
      twiml.message("Select animal category:\n1) Poultry\n2) Swine\n3) Dairy Cattle\n4) Beef Cattle\n5) Small Ruminants\n6) Equine");
    } else {
      twiml.message(MAIN_MENU);
    }
    return res.type("text/xml").send(twiml.toString());
  }

  /* ANIMAL */
  if (session.state === "ANIMAL") {
    if (choice === "1") {
      session.state = "POULTRY_TYPE";
      twiml.message("Select poultry type:\n1) Broiler\n2) Layer\n3) Breeder (Parent Stock)");
    } else {
      twiml.message("Only Poultry implemented in MVP.\nType MENU.");
    }
    return res.type("text/xml").send(twiml.toString());
  }

  /* POULTRY TYPE */
  if (session.state === "POULTRY_TYPE") {
    session.data.poultryType =
      choice === "1" ? "Broiler" :
      choice === "2" ? "Layer" : "Breeder";

    session.state = "GENETIC";
    twiml.message(
      "Select genetic line:\n" +
      "1) Ross\n2) Cobb\n3) Hubbard\n4) Arbor Acres\n5) Hy-Line\n6) Lohmann\n7) Other"
    );
    return res.type("text/xml").send(twiml.toString());
  }

  /* GENETIC */
  if (session.state === "GENETIC") {
    const map = {
      "1": "Ross", "2": "Cobb", "3": "Hubbard", "4": "Arbor Acres",
      "5": "Hy-Line", "6": "Lohmann", "7": "Other"
    };
    session.data.geneticLine = map[choice] || "Other";
    session.state = "STAGE";

    if (session.data.poultryType === "Broiler") {
      twiml.message("Select broiler stage:\n1) Starter\n2) Grower\n3) Finisher\n4) Withdrawal");
    } else if (session.data.poultryType === "Layer") {
      twiml.message("Select layer stage:\n1) Chick\n2) Grower\n3) Pre-lay\n4) Peak lay\n5) Post-peak");
    } else {
      twiml.message("Select breeder stage:\n1) Rearing\n2) Pre-breeder\n3) Production");
    }
    return res.type("text/xml").send(twiml.toString());
  }

  /* STAGE */
  if (session.state === "STAGE") {
    const broiler = ["Starter","Grower","Finisher","Withdrawal"];
    const layer = ["Chick","Grower","Pre-lay","Peak lay","Post-peak"];
    const breeder = ["Rearing","Pre-breeder","Production"];

    session.data.stage =
      session.data.poultryType === "Broiler" ? broiler[choice-1] :
      session.data.poultryType === "Layer" ? layer[choice-1] :
      breeder[choice-1];

    session.state = "FORM";
    twiml.message("Feed form:\n1) Mash\n2) Pellet\n3) Crumble");
    return res.type("text/xml").send(twiml.toString());
  }

  /* FORM */
  if (session.state === "FORM") {
    session.data.feedForm = choice === "1" ? "Mash" : choice === "2" ? "Pellet" : "Crumble";
    session.state = "PASTE";
    twiml.message("Paste your full formula now (any format accepted):");
    return res.type("text/xml").send(twiml.toString());
  }

  /* FORMULA */
  if (session.state === "PASTE") {
    const items = parsePastedFormula(body);
    const report = analyzeFormula(session.data, items);
    resetSession(from);
    twiml.message(report);
    return res.type("text/xml").send(twiml.toString());
  }

  twiml.message("Type MENU to continue.");
  res.type("text/xml").send(twiml.toString());
});

/* ========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("NutriPilot AI running"));
