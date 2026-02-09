const { analyzeFormula } = require("../core/engine/analyzeFormula");

function preprocessFormulaText(text) {
  if (!text || typeof text !== "string") return "";

  // Convert commas and semicolons to new lines (parser-friendly)
  let t = text.replace(/,\s*/g, "\n");
  t = t.replace(/;\s*/g, "\n");

  // Clean extra spaces on each line
  t = t
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return t;
}

function analyzeFromText(text) {
  const cleaned = preprocessFormulaText(text);
  return analyzeFormula({ formula_text: cleaned });
}

module.exports = { analyzeFromText };
