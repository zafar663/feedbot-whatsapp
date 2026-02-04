require("dotenv").config();
const express = require("express");
const twilio = require("twilio");

const app = express();

// Twilio sends data as application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

app.get("/", (req, res) => {
  res.status(200).send("Feedbot is running ✅");
});

app.post("/whatsapp", (req, res) => {
  try {
    const incomingMsg = (req.body.Body || "").trim().toLowerCase();

    const menu =
      `Please choose an option:\n\n` +
      `1) Nutrition & Feed Formulation\n` +
      `2) Production Problems & Troubleshooting\n` +
      `3) Feed Quality, Ingredients & Management\n` +
      `4) Ask an Expert`;

    const twiml = new twilio.twiml.MessagingResponse();

    // Always reply something (so Twilio doesn't mark it failed)
    if (!incomingMsg || ["hi", "hello", "start", "menu"].includes(incomingMsg)) {
      twiml.message(menu);
    } else {
      twiml.message(`✅ Received: "${req.body.Body}"\n\n${menu}`);
    }

    res.set("Content-Type", "text/xml");
    res.status(200).send(twiml.toString());
  } catch (err) {
    // Even on error, reply TwiML so Twilio doesn't fail silently
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("⚠️ Feedbot error. Please try again.");
    res.set("Content-Type", "text/xml");
    res.status(200).send(twiml.toString());
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Feedbot running on port ${PORT}`));
