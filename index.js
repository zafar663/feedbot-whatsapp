require("dotenv").config();
const express = require("express");
const twilio = require("twilio");

const app = express();

// Twilio sends WhatsApp data as form-urlencoded
app.use(express.urlencoded({ extended: false }));

// Health check (Render / browser)
app.get("/", (req, res) => {
  res.status(200).send("NutriPilot AI is running ✅");
});

// WhatsApp webhook
app.post("/whatsapp", (req, res) => {
  const incomingMsg = (req.body.Body || "").trim().toLowerCase();

  const menu =
    `NutriPilot AI\n\n` +
    `How can we help you today?\n\n` +
    `1) Formulation & Diet Control\n` +
    `2) Performance & Production Intelligence\n` +
    `3) Raw Materials, Feed Mill & Quality\n` +
    `4) Expert Review\n` +
    `5) Nutrition Partner Program`;

  const twiml = new twilio.twiml.MessagingResponse();

  // Show menu on greeting or menu request
  if (
    incomingMsg === "" ||
    incomingMsg === "hi" ||
    incomingMsg === "hello" ||
    incomingMsg === "start" ||
    incomingMsg === "menu"
  ) {
    twiml.message(menu);
  } else {
    // For now, always echo and show menu again
    twiml.message(`✅ Received: "${req.body.Body}"\n\n${menu}`);
  }

  res.set("Content-Type", "text/xml");
  res.status(200).send(twiml.toString());
});

// Render requires this
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NutriPilot AI running on port ${PORT}`);
});
