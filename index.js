try { require("dotenv").config(); } catch (e) {}

const express = require("express");
const twilio = require("twilio");

const app = express();

// Twilio sends x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

const MAIN_MENU =
`NutriPilot AI ✅ (Connectivity Test)

Reply 1 to confirm.

1) Menu Reply Test`;

app.get("/", (req, res) => {
  res.status(200).send("NutriPilot AI ✅ Connectivity Test running");
});

// Accept BOTH endpoints (Twilio sandbox sometimes posts to either)
app.post(["/", "/whatsapp"], (req, res) => {
  const body = (req.body.Body || "").trim().toLowerCase();
  const twiml = new twilio.twiml.MessagingResponse();

  if (!body || ["hi", "hello", "menu", "start"].includes(body)) {
    twiml.message(MAIN_MENU);
  } else {
    twiml.message(`✅ Received: "${req.body.Body}"\n\n${MAIN_MENU}`);
  }

  res.set("Content-Type", "text/xml");
  res.status(200).send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("NutriPilot AI ✅ Connectivity Test listening on", PORT));
