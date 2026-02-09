// core/compare/compareToReqs.js

function compareToReqs(actual, required) {
  const out = {};

  for (const key of Object.keys(required)) {
    const a = Number(actual[key]);
    const r = Number(required[key]);

    if (!Number.isFinite(a) || !Number.isFinite(r)) continue;

    const diff = a - r;
    const pct = r !== 0 ? (diff / r) * 100 : null;

    out[key] = {
      actual: +a.toFixed(4),
      required: +r.toFixed(4),
      diff: +diff.toFixed(4),
      pct: pct === null ? null : +pct.toFixed(2)
    };
  }

  return out;
}

module.exports = { compareToReqs };
