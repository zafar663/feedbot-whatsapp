const { parseFormulaText } = require("../parser/parseFormulaText");
const { normalizeFormula } = require("../normalize/normalizeFormula");
const { calcNutrients } = require("../calc/calcNutrients");
const { compareToReqs } = require("../compare/compareToReqs");
const { evaluateDeviations } = require("../rules/evaluateDeviations");
const { formatOutputCanonicalToLocale } = require("../units/formatOutput");

const { checkInclusionLimits } = require("../rules/checkInclusionLimits");
const inclusionDB = require("../rules/inclusionLimits.poultry.v0.json");

const { applyLabOverrides } = require("../calc/applyLabOverrides");
const { diffNutrients } = require("../calc/diffNutrients");

const baseIngredientsDB = require("../db/ingredients.poultry.v0.json");
const reqDB = require("../db/requirements.poultry.v0.json");

function worstStatus(a, b) {
  const rank = { OK: 0, WARN: 1, FAIL: 2 };
  return rank[a] >= rank[b] ? a : b;
}

function analyzeFormula(input) {
  const {
    species = "poultry",
    type = "broiler",
    phase = "starter",
    locale = "US",
    formula_text = "",
    lab_overrides = {}
  } = input || {};

  if (!formula_text || !formula_text.trim()) {
    throw new Error("formula_text is required");
  }

  // 1) Parse
  const parsed = parseFormulaText(formula_text);

  // 2) Normalize to 100
  const normalized = normalizeFormula(parsed.items);

  // 3) Nutrients BEFORE override (baseline)
  const nutrient_profile_before_override = calcNutrients(normalized.items, baseIngredientsDB);

  // 4) Apply lab overrides (request-level)
  const ingredientsDB = applyLabOverrides(baseIngredientsDB, lab_overrides);

  // 5) Nutrients AFTER override
  const nutrient_profile_canonical = calcNutrients(normalized.items, ingredientsDB);

  // 6) Override diff report
  const override_diff = diffNutrients(
    nutrient_profile_before_override,
    nutrient_profile_canonical
  );

  // 7) Requirements lookup
  const reqKey = `${species}_${type}_${phase}`;
  const requirements = reqDB[reqKey];
  if (!requirements) throw new Error(`No requirements found for ${reqKey}`);

  // 8) Deviations vs requirement (after override)
  const deviations = compareToReqs(nutrient_profile_canonical, requirements);

  // 9) Nutrient rule evaluation (after override)
  const evaluation = evaluateDeviations(deviations);

  // 10) Inclusion rules (based on normalized formula)
  const inclusionLimitsForKey = inclusionDB[reqKey] || {};
  const inclusion_checks = checkInclusionLimits(normalized.items, inclusionLimitsForKey);

  // 11) Locale formatted output (after override)
  const nutrient_profile_formatted = formatOutputCanonicalToLocale(nutrient_profile_canonical, locale);

  // 12) Combined overall
  const overall = worstStatus(evaluation.overall, inclusion_checks.overall);

  return {
    ok: true,
    meta: { species, type, phase, reqKey, locale },
    parsed,
    normalized,

    lab_overrides_applied: lab_overrides,

    nutrient_profile_before_override,
    nutrient_profile_canonical,
    override_diff,

    nutrient_profile_formatted,

    requirements_canonical: requirements,
    deviations_canonical: deviations,
    evaluation,

    inclusion_checks,
    overall,

    version: "AgroCore v1.0 (override diff ✅)"
  };
}

module.exports = { analyzeFormula };
