const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

app.post("/whatsapp", (req, res) => {
  const incomingMsg = req.body.Body || "No message";

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(`FeedBot received: ${incomingMsg}`);

  res.type("text/xml");
  res.send(twiml.toString());
});

app.get("/", (req, res) => {
  res.send("FeedBot backend is running ✅");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("FeedBot running"));
