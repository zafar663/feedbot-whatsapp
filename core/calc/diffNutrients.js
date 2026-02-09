// core/calc/diffNutrients.js

const KEYS = ["me", "cp", "lys", "met", "thr", "ca", "avp", "na"];

function diffNutrients(before, after) {
  const out = {};

  for (const k of KEYS) {
    const b = Number(before?.[k]);
    const a = Number(after?.[k]);

    if (!Number.isFinite(b) || !Number.isFinite(a)) continue;

    const diff = a - b;
    out[k] = {
      before: +b.toFixed(4),
      after: +a.toFixed(4),
      diff: +diff.toFixed(4)
    };
  }

  return out;
}

module.exports = { diffNutrients };
