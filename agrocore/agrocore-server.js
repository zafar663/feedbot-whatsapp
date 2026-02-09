const express = require("express");
const cors = require("cors");

// ✅ adapter that preprocesses text and calls the real engine
const { analyzeFromText } = require("./engine");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("AgroCore API running ✅");
});

app.get("/v1/health", (req, res) => {
  res.json({ ok: true, message: "AgroCore API running ✅" });
});

/**
 * POST /v1/analyze
 * Accepts:
 *  - { text: "corn 60, soybean meal 30" }
 *  - { formula_text: "corn 60\nsoybean meal 30" }
 */
app.post("/v1/analyze", (req, res) => {
  try {
    const body = req.body || {};
    const text = body.text || body.formula_text;

    if (!text || typeof text !== "string") {
      return res.status(400).json({
        ok: false,
        error: "Send 'text' (or 'formula_text')"
      });
    }

    const result = analyzeFromText(text);
    return res.json(result);
  } catch (err) {
    console.error("AgroCore error:", err.message);
    return res.status(400).json({ ok: false, error: err.message });
  }
});

// ✅ Render provides PORT automatically
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 AgroCore API running on port ${PORT}`));
