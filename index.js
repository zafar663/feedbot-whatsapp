require("dotenv").config();
const express = require("express");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

app.get("/", (req, res) => {
  res.status(200).send("NutriPilot AI router v4 + Core1 manual entry v1 ✅");
});

/** Session store (MVP in-memory) */
const sessions = new Map(); // key=From -> { state, data, lastReport }

function getSession(from) {
  return sessions.get(from) || { state: "MAIN", data: {}, lastReport: null };
}
function setSession(from, session) {
  sessions.set(from, session);
}
function reset(from) {
  setSession(from, { state: "MAIN", data: {}, lastReport: null });
}

function firstDigitChoice(text) {
  const m = (text || "").trim().match(/^([1-9])/);
  return m ? m[1] : null;
}
function safeNum(x) {
  const n = Number(String(x ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Menus */
const MAIN_MENU =
  `NutriPilot AI\n\n` +
  `How can we help you today?\n\n` +
  `1) Formulation & Diet Control\n` +
  `2) Performance & Production Intelligence\n` +
  `3) Raw Materials, Feed Mill & Quality\n` +
  `4) Expert Review\n` +
  `5) Nutrition Partner Program\n\n` +
  `Type MENU anytime to return here.`;

const CORE1_MENU =
  `Formulation & Diet Control\n\n` +
  `1) Build a new formula (MVP)\n` +
  `2) Reformulate an existing diet (next)\n` +
  `3) Diet approval / risk check (next)\n` +
  `4) Additives & enzymes guidance (next)\n\n` +
  `Reply 1 to start, or type BACK / MENU.`;

const CORE2_MENU = `Performance & Production Intelligence\n\nType MENU to return (MVP next).`;
const CORE3_MENU = `Raw Materials, Feed Mill & Quality\n\nType MENU to return (MVP next).`;
const CORE4_MENU = `Expert Review\n\nType MENU to return (MVP next).`;
const CORE5_MENU = `Nutrition Partner Program\n\nType MENU to return (MVP next).`;

const FORMULA_INPUT_MENU =
  `Step 4/4: Provide your formula\n\n` +
  `1) Paste formula text (fast)\n` +
  `2) Upload Excel/CSV (coming soon)\n` +
  `3) Upload photo (coming soon)\n` +
  `4) Manual entry (guided / bulk)\n\n` +
  `Reply 1–4.`;

/** Parse pasted formula like: "Corn 58; SBM 28; Oil 3" */
function parsePastedFormula(text) {
  const parts = (text || "").split(/[;\n]+/).map(s => s.trim()).filter(Boolean);
  const items = [];
  for (const p of parts) {
    const m = p.match(/^(.*?)(-?\d+(?:\.\d+)?)\s*%?\s*$/);
    if (!m) continue;
    const name = m[1].trim().replace(/[:\-]+$/, "").trim();
    const val = safeNum(m[2]);
    if (!name || val === null) continue;
    items.push({ name, inclusion: val });
  }
  return items.slice(0, 80);
}

/** Bulk paste parser for manual entry:
 * Lines like:
 *   Corn | 58
 *   Soybean meal, 28
 */
function parseBulkLines(text) {
  const lines = (text || "").split(/\n+/).map(l => l.trim()).filter(Boolean);
  const items = [];
  for (const line of lines) {
    let parts;
    if (line.includes("|")) parts = line.split("|").map(s => s.trim());
    else if (line.includes(",")) parts = line.split(",").map(s => s.trim());
    else continue;

    const name = parts[0];
    const inc = safeNum(parts[1]);
    if (!name || inc === null) continue;
    items.push({ name, inclusion: inc });
  }
  return items.slice(0, 80);
}

function analyzeFormula({ species, phase, feedForm, items }) {
  const total = items.reduce((s, x) => s + (safeNum(x.inclusion) || 0), 0);

  const namesLower = items.map(x => String(x.name).toLowerCase());
  const hasSalt = namesLower.some(n => n.includes("salt") || n.includes("nacl"));
  const hasLime = namesLower.some(n => n.includes("lime") || n.includes("limestone") || n.includes("caco3"));
  const hasPremix = namesLower.some(n => n.includes("premix") || n.includes("vit") || n.includes("min"));

  const saltItem = items.find(x => String(x.name).toLowerCase().includes("salt"));
  const saltVal = saltItem ? safeNum(saltItem.inclusion) : null;

  const flags = [];
  if (total < 95 || total > 105) flags.push(`Total inclusion looks off (${total.toFixed(1)}). Expected ~100.`);
  if (!hasPremix) flags.push(`Premix not detected (check vitamin/mineral premix).`);
  if (!hasSalt) flags.push(`Salt not detected (check Na/Cl source).`);
  if (species === "Layer" && !hasLime) flags.push(`Limestone/Ca source not detected (critical for layers).`);
  if (saltVal !== null && saltVal > 0.6) flags.push(`Salt looks high (${saltVal}). Double-check Na/Cl & mixing risk.`);

  const top = items.slice(0, 12).map(x => `- ${x.name}: ${x.inclusion}`).join("\n");

  return (
    `✅ Formula Snapshot (MVP)\n\n` +
    `Species: ${species}\n` +
    `Phase: ${phase}\n` +
    `Feed form: ${feedForm}\n` +
    `Items captured: ${items.length}\n` +
    `Total: ${total.toFixed(1)}\n\n` +
    `Items:\n${top}\n\n` +
    (flags.length ? `⚠️ Flags:\n- ${flags.join("\n- ")}\n\n` : `✅ No major flags detected (MVP checks).\n\n`) +
    `Next: We’ll add nutrient targets + deeper checks.\n` +
    `Type MENU to start over.`
  );
}

/** Manual entry helper actions */
function listItems(items) {
  if (!items?.length) return "No ingredients added yet.";
  const lines = items.slice(0, 20).map((x, i) => `${i + 1}. ${x.name} = ${x.inclusion}%`);
  const extra = items.length > 20 ? `\n...and ${items.length - 20} more` : "";
  return `Current formula:\n${lines.join("\n")}${extra}`;
}
function removeItem(items, nameToRemove) {
  const n = (nameToRemove || "").trim().toLowerCase();
  if (!n) return { items, removed: false };
  const before = items.length;
  const filtered = items.filter(x => String(x.name).toLowerCase() !== n);
  return { items: filtered, removed: filtered.length !== before };
}

app.post("/whatsapp", (req, res) => {
  const from = req.body.From || "unknown";
  const raw = (req.body.Body || "").trim();
  const msg = raw.toLowerCase();
  const choice = firstDigitChoice(raw);

  const twiml = new twilio.twiml.MessagingResponse();

  // Global commands
  if (msg === "" || msg === "hi" || msg === "hello" || msg === "start" || msg === "menu") {
    reset(from);
    twiml.message(MAIN_MENU);
    res.type("text/xml");
    return res.send(twiml.toString());
  }
  if (msg === "back") {
    reset(from);
    twiml.message(MAIN_MENU);
    res.type("text/xml");
    return res.send(twiml.toString());
  }
  if (msg === "result") {
    const session = getSession(from);
    twiml.message(session.lastReport || `No report found yet. Type MENU.`);
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  const session = getSession(from);

  // MAIN routing
  if (session.state === "MAIN") {
    if (choice === "1") {
      session.state = "CORE1_MENU";
      session.data = {};
      setSession(from, session);
      twiml.message(CORE1_MENU);
    } else if (choice === "2") {
      session.state = "CORE2_MENU";
      setSession(from, session);
      twiml.message(CORE2_MENU);
    } else if (choice === "3") {
      session.state = "CORE3_MENU";
      setSession(from, session);
      twiml.message(CORE3_MENU);
    } else if (choice === "4") {
      session.state = "CORE4_MENU";
      setSession(from, session);
      twiml.message(CORE4_MENU);
    } else if (choice === "5") {
      session.state = "CORE5_MENU";
      setSession(from, session);
      twiml.message(CORE5_MENU);
    } else {
      twiml.message(`✅ Received: "${raw}"\n\n${MAIN_MENU}`);
    }
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  // Core menus
  if (session.state === "CORE1_MENU") {
    if (choice === "1") {
      session.state = "C1_NEW_SPECIES";
      session.data = {};
      setSession(from, session);
      twiml.message(
        `Build a new formula (MVP)\n\n` +
          `Step 1/4: Choose species/category:\n` +
          `1) Broiler\n2) Layer\n3) Swine\n4) Dairy\n\nReply 1–4.`
      );
    } else {
      twiml.message(CORE1_MENU);
    }
    res.type("text/xml");
    return res.send(twiml.toString());
  }
  if (session.state === "CORE2_MENU") return res.type("text/xml").send(new twilio.twiml.MessagingResponse().message(CORE2_MENU).toString());
  if (session.state === "CORE3_MENU") return res.type("text/xml").send(new twilio.twiml.MessagingResponse().message(CORE3_MENU).toString());
  if (session.state === "CORE4_MENU") return res.type("text/xml").send(new twilio.twiml.MessagingResponse().message(CORE4_MENU).toString());
  if (session.state === "CORE5_MENU") return res.type("text/xml").send(new twilio.twiml.MessagingResponse().message(CORE5_MENU).toString());

  // Core1 steps 1–3
  if (session.state === "C1_NEW_SPECIES") {
    const map = { "1": "Broiler", "2": "Layer", "3": "Swine", "4": "Dairy" };
    if (!map[choice]) twiml.message(`Please reply 1–4.\n\n1) Broiler  2) Layer  3) Swine  4) Dairy`);
    else {
      session.data.species = map[choice];
      session.state = "C1_NEW_PHASE";
      setSession(from, session);

      if (session.data.species === "Broiler") twiml.message(`Step 2/4: Select phase:\n1) Starter\n2) Grower\n3) Finisher\n\nReply 1–3.`);
      else if (session.data.species === "Layer") twiml.message(`Step 2/4: Select phase:\n1) Pre-lay\n2) Peak\n3) Post-peak\n\nReply 1–3.`);
      else twiml.message(`Step 2/4: Enter the phase/stage (example: starter / grower / lactation / gestation):`);
    }
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  if (session.state === "C1_NEW_PHASE") {
    const s = session.data.species;

    if (s === "Broiler") {
      const map = { "1": "Starter", "2": "Grower", "3": "Finisher" };
      if (!map[choice]) twiml.message(`Reply 1–3.\n\n1) Starter  2) Grower  3) Finisher`);
      else {
        session.data.phase = map[choice];
        session.state = "C1_NEW_FORM";
        setSession(from, session);
        twiml.message(`Step 3/4: Feed form?\n1) Mash\n2) Pellet\n3) Crumble\n\nReply 1–3.`);
      }
    } else if (s === "Layer") {
      const map = { "1": "Pre-lay", "2": "Peak", "3": "Post-peak" };
      if (!map[choice]) twiml.message(`Reply 1–3.\n\n1) Pre-lay  2) Peak  3) Post-peak`);
      else {
        session.data.phase = map[choice];
        session.state = "C1_NEW_FORM";
        setSession(from, session);
        twiml.message(`Step 3/4: Feed form?\n1) Mash\n2) Pellet\n\nReply 1–2.`);
      }
    } else {
      session.data.phase = raw;
      session.state = "C1_NEW_FORM";
      setSession(from, session);
      twiml.message(`Step 3/4: Feed form?\n1) Mash\n2) Pellet\n3) Meal\n\nReply 1–3.`);
    }

    res.type("text/xml");
    return res.send(twiml.toString());
  }

  if (session.state === "C1_NEW_FORM") {
    const map = { "1": "Mash", "2": "Pellet", "3": "Crumble/Meal" };
    if (!map[choice]) {
      twiml.message(`Reply 1–3.\n\n1) Mash  2) Pellet  3) Crumble/Meal`);
      res.type("text/xml");
      return res.send(twiml.toString());
    }
    session.data.feedForm = map[choice];
    session.state = "C1_FORMULA_INPUT_METHOD";
    setSession(from, session);
    twiml.message(FORMULA_INPUT_MENU);
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  // Step 4: choose input method
  if (session.state === "C1_FORMULA_INPUT_METHOD") {
    if (choice === "1") {
      session.state = "C1_PASTE_FORMULA";
      setSession(from, session);
      twiml.message(
        `Paste your formula now.\n\nExample:\nCorn 58; Soybean meal 28; Oil 3; Limestone 1.2; DCP 1.6; Salt 0.3; Premix 0.5`
      );
    } else if (choice === "2") {
      twiml.message(`Upload Excel/CSV is coming soon.\n\nFor now use:\n1) Paste formula OR\n4) Manual entry.`);
    } else if (choice === "3") {
      twiml.message(`Photo upload is coming soon.\n\nFor now use:\n1) Paste formula OR\n4) Manual entry.`);
    } else if (choice === "4") {
      session.state = "C1_MANUAL_HOME";
      session.data.items = [];
      setSession(from, session);
      twiml.message(
        `Manual Entry (% only)\n\n` +
          `Choose one:\n` +
          `A) Type ADD to enter ingredients one-by-one\n` +
          `B) Paste multiple lines like:\n` +
          `Corn | 58\nSoybean meal | 28\nOil | 3\n\n` +
          `Commands: ADD, LIST, REMOVE <name>, DONE, MENU`
      );
    } else {
      twiml.message(FORMULA_INPUT_MENU);
    }
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  // Pasted formula
  if (session.state === "C1_PASTE_FORMULA") {
    const items = parsePastedFormula(raw);
    if (items.length < 2) {
      twiml.message(
        `I couldn't detect ingredient + number pairs.\n\nPaste like:\nCorn 58; Soybean meal 28; Oil 3; Salt 0.3`
      );
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    const report = analyzeFormula({
      species: session.data.species,
      phase: session.data.phase,
      feedForm: session.data.feedForm,
      items
    });

    session.lastReport = report;
    session.state = "CORE1_MENU";
    setSession(from, session);
    twiml.message(report);
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  // Manual entry home (accept commands or bulk paste)
  if (session.state === "C1_MANUAL_HOME") {
    // Bulk paste detection
    const bulk = parseBulkLines(raw);
    if (bulk.length >= 2) {
      session.data.items = [...(session.data.items || []), ...bulk].slice(0, 80);
      setSession(from, session);
      twiml.message(`✅ Added ${bulk.length} lines.\n\n${listItems(session.data.items)}\n\nType DONE to analyze, or ADD to continue.`);
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    if (msg === "add") {
      session.state = "C1_MANUAL_ADD_NAME";
      setSession(from, session);
      twiml.message(`Send ingredient name (example: Corn).`);
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    if (msg === "list") {
      twiml.message(listItems(session.data.items));
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    if (msg.startsWith("remove")) {
      const nameToRemove = raw.replace(/^remove/i, "").trim();
      const out = removeItem(session.data.items || [], nameToRemove);
      session.data.items = out.items;
      setSession(from, session);
      twiml.message(out.removed ? `✅ Removed: ${nameToRemove}\n\n${listItems(session.data.items)}` : `Couldn't find: ${nameToRemove}\n\n${listItems(session.data.items)}`);
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    if (msg === "done") {
      const items = session.data.items || [];
      if (items.length < 2) {
        twiml.message(`Please add at least 2 ingredients first.\n\nType ADD or paste multiple lines.`);
        res.type("text/xml");
        return res.send(twiml.toString());
      }

      const report = analyzeFormula({
        species: session.data.species,
        phase: session.data.phase,
        feedForm: session.data.feedForm,
        items
      });

      session.lastReport = report;
      session.state = "CORE1_MENU";
      setSession(from, session);
      twiml.message(report);
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    twiml.message(
      `Manual Entry commands:\nADD, LIST, REMOVE <name>, DONE, MENU\n\nOr paste multiple lines like:\nCorn | 58\nSoybean meal | 28`
    );
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  // Manual add ingredient name
  if (session.state === "C1_MANUAL_ADD_NAME") {
    session.data.pendingName = raw;
    session.state = "C1_MANUAL_ADD_INCLUSION";
    setSession(from, session);
    twiml.message(`Inclusion % for "${session.data.pendingName}"? (example: 58 or 1.2)`);
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  // Manual add inclusion
  if (session.state === "C1_MANUAL_ADD_INCLUSION") {
    const inc = safeNum(raw);
    if (inc === null) {
      twiml.message(`Please send a number for inclusion % (example: 58 or 1.2).`);
      res.type("text/xml");
      return res.send(twiml.toString());
    }
    const name = session.data.pendingName;
    session.data.items = session.data.items || [];
    session.data.items.push({ name, inclusion: inc });
    delete session.data.pendingName;
    session.state = "C1_MANUAL_HOME";
    setSession(from, session);
    twiml.message(`✅ Added: ${name} = ${inc}%\n\n${listItems(session.data.items)}\n\nType ADD to add more, or DONE to analyze.`);
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  // Fallback
  twiml.message(`✅ Received: "${raw}"\n\nType MENU to return to main menu.`);
  res.type("text/xml");
  res.send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NutriPilot AI running on port ${PORT}`));
