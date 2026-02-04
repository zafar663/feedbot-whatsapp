require("dotenv").config();
const express = require("express");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

app.get("/", (req, res) => {
  res.status(200).send("Feedbot is running ✅");
});

/* ---------------- Session Store (simple, in-memory) ---------------- */
const sessions = new Map(); // key: WhatsApp number

function getSession(from) {
  return sessions.get(from) || { state: "MAIN_MENU" };
}

function setSession(from, state) {
  sessions.set(from, { state });
}

function resetSession(from) {
  sessions.set(from, { state: "MAIN_MENU" });
}

/* ---------------- Text Blocks ---------------- */

const MAIN_MENU =
  "Please choose an option:\n\n" +
  "1) Nutrition & Feed Formulation\n" +
  "2) Production Problems & Troubleshooting\n" +
  "3) Feed Quality, Ingredients & Management\n" +
  "4) Ask an Expert\n\n" +
  "Type MENU anytime to return here.";

const AREA1_MENU =
  "Nutrition & Feed Formulation — choose one:\n\n" +
  "1) Nutrient requirements\n" +
  "2) Feed formulation guidance (coming next)\n" +
  "3) Ingredient inclusion limits (coming next)\n" +
  "4) Additives & enzymes (coming next)\n" +
  "5) Cost optimization (coming next)\n" +
  "6) Special diets & situations (coming next)\n\n" +
  "Type MENU anytime for main menu.";

const METHOD_MENU =
  "Nutrient requirements — choose method:\n\n" +
  "1) Preset guideline (coming next)\n" +
  "2) Generic commercial targets\n\n" +
  "Reply 2 to continue.";

const SPECIES_MENU =
  "Generic targets — choose species:\n\n" +
  "1) Broiler\n" +
  "2) Layer\n\n" +
  "Reply 1 or 2.";

const BROILER_PHASE =
  "Broiler — choose phase:\n\n" +
  "1) Starter (0–10 days)\n" +
  "2) Grower (coming next)\n" +
  "3) Finisher (coming next)\n\n" +
  "Reply 1 to continue.";

const LAYER_PHASE =
  "Layer — choose phase:\n\n" +
  "1) Peak production\n" +
  "2) Pre-lay (coming next)\n" +
  "3) Post-peak (coming next)\n\n" +
  "Reply 1 to continue.";

/* ---------------- Replies ---------------- */

function broilerStarterReply() {
  return (
    "✅ Generic Broiler Starter (0–10 days)\n\n" +
    "ME: 2950–3050 kcal/kg\n" +
    "CP: 21–23%\n" +
    "Digestible Lys: 1.20–1.30%\n" +
    "Digestible Met+Cys: 0.90–0.98%\n" +
    "Digestible Thr: 0.78–0.85%\n" +
    "Calcium: 0.90–1.00%\n" +
    "Available P: 0.45–0.50%\n" +
    "Sodium: 0.16–0.18%\n\n" +
    "Tip: Ensure good pellet quality and early chick intake.\n\n" +
    "Type AREA1 to go back or MENU for main menu."
  );
}

function layerPeakReply() {
  return (
    "✅ Generic Layer Peak Production\n\n" +
    "ME: 2750–2850 kcal/kg\n" +
    "CP: 16–18%\n" +
    "Digestible Met: 0.38–0.42%\n" +
    "Digestible Met+Cys: 0.65–0.72%\n" +
    "Digestible Lys: 0.78–0.85%\n" +
    "Calcium: 3.8–4.2% (include coarse limestone)\n" +
    "Available P: 0.38–0.45%\n" +
    "Sodium: 0.16–0.20%\n" +
    "Linoleic acid: 1.6–2.0%\n\n" +
    "Tip: Monitor daily feed intake and limestone particle size.\n\n" +
    "Type AREA1 to go back or MENU for main menu."
  );
}

/* ---------------- WhatsApp Webhook ---------------- */

app.post("/whatsapp", (req, res) => {
  const from = req.body.From;
  const msg = (req.body.Body || "").trim().toLowerCase();

  const twiml = new twilio.twiml.MessagingResponse();

  /* Global commands */
  if (msg === "menu") {
    resetSession(from);
    twiml.message(MAIN_MENU);
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  if (msg === "area1") {
    setSession(from, "AREA1_MENU");
    twiml.message(AREA1_MENU);
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  if (["hi", "hello", "start"].includes(msg)) {
    resetSession(from);
    twiml.message(MAIN_MENU);
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  const session = getSession(from);

  switch (session.state) {
    case "MAIN_MENU":
      if (msg === "1") {
        setSession(from, "AREA1_MENU");
        twiml.message(AREA1_MENU);
      } else {
        twiml.message(MAIN_MENU);
      }
      break;

    case "AREA1_MENU":
      if (msg === "1") {
        setSession(from, "METHOD_MENU");
        twiml.message(METHOD_MENU);
      } else {
        twiml.message("Coming next.\n\n" + AREA1_MENU);
      }
      break;

    case "METHOD_MENU":
      if (msg === "2") {
        setSession(from, "SPECIES_MENU");
        twiml.message(SPECIES_MENU);
      } else {
        twiml.message(METHOD_MENU);
      }
      break;

    case "SPECIES_MENU":
      if (msg === "1") {
        setSession(from, "BROILER_PHASE");
        twiml.message(BROILER_PHASE);
      } else if (msg === "2") {
        setSession(from, "LAYER_PHASE");
        twiml.message(LAYER_PHASE);
      } else {
        twiml.message(SPECIES_MENU);
      }
      break;

    case "BROILER_PHASE":
      if (msg === "1") {
        setSession(from, "AREA1_MENU");
        twiml.message(broilerStarterReply());
      } else {
        twiml.message(BROILER_PHASE);
      }
      break;

    case "LAYER_PHASE":
      if (msg === "1") {
        setSession(from, "AREA1_MENU");
        twiml.message(layerPeakReply());
      } else {
        twiml.message(LAYER_PHASE);
      }
      break;

    default:
      resetSession(from);
      twiml.message(MAIN_MENU);
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

/* ---------------- Start Server ---------------- */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Feedbot running on port ${PORT}`);
});
