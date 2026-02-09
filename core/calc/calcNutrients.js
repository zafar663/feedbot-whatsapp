// core/calc/calcNutrients.js

function calcNutrients(items, ingredientsDB) {
  const keys = ["me", "cp", "lys", "met", "thr", "ca", "avp", "na"];

  const out = {};
  for (const k of keys) out[k] = 0;

  const unknown = [];

  for (const it of items) {
    const ing = ingredientsDB[it.ingredient];
    if (!ing) {
      unknown.push({ ingredient: it.ingredient, inclusion: it.inclusion });
      continue;
    }

    for (const k of keys) {
      const v = Number(ing[k]);
      if (Number.isFinite(v)) {
        out[k] += (it.inclusion * v) / 100;
      }
    }
  }

  return { ...out, unknown };
}

module.exports = { calcNutrients };
