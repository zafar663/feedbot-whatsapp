require("dotenv").config();
const express = require("express");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

app.get("/", (req, res) => {
  res.status(200).send("Feedbot is running ✅");
});

// --- Simple in-memory session (resets if Render restarts; OK for now) ---
const sessions = new Map(); // key: phone number, value: { state, data }

function getSessionKey(from) {
  return from || "unknown";
}

function setSession(from, patch) {
  const key = getSessionKey(from);
  const prev = sessions.get(key) || { state: "MAIN_MENU", data: {} };
  const next = { ...prev, ...patch, data: { ...prev.data, ...(patch.data || {}) } };
  sessions.set(key, next);
  return next;
}

function resetSession(from) {
  const key = getSessionKey(from);
  sessions.set(key, { state: "MAIN_MENU", data: {} });
}

function mainMenuText() {
  return (
    "Please choose an option:\n\n" +
    "1) Nutrition & Feed Formulation\n" +
    "2) Production Problems & Troubleshooting\n" +
    "3) Feed Quality, Ingredients & Management\n" +
    "4) Ask an Expert\n\n" +
    "Type MENU anytime to come back here."
  );
}

function area1MenuText() {
  return (
    "Nutrition & Feed Formulation — choose one:\n\n" +
    "1) Nutrient requirements\n" +
    "2) Feed formulation guidance (coming next)\n" +
    "3) Ingredient inclusion limits (coming next)\n" +
    "4) Additives & enzymes (coming next)\n" +
    "5) Cost optimization (coming next)\n" +
    "6) Special diets & situations (coming next)\n\n" +
    "Type MENU anytime for main menu."
  );
}

function nutrientMethodText() {
  return (
    "Nutrient requirements — choose method:\n\n" +
    "1) Preset guideline (coming next)\n" +
    "2) Generic commercial targets\n\n" +
    "Reply 2 for Generic now."
  );
}

function genericSpeciesText() {
  return (
    "Generic targets — choose species:\n\n" +
    "1) Broiler\n" +
    "2) Layer\n\n" +
    "Reply 1 or 2."
  );
}

function broilerPhaseText() {
  return (
    "Broiler — choose phase:\n\n" +
    "1) Starter (0–10d)\n" +
    "2) Grower (coming next)\n" +
    "3) Finisher (coming next)\n\n" +
    "Reply 1 for Starter now."
  );
}

function layerPhaseText() {
  return (
    "Layer — choose phase:\n\n" +
    "1) Peak production\n" +
    "2) Pre-lay (coming next)\n" +
    "3) Post-peak (coming next)\n\n" +
    "Reply 1 for Peak now."
  );
}

// --- Generic nutrient targets (Phase 1: minimal set) ---
function genericBroilerStarterReply() {
  return (
    "✅ Generic Broiler Starter (0–10 days) — target ranges:\n\n" +
    "ME: 2950–3050 kcal/kg\n" +
    "CP: 21–23%\n" +
    "Dig Lys: 1.20–1.30%\n" +
    "Dig Met+Cys: 0.90–0.98%\n" +
    "Dig Thr: 0.78–0.85%\n" +
    "Ca: 0.90–1.00%\n" +
    "AvP: 0.45–0.50%\n" +
    "Na: 0.16–0.18%\n\n" +
    "Quick check: pellet quality + chick intake.\n" +
    "Next: Tell me your strain (Ross/Cobb/etc.) and feed form (mash/pellet) for tighter targets.\n\n" +
    "Type AREA1 to go back, or MENU for main menu."
  );
}

function genericLayerPeakReply() {
  return (
    "✅ Generic Layer Peak — target ranges:\n\n" +
    "ME: 2750–2850 kcal/kg (intake-driven)\n" +
    "CP: 16–18%\n" +
    "Dig Met: 0.38–0.42%\n" +
    "Dig Met+Cys: 0.65–0.72%\n" +
    "Dig Lys: 0.78–0.85%\n" +
    "Ca: 3.8–4.2% (include coarse limestone)\n" +
    "AvP: 0.38–0.45%\n" +
    "Na: 0.16–0.20%\n" +
    "Linoleic acid: 1.6–2.0% (egg size)\n\n" +
    "Quick check: daily feed intake + limestone particle size.\n" +
    "Next: Share age (weeks) + intake (g/b/d) for better precision.\n\n" +
    "Type AREA1 to go back, or MENU for main menu."
  );
}

function normalize(msg) {
  return (msg || "").trim().toLowerCase();
}

app.post("/whatsapp", (req, res) => {
  const from = req.body.From;
  const incomingRaw = req.body.Body;
  const msg = normalize(incomingRaw);

  const twiml = new twilio.twiml.MessagingResponse();

  // Global commands
  if (msg === "menu") {
    resetSession(from);
    twiml.message(mainMenuText());
    res.set("Content-Type", "text/xml");
    return res.status(200).send(twiml.toString());
  }
  if (msg === "area1") {
    setSession(from, { state: "AREA1_MENU" });
    twiml.message(area1MenuText());
    res.set("Content-Type", "text/xml");
    return res.status(200).send(twiml.toString());
  }
  if (["hi", "hello", "start"].includes(msg)) {
    resetSession(from);
    twiml.message(mainMenuText());
    res.set("Content-Type", "text/xml");
    return res.status(200).send(twiml.toString());
  }

  const session = sessions.get(getSessionKey(from)) || { state: "MAIN_MENU", data: {} };

  // State machine
  switch (session.state) {
    case "MAIN_MENU": {
      if (msg === "1") {
        setSession(from, { state: "AREA1_MENU" });
        twiml.message(area1MenuText());
      } else if (msg === "2" || msg === "3" || msg === "4") {
        twiml.message("✅ Coming next. Type MENU to return to main menu.");
      } else {
        twiml.message(mainMenuText());
      }
      break;
    }

    case "AREA1_MENU": {
      if (msg === "1") {
        setSession(from, { state: "AREA1_NUTRIENT_METHOD" });
        twiml.message(nutrientMethodText());
      } else {
        twiml.message("✅ Coming next. For now, reply 1 for Nutrient requirements.\n\n" + area1MenuText());
      }
      break;
    }

    case "AREA1_NUTRIENT_METHOD": {
      if (msg === "2") {
        setSession(from, { state: "AREA1_GENERIC_SPECIES" });
        twiml.message(genericSpeciesText());
      } else {
        twiml.message("For now, reply 2 for Generic commercial targets.\n\n" + nutrientMethodText());
      }
      break;
    }

    case "AREA1_GENERIC_SPECIES": {
      if (msg === "1") {
        setSession(from, { state: "AREA1_GENERIC_BROILER_PHASE", data: { species: "broiler" } });
        twiml.message(broilerPhaseText());
      } else if (msg === "2") {
        setSession(from, { state: "AREA1_GENERIC_LAYER_PHASE", data: { species: "layer" } });
        twiml.message(layerPhaseText());
      } else {
        twiml.message(genericSpeciesText());
      }
      break;
    }

    case "AREA1_GENERIC_BROILER_PHASE": {
      if (msg === "1") {
        setSession(from, { state: "AREA1_MENU" }); // return to Area1 menu after answer
        twiml.message(genericBroilerStarterReply());
      } else {
        twiml.message("For now, reply 1 for Starter.\n\n" + broilerPhaseText());
      }
      break;
    }

    case "AREA1_GENERIC_LAYER_PHASE": {
      if (msg === "1") {
        setSession(from, { state: "AREA1_MENU" }); // return to Area1 menu after answer
        twiml.message(genericLayerPeakReply());
      } else {
        twiml.message("For now, reply 1 for Peak.\n\n" + layerPhaseText());
      }
      break;
    }

    default: {
      resetSession(from);
      twiml.message(mainMenuText());
      break;
    }
  }

  res.set("Content-Type", "text/xml");
  res.status(200).send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Feedbot running on port ${PORT}`));
