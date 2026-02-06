try { require("dotenv").config(); } catch (e) {}

const express = require("express");
const twilio = require("twilio");

const app = express();

// Twilio sends x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

const VERSION = "NutriPilot AI v3 – Formula Review Intake Stable ✅";

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

Reply with a number or type MENU.`;

const FORMULATION_MENU =
`Formulation & Diet Control

1) Formula review (MVP)
2) Reformulation (next)
3) Diet approval / risk check (next)
4) Additives & enzymes guidance (next)

Reply 1 for now, or type MENU.`;

const FORMULA_REVIEW_INPUT =
`Formula Review – Submit your diet

Choose how you want to submit the formula:

1) Paste full formula (any format)
2) Manual entry (% only)
3) Upload file (Excel / CSV – coming next)
4) Upload photo (coming next)

Reply 1 or 2 for now, or type MENU.`;

/* =========================
   HEALTH CHECK
========================= */
app.get(["/", "/whatsapp"], (req, res) => {
  res.status(200).send(VERSION);
});

/* =========================
   WHATSAPP WEBHOOK
========================= */
app.post(["/", "/whatsapp"], (req, res) => {
  const raw = req.body.Body || "";
  const msg = raw.trim().toLowerCase();
  const twiml = new twilio.twiml.MessagingResponse();

  // Global commands
  if (!msg || ["hi", "hello", "menu", "start"].includes(msg)) {
    twiml.message(MAIN_MENU);
    return res.type("text/xml").send(twiml.toString());
  }

  // MAIN MENU
  if (msg === "1") {
    twiml.message(FORMULATION_MENU);
    return res.type("text/xml").send(twiml.toString());
  }

  // FORMULATION MENU
  if (msg === "1" || msg === "formula review") {
    twiml.message(FORMULA_REVIEW_INPUT);
    return res.type("text/xml").send(twiml.toString());
  }

  // FORMULA REVIEW INPUT (ack only)
  if (msg === "1") {
    twiml.message(
      "✅ Paste your full formula now.\n\n" +
      "Example:\nCorn 58; SBM44% 28; Oil 3; Salt 0.3\n\n" +
      "Type MENU to cancel."
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (msg === "2") {
    twiml.message(
      "✅ Manual entry selected.\n\n" +
      "You’ll enter ingredient name and %.\n\n" +
      "Type MENU to cancel."
    );
    return res.type("text/xml").send(twiml.toString());
  }

  // Fallback
  twiml.message(
    "Please choose a valid option.\n\n" +
    "Type MENU to restart."
  );
  return res.type("text/xml").send(twiml.toString());
});

/* =========================
   SERVER
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(VERSION));
