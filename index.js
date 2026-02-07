require("dotenv").config();
const express = require("express");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

const VERSION = "NutriPilot vSafeReply ✅";

const MENU =
`NutriPilot AI

1) Formulation & Diet Control
2) Performance & Production Intelligence
3) Raw Materials, Feed Mill & Quality
4) Expert Review
5) Nutrition Partner Program

Reply with a number or type MENU.`;

// HARD SAFE RESPONDER
function reply(res, message) {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(message);
  res.status(200);
  res.set("Content-Type", "text/xml");
  return res.send(twiml.toString());
}

app.get("/", (_, res) =>
  res.send(`Feedbot is running ✅\n${VERSION}`)
);

app.post("/whatsapp", (req, res) => {
  const body = (req.body.Body || "").trim();
  const msg = body.toLowerCase();
  const from = req.body.From;

  console.log(`[WA] ${from}: ${body}`);

  // RESPOND FIRST — NO LOGIC HERE
  if (!body || ["hi", "hello", "menu", "start"].includes(msg)) {
    return reply(res, MENU);
  }

  // simple echo to confirm stability
  return reply(res, `✅ Received "${body}"\n\n${MENU}`);
});

// IMPORTANT: Render port binding
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`NutriPilot running on port ${PORT} — ${VERSION}`)
);
