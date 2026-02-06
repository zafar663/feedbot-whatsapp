try { require("dotenv").config(); } catch (e) {}

const express = require("express");
const twilio = require("twilio");

const app = express();

// Twilio sends x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

const VERSION = "NutriPilot AI v2 – Main Menu + Formulation Submenu ✅";

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
  const bodyRaw = req.body.Body || "";
  const body = bodyRaw.trim().toLowerCase();
  const twiml = new twilio.twiml.MessagingResponse();

  // Global commands
  if (!body || ["hi", "hello", "menu", "start"].includes(body)) {
    twiml.message(MAIN_MENU);
    res.type("text/xml").send(twiml.toString());
    return;
  }

  // Main menu selection
  if (body === "1") {
    twiml.message(FORMULATION_MENU);
    res.type("text/xml").send(twiml.toString());
    return;
  }

  // Formulation submenu (only option 1 active)
  if (body === "1" || body === "formula review") {
    twiml.message(
      "✅ Formula review selected.\n\n" +
      "Next step (coming next): submit your formula for analysis.\n\n" +
      "Type MENU to go back."
    );
    res.type("text/xml").send(twiml.toString());
    return;
  }

  // Fallback
  twiml.message(
    "Please reply with a valid option.\n\n" +
    "Type MENU to see available options."
  );
  res.type("text/xml").send(twiml.toString());
});

/* =========================
   SERVER
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(VERSION));
