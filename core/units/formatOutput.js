// core/units/formatOutput.js
const unitProfiles = require("./unitProfiles.v0.json");

// Conversions
function kcalPerKg_to_MJPerKg(kcalPerKg) {
  // 1 kcal = 0.004184 MJ
  return kcalPerKg * 0.004184;
}

function formatEnergyME(meKcalPerKg, targetUnit) {
  if (targetUnit === "MJ/kg") {
    return { value: +kcalPerKg_to_MJPerKg(meKcalPerKg).toFixed(3), unit: "MJ/kg" };
  }
  // default kcal/kg
  return { value: +meKcalPerKg.toFixed(1), unit: "kcal/kg" };
}

function formatPercent(val) {
  return { value: +val.toFixed(4), unit: "%" };
}

function formatOutputCanonicalToLocale(nutrientProfileCanonical, locale = "US") {
  const profile = unitProfiles[locale] || unitProfiles["US"];

  const canonical = { ...(nutrientProfileCanonical || {}) };
  const unknown = canonical.unknown || [];
  delete canonical.unknown;

  const out = {
    locale,
    energy: {},
    nutrients_percent: {},
    unknown
  };

  // Energy
  if (typeof canonical.me === "number") {
    const meUnit = profile.energy?.me || "kcal/kg";
    out.energy.me = formatEnergyME(canonical.me, meUnit);
  }

  // Percent nutrients (current engine outputs these keys)
  const percentKeys = ["cp", "lys", "met", "thr", "ca", "avp", "na"];
  for (const k of percentKeys) {
    if (typeof canonical[k] === "number") {
      out.nutrients_percent[k] = formatPercent(canonical[k]);
    }
  }

  return out;
}

module.exports = { formatOutputCanonicalToLocale };
