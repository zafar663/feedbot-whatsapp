try { require("dotenv").config(); } catch (e) {}

const express = require("express");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

const VERSION = "NutriPilot AI v5 – Keyword-based (stable) ✅";

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

Type one of the following commands:

REVIEW   – Formula review (MVP)
REFORM   – Reformulation (next)
APPROVE  – Diet approval / risk check (next)
ADDITIVE – Additives & enzymes guidance (next)

Type MENU anytime.`;

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
  const msg = raw.trim().toUpperCase();

  const twiml = new twilio.twiml.MessagingResponse();

  // Global commands
  if (!msg || ["HI", "HELLO", "MENU", "START"].includes(msg)) {
    twiml.message(MAIN_MENU);
    return res.type("text/xml").send(twiml.toString());
  }

  // Main menu
  if (msg === "1") {
    twiml.message(FORMULATION_MENU);
    return res.type("text/xml").send(twiml.toString());
  }

  // Keyword-based routing (STATELESS)
  if (msg === "REVIEW") {
    twiml.message(
      `Formula Review – Submit your diet\n\n` +
      `Paste your full formula now (any format).\n\n` +
      `Example:\nCorn 58; SBM44% 28; Oil 3; Salt 0.3\n\n` +
      `Type MENU to cancel.`
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (msg === "REFORM") {
    twiml.message(
      `Reformulation support (coming next).\n\n` +
      `This module will suggest cost- and performance-driven reformulations.\n\n` +
      `Type MENU to return.`
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (msg === "APPROVE") {
    twiml.message(
      `Diet approval & risk check (coming next).\n\n` +
      `This will validate compliance, safety margins, and production risks.\n\n` +
      `Type MENU to return.`
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (msg === "ADDITIVE") {
    twiml.message(
      `Additives & enzymes guidance (coming next).\n\n` +
      `This module will evaluate enzyme fit, ROI, and inclusion strategy.\n\n` +
      `Type MENU to return.`
    );
    return res.type("text/xml").send(twiml.toString());
  }

  // Fallback
  twiml.message(
    `Unrecognized input.\n\n` +
    `Type MENU to see available options.`
  );
  return res.type("text/xml").send(twiml.toString());
});

/* =========================
   SERVER
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(VERSION));
