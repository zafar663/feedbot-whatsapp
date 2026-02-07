require("dotenv").config();
const express = require("express");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

const VERSION = "NutriPilot Reply-Wrapper v1 ✅";
const MENU =
  `NutriPilot AI\n\n` +
  `How can we help you today?\n\n` +
  `1) Formulation & Diet Control\n` +
  `2) Performance & Production Intelligence\n` +
  `3) Raw Materials, Feed Mill & Quality\n` +
  `4) Expert Review\n` +
  `5) Nutrition Partner Program\n\n` +
  `Reply with a number or type MENU.`;

function sendTwiml(res, twiml) {
  res.status(200);
  res.set("Content-Type", "text/xml");
  res.send(twiml.toString());
}

app.get("/", (req, res) => res.status(200).send(`Feedbot is running ✅\n${VERSION}`));

app.get("/whatsapp", (req, res) => {
  res.status(200).send(
    `NutriPilot WhatsApp webhook is LIVE ✅\n\n` +
    `Twilio must POST here:\n` +
    `https://feedbot-whatsapp.onrender.com/whatsapp\n\n` +
    `${VERSION}`
  );
});

app.post("/whatsapp", (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  try {
    const from = req.body.From || "unknown";
    const raw = (req.body.Body || "").trim();
    const msg = (raw || "").toLowerCase().trim();

    console.log(`[WA] from=${from} body="${raw}"`);

    // Always reply
    if (!raw || ["hi", "hello", "start", "menu"].includes(msg)) {
      twiml.message(MENU);
      return sendTwiml(res, twiml);
    }

    twiml.message(`✅ Received: "${raw}"\n\n${MENU}`);
    return sendTwiml(res, twiml);
  } catch (e) {
    console.error("Webhook error:", e);
    twiml.message("⚠️ NutriPilot error. Type MENU and try again.");
    return sendTwiml(res, twiml);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NutriPilot running on port ${PORT} — ${VERSION}`));
