try { require("dotenv").config(); } catch (e) {}

const express = require("express");
const twilio = require("twilio");

const app = express();

// Twilio sends x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

const VERSION = "NutriPilot AI v1 – Main Menu Stable ✅";

const MAIN_MENU =
`NutriPilot AI

How can we help you today?

1) Formulation & Diet Control
2) Performance & Production Intelligence
3) Raw Materials, Feed Mill & Quality
4) Expert Review
5) Nutrition Partner Program

Reply with a number or type MENU.`;

// Health check (browser)
app.get(["/", "/whatsapp"], (req, res) => {
  res.status(200).send(VERSION);
});

// WhatsApp webhook (accept both / and /whatsapp)
app.post(["/", "/whatsapp"], (req, res) => {
  const body = (req.body.Body || "").trim().toLowerCase();
  const twiml = new twilio.twiml.MessagingResponse();

  // Always respond
  if (!body || ["hi", "hello", "menu", "start"].includes(body)) {
    twiml.message(MAIN_MENU);
  } else {
    twiml.message(`✅ Received: "${req.body.Body}"\n\n${MAIN_MENU}`);
  }

  res.set("Content-Type", "text/xml");
  res.status(200).send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(VERSION));
