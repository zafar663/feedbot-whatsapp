// core/calc/applyLabOverrides.js

const ALLOWED_KEYS = ["me", "cp", "lys", "met", "thr", "ca", "avp", "na"];

function applyLabOverrides(ingredientsDB, labOverrides) {
  const base = ingredientsDB || {};
  const overrides = labOverrides || {};

  // shallow clone DB (don’t mutate original)
  const merged = { ...base };

  for (const ing of Object.keys(overrides)) {
    const ov = overrides[ing];
    if (!ov || typeof ov !== "object") continue;

    const baseRow = base[ing];
    if (!baseRow) continue; // if ingredient not in DB, ignore override

    const newRow = { ...baseRow };

    for (const k of ALLOWED_KEYS) {
      if (ov[k] === undefined || ov[k] === null) continue;
      const v = Number(ov[k]);
      if (Number.isFinite(v)) newRow[k] = v;
    }

    merged[ing] = newRow;
  }

  return merged;
}

module.exports = { applyLabOverrides };
