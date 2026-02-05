require("dotenv").config();
const express = require("express");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

app.get("/", (req, res) => {
  res.status(200).send("NutriPilot AI router v3 + Core1 intake v1 ✅");
});

/** Session store */
const sessions = new Map(); // key=From, value={ state, data }

function getSession(from) {
  return sessions.get(from) || { state: "MAIN", data: {} };
}
function setSession(from, session) {
  sessions.set(from, session);
}
function reset(from) {
  setSession(from, { state: "MAIN", data: {} });
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

const CORE2_MENU =
  `Performance & Production Intelligence\n\n` +
  `1) Broiler performance issue\n` +
  `2) Layer performance issue\n` +
  `3) General production diagnosis\n\n` +
  `Type BACK / MENU.`;

const CORE3_MENU =
  `Raw Materials, Feed Mill & Quality\n\n` +
  `1) Ingredient inclusion limits\n` +
  `2) Mycotoxin / raw material risk\n` +
  `3) Pellet quality / milling issues\n\n` +
  `Type BACK / MENU.`;

const CORE4_MENU =
  `Expert Review\n\n` +
  `1) Submit a case for expert review\n` +
  `2) What information to provide\n\n` +
  `Type BACK / MENU.`;

const CORE5_MENU =
  `Nutrition Partner Program\n\n` +
  `1) What you get (scope)\n` +
  `2) Onboarding steps (next)\n\n` +
  `Type BACK / MENU.`;

/** Helpers */
function firstDigitChoice(text) {
  const m = (text || "").trim().match(/^([1-9])/);
  return m ? m[1] : null;
}
function normalizeList(text) {
  return (text || "")
    .split(/[,;\n]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 12);
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

  const session = getSession(from);

  /** MAIN routing */
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

  /** CORE MENUS */
  if (session.state === "CORE1_MENU") {
    if (choice === "1") {
      session.state = "C1_NEW_SPECIES";
      session.data = {};
      setSession(from, session);
      twiml.message(
        `Build a new formula (MVP)\n\n` +
          `Step 1/4: Choose species/category:\n` +
          `1) Broiler\n` +
          `2) Layer\n` +
          `3) Swine\n` +
          `4) Dairy\n\n` +
          `Reply 1–4.`
      );
    } else {
      twiml.message(CORE1_MENU);
    }
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  if (session.state === "CORE2_MENU") {
    twiml.message(CORE2_MENU);
    res.type("text/xml");
    return res.send(twiml.toString());
  }
  if (session.state === "CORE3_MENU") {
    twiml.message(CORE3_MENU);
    res.type("text/xml");
    return res.send(twiml.toString());
  }
  if (session.state === "CORE4_MENU") {
    twiml.message(CORE4_MENU);
    res.type("text/xml");
    return res.send(twiml.toString());
  }
  if (session.state === "CORE5_MENU") {
    twiml.message(CORE5_MENU);
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  /** CORE 1 Intake Flow: New Formula (4 steps) */
  if (session.state === "C1_NEW_SPECIES") {
    const map = { "1": "Broiler", "2": "Layer", "3": "Swine", "4": "Dairy" };
    if (!map[choice]) {
      twiml.message(`Please reply 1–4.\n\n` + `1) Broiler  2) Layer  3) Swine  4) Dairy`);
    } else {
      session.data.species = map[choice];
      session.state = "C1_NEW_PHASE";
      setSession(from, session);

      // Phase options based on species (MVP)
      if (session.data.species === "Broiler") {
        twiml.message(
          `Step 2/4: Select phase:\n` +
            `1) Starter\n` +
            `2) Grower\n` +
            `3) Finisher\n\n` +
            `Reply 1–3.`
        );
      } else if (session.data.species === "Layer") {
        twiml.message(
          `Step 2/4: Select phase:\n` +
            `1) Pre-lay\n` +
            `2) Peak\n` +
            `3) Post-peak\n\n` +
            `Reply 1–3.`
        );
      } else {
        twiml.message(
          `Step 2/4: Enter the phase/stage (example: starter / grower / lactation / gestation):`
        );
      }
    }
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  if (session.state === "C1_NEW_PHASE") {
    const s = session.data.species;

    if (s === "Broiler") {
      const map = { "1": "Starter", "2": "Grower", "3": "Finisher" };
      if (!map[choice]) {
        twiml.message(`Reply 1–3.\n\n1) Starter  2) Grower  3) Finisher`);
      } else {
        session.data.phase = map[choice];
        session.state = "C1_NEW_FORM";
        setSession(from, session);
        twiml.message(
          `Step 3/4: Feed form?\n` +
            `1) Mash\n` +
            `2) Pellet\n` +
            `3) Crumble\n\n` +
            `Reply 1–3.`
        );
      }
    } else if (s === "Layer") {
      const map = { "1": "Pre-lay", "2": "Peak", "3": "Post-peak" };
      if (!map[choice]) {
        twiml.message(`Reply 1–3.\n\n1) Pre-lay  2) Peak  3) Post-peak`);
      } else {
        session.data.phase = map[choice];
        session.state = "C1_NEW_FORM";
        setSession(from, session);
        twiml.message(
          `Step 3/4: Feed form?\n` +
            `1) Mash\n` +
            `2) Pellet\n\n` +
            `Reply 1–2.`
        );
      }
    } else {
      // free text stage for Swine/Dairy MVP
      session.data.phase = raw;
      session.state = "C1_NEW_FORM";
      setSession(from, session);
      twiml.message(
        `Step 3/4: Feed form?\n` +
          `1) Mash\n` +
          `2) Pellet\n` +
          `3) Meal\n\n` +
          `Reply 1–3.`
      );
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
    session.state = "C1_NEW_INGREDIENTS";
    setSession(from, session);

    twiml.message(
      `Step 4/4: List available ingredients (comma separated).\n` +
        `Example: corn, soybean meal, DDGS, oil, limestone, DCP, salt.\n\n` +
        `Send your list now:`
    );

    res.type("text/xml");
    return res.send(twiml.toString());
  }

  if (session.state === "C1_NEW_INGREDIENTS") {
    const items = normalizeList(raw);
    if (items.length < 2) {
      twiml.message(
        `Please send at least 2 ingredients, separated by commas.\n` +
          `Example: corn, soybean meal, oil`
      );
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    session.data.ingredients = items;

    // Summary output (MVP result)
    const summary =
      `✅ New Formula Request Captured (MVP)\n\n` +
      `Species: ${session.data.species}\n` +
      `Phase: ${session.data.phase}\n` +
      `Feed form: ${session.data.feedForm}\n` +
      `Ingredients: ${session.data.ingredients.join(", ")}\n\n` +
      `Next: We will add nutrient targets + draft formula logic.\n\n` +
      `Reply MENU to start over, or type 1 to go back to Core 1 menu.`;

    // After summary, return user to CORE1_MENU context
    session.state = "CORE1_MENU";
    setSession(from, session);
    twiml.message(summary);

    res.type("text/xml");
    return res.send(twiml.toString());
  }

  /** Fallback */
  twiml.message(`✅ Received: "${raw}"\n\nType MENU to return to main menu.`);
  res.type("text/xml");
  res.send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NutriPilot AI running on port ${PORT}`));
