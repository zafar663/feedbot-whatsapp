require("dotenv").config();
const express = require("express");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

// Versioned health check so you know which code is live
app.get("/", (req, res) => {
  res.status(200).send("NutriPilot AI router v2 ✅");
});

/** In-memory session state */
const sessions = new Map(); // key = WhatsApp number, value = { state: "MAIN" | "CORE1" | ... }

function getState(from) {
  return sessions.get(from)?.state || "MAIN";
}
function setState(from, state) {
  sessions.set(from, { state });
}
function reset(from) {
  setState(from, "MAIN");
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
  `Reply 1 for now, or type BACK / MENU.`;

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

/** Helper: robustly extract first menu number from any message */
function firstDigitChoice(text) {
  const m = (text || "").trim().match(/^([1-9])/); // first character is a digit 1-9
  return m ? m[1] : null;
}

app.post("/whatsapp", (req, res) => {
  const from = req.body.From || "unknown";
  const raw = (req.body.Body || "").trim();
  const msg = raw.toLowerCase();

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

  const state = getState(from);
  const choice = firstDigitChoice(raw); // <- IMPORTANT: parse first digit reliably

  // MAIN selection
  if (state === "MAIN") {
    if (choice === "1") {
      setState(from, "CORE1");
      twiml.message(CORE1_MENU);
    } else if (choice === "2") {
      setState(from, "CORE2");
      twiml.message(CORE2_MENU);
    } else if (choice === "3") {
      setState(from, "CORE3");
      twiml.message(CORE3_MENU);
    } else if (choice === "4") {
      setState(from, "CORE4");
      twiml.message(CORE4_MENU);
    } else if (choice === "5") {
      setState(from, "CORE5");
      twiml.message(CORE5_MENU);
    } else {
      twiml.message(`✅ Received: "${raw}"\n\n${MAIN_MENU}`);
    }

    res.type("text/xml");
    return res.send(twiml.toString());
  }

  // Core submenus (MVP: show submenu again, start only CORE1 option 1)
  if (state === "CORE1") {
    if (choice === "1") {
      twiml.message(
        `✅ Starting: Build a new formula (MVP)\n\n` +
          `Next we’ll ask species + phase + available ingredients.\n\n` +
          `Type BACK / MENU anytime.`
      );
    } else {
      twiml.message(CORE1_MENU);
    }
  } else if (state === "CORE2") {
    twiml.message(CORE2_MENU);
  } else if (state === "CORE3") {
    twiml.message(CORE3_MENU);
  } else if (state === "CORE4") {
    twiml.message(CORE4_MENU);
  } else if (state === "CORE5") {
    twiml.message(CORE5_MENU);
  } else {
    reset(from);
    twiml.message(MAIN_MENU);
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NutriPilot AI running on port ${PORT}`));
