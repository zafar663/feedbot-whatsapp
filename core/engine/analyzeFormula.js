// FILE: core/engine/analyzeFormula.cjs
"use strict";

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

// ---------------- Utilities ----------------
function worstStatus(a, b) {
  const rank = { OK: 0, WARN: 1, FAIL: 2 };
  return (rank[a] ?? 0) >= (rank[b] ?? 0) ? a : b;
}

function deepClone(obj) {
  return obj ? JSON.parse(JSON.stringify(obj)) : obj;
}

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function safeObj(x) {
  return x && typeof x === "object" ? x : {};
}

// SID AA keys we scale when CP override is provided
const SID_KEYS = [
  "sid_lys",
  "sid_met",
  "sid_metcys",
  "sid_thr",
  "sid_trp",
  "sid_arg"
];

// Heuristic classification (because v0 DB may not have robust categories)
const GRAIN_HINTS = [
  "corn",
  "maize",
  "wheat",
  "rice",
  "millet",
  "sorghum",
  "barley",
  "oats"
];

const MEAL_HINTS = [
  "soybean_meal",
  "sbm",
  "canola_meal",
  "rapeseed_meal",
  "sunflower_meal",
  "cottonseed_meal",
  "peanut_meal",
  "gluten_meal",
  "ddgs"
];

// Default DM baselines (as-fed) for grains if DB does not store DM.
// You can refine later.
const DEFAULT_DM_BASE = {
  corn: 86,
  maize: 86,
  wheat: 87,
  rice_broken: 88,
  rice: 88,
  millet: 88,
  sorghum: 88,
  barley: 88,
  oats: 89
};

function looksLikeGrainKey(k) {
  const s = String(k || "").toLowerCase();
  return GRAIN_HINTS.some((h) => s.includes(h));
}

function looksLikeMealKey(k) {
  const s = String(k || "").toLowerCase();
  return MEAL_HINTS.some((h) => s.includes(h));
}

function getIngredientRecord(db, key) {
  if (!db) return null;
  // v0 DBs sometimes store nutrients directly at root or under .nutrients
  const rec = db[key];
  if (!rec) return null;

  // normalize to { nutrients, ... }
  if (rec.nutrients && typeof rec.nutrients === "object") return rec;
  // if flat map: { cp:..., me:... }
  const flatKeys = ["cp", "me", ...SID_KEYS, "ca", "avp", "na", "dm"];
  const hasFlat = flatKeys.some((k) => rec[k] != null);
  if (hasFlat) return { nutrients: rec };
  return rec;
}

function getNutrient(rec, key) {
  const r = getIngredientRecord({ _x: rec }, "_x");
  if (!r) return null;
  const n = r.nutrients || {};
  return n[key] != null ? num(n[key]) : null;
}

function setNutrient(rec, key, value) {
  if (!rec) return;
  if (!rec.nutrients || typeof rec.nutrients !== "object") rec.nutrients = {};
  rec.nutrients[key] = value;
}

/**
 * Precision overrides:
 * - CP override: scales CP + all SID AA keys (if present)
 * - DM override (grains): adjusts ME by DM ratio
 *
 * input format:
 * precision_overrides = {
 *   cp: { "soybean_meal": 48, "canola_meal": 36, "corn": 8.5 },
 *   dm: { "corn": 86, "rice_broken": 89 }
 * }
 */
function applyPrecisionOverrides(baseDB, precision_overrides) {
  const po = safeObj(precision_overrides);
  const cpOv = safeObj(po.cp);
  const dmOv = safeObj(po.dm);

  const db = deepClone(baseDB);

  // CP scaling
  for (const [ingKey, cpUserRaw] of Object.entries(cpOv)) {
    const cpUser = num(cpUserRaw);
    if (cpUser == null || cpUser <= 0) continue;

    const rec = getIngredientRecord(db, ingKey);
    if (!rec) continue;

    const cpBase = getNutrient(rec, "cp");
    if (cpBase == null || cpBase <= 0) continue;

    const scale = cpUser / cpBase;

    // Set CP
    setNutrient(rec, "cp", cpUser);

    // Scale SID AA keys if present
    for (const k of SID_KEYS) {
      const v = getNutrient(rec, k);
      if (v == null) continue;
      setNutrient(rec, k, v * scale);
    }
  }

  // DM -> ME adjustment (grains only)
  for (const [ingKey, dmUserRaw] of Object.entries(dmOv)) {
    const dmUser = num(dmUserRaw);
    if (dmUser == null || dmUser <= 0) continue;

    const rec = getIngredientRecord(db, ingKey);
    if (!rec) continue;

    // Apply only to grains (heuristic)
    if (!looksLikeGrainKey(ingKey)) continue;

    const meBase = getNutrient(rec, "me");
    if (meBase == null || meBase <= 0) continue;

    // DM base: from DB if present, else defaults, else assume 86
    const dmBaseFromDb = getNutrient(rec, "dm");
    const dmBase =
      dmBaseFromDb != null
        ? dmBaseFromDb
        : (DEFAULT_DM_BASE[String(ingKey).toLowerCase()] ?? 86);

    // ME scales approximately with DM ratio (v1 shortcut)
    const meAdj = meBase * (dmUser / dmBase);

    setNutrient(rec, "me", meAdj);
    setNutrient(rec, "dm", dmUser);
  }

  return db;
}

/**
 * Major contributor selection:
 * - Protein contribution score: inc * cp
 * - Energy contribution score: inc * me
 *
 * We return "needs_precision" suggestions:
 * - cp_needed: top protein contributors until ~85% cumulative coverage
 * - dm_needed: top energy grain (or 2 if close)
 */
function computeNeedsPrecision(items, db, precision_overrides) {
  const po = safeObj(precision_overrides);
  const hasCp = safeObj(po.cp);
  const hasDm = safeObj(po.dm);

  const rows = [];
  for (const it of Array.isArray(items) ? items : []) {
    const key = it.ingredient || it.key || it.id;
    const inc = num(it.inclusion);
    if (!key || inc == null || inc <= 0) continue;

    const rec = getIngredientRecord(db, key);
    const cp = rec ? getNutrient(rec, "cp") : null;
    const me = rec ? getNutrient(rec, "me") : null;

    const protScore = cp != null ? inc * cp : 0;
    const energyScore = me != null ? inc * me : 0;

    rows.push({
      key,
      inclusion: inc,
      cp,
      me,
      protScore,
      energyScore,
      isGrain: looksLikeGrainKey(key),
      isMeal: looksLikeMealKey(key)
    });
  }

  // Protein: pick contributors until 85% of total protein score
  const protTotal = rows.reduce((s, r) => s + (r.protScore || 0), 0);
  const protSorted = [...rows].sort((a, b) => (b.protScore || 0) - (a.protScore || 0));

  const cp_needed = [];
  if (protTotal > 0) {
    let cum = 0;
    for (const r of protSorted) {
      if (r.protScore <= 0) continue;
      cum += r.protScore;

      // Ask CP for major protein drivers (meals + grains; skip oils/minerals implicitly)
      const already = hasCp[r.key] != null;
      const relevant = r.isMeal || r.isGrain; // v1 heuristic
      if (!already && relevant) {
        cp_needed.push({
          ingredient: r.key,
          inclusion: r.inclusion,
          reason: "major protein contributor",
          base_cp: r.cp
        });
      }

      if (cum / protTotal >= 0.85) break;
      if (cp_needed.length >= 5) break; // safety cap
    }
  }

  // Energy: pick top grain(s)
  const grainRows = rows.filter((r) => r.isGrain && (r.energyScore || 0) > 0);
  const energySorted = [...grainRows].sort((a, b) => (b.energyScore || 0) - (a.energyScore || 0));

  const dm_needed = [];
  if (energySorted.length) {
    const top = energySorted[0];
    if (top && hasDm[top.key] == null) {
      dm_needed.push({
        ingredient: top.key,
        inclusion: top.inclusion,
        reason: "top energy grain (DM affects ME)",
        base_dm: DEFAULT_DM_BASE[String(top.key).toLowerCase()] ?? 86
      });
    }

    // If second is close (>=80% of top energy score), also ask DM for it
    if (energySorted.length >= 2) {
      const second = energySorted[1];
      if (second && (second.energyScore / top.energyScore) >= 0.8 && hasDm[second.key] == null) {
        dm_needed.push({
          ingredient: second.key,
          inclusion: second.inclusion,
          reason: "second major energy grain (close to top)",
          base_dm: DEFAULT_DM_BASE[String(second.key).toLowerCase()] ?? 86
        });
      }
    }
  }

  // If nothing to ask, return null
  if (!cp_needed.length && !dm_needed.length) return null;

  return { cp_needed, dm_needed };
}

// ---------------- Main ----------------
function analyzeFormula(input) {
  const {
    species = "poultry",
    type = "broiler",
    phase = "starter",
    locale = "US",
    formula_text = "",
    lab_overrides = {},

    // NEW (optional)
    normalize = true, // keep legacy behavior by default
    precision_overrides = {} // { cp:{}, dm:{} }
  } = input || {};

  if (!formula_text || !formula_text.trim()) {
    throw new Error("formula_text is required");
  }

  // 1) Parse
  const parsed = parseFormulaText(formula_text);

  // 2) Normalize (optional)
  const itemsForCalc = normalize ? normalizeFormula(parsed.items).items : parsed.items;
  const normalized = normalize ? { items: itemsForCalc } : { items: itemsForCalc, note: "normalize=false" };

  // 3) Nutrients BEFORE override (baseline)
  const nutrient_profile_before_override = calcNutrients(itemsForCalc, baseIngredientsDB);

  // 4) Apply lab overrides (request-level) then precision overrides
  let ingredientsDB = applyLabOverrides(baseIngredientsDB, lab_overrides);
  ingredientsDB = applyPrecisionOverrides(ingredientsDB, precision_overrides);

  // 5) Nutrients AFTER overrides
  const nutrient_profile_canonical = calcNutrients(itemsForCalc, ingredientsDB);

  // 6) Override diff report (lab + precision combined effect)
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

  // 10) Inclusion rules (based on itemsForCalc)
  const inclusionLimitsForKey = inclusionDB[reqKey] || {};
  const inclusion_checks = checkInclusionLimits(itemsForCalc, inclusionLimitsForKey);

  // 11) Locale formatted output (after override)
  const nutrient_profile_formatted = formatOutputCanonicalToLocale(nutrient_profile_canonical, locale);

  // 12) Combined overall
  const overall = worstStatus(evaluation.overall, inclusion_checks.overall);

  // 13) NEW: needs_precision suggestions (major contributor driven)
  const needs_precision = computeNeedsPrecision(itemsForCalc, ingredientsDB, precision_overrides);

  // Helpful text (non-blocking)
  let precision_text = null;
  if (needs_precision) {
    const lines = [];
    lines.push("⚠️ Precision suggestions (major contributors):");

    if (needs_precision.cp_needed?.length) {
      lines.push("");
      lines.push("CP needed for:");
      for (const x of needs_precision.cp_needed.slice(0, 5)) {
        const base = x.base_cp != null ? ` (base CP ${x.base_cp})` : "";
        lines.push(`- CP ${String(x.ingredient).toUpperCase()} <value>${base} | incl ${x.inclusion}%`);
      }
      lines.push("Example replies:");
      lines.push("- CP CORN 8.5");
      lines.push("- CP SBM 48");
      lines.push("- CP CANOLA_MEAL 36");
    }

    if (needs_precision.dm_needed?.length) {
      lines.push("");
      lines.push("DM needed for:");
      for (const x of needs_precision.dm_needed.slice(0, 2)) {
        const base = x.base_dm != null ? ` (default DM ${x.base_dm}%)` : "";
        lines.push(`- DM ${String(x.ingredient).toUpperCase()} <value>${base} | incl ${x.inclusion}%`);
      }
      lines.push("Example replies:");
      lines.push("- DM CORN 86");
      lines.push("- DM RICE_BROKEN 89");
    }

    precision_text = lines.join("\n");
  }

  return {
    ok: true,
    meta: {
      species,
      type,
      phase,
      reqKey,
      locale,
      normalize: !!normalize,
      precision_mode: {
        enabled: true,
        note: "Major-contributor CP/DM suggestions; non-blocking in v1"
      }
    },

    parsed,
    normalized,

    lab_overrides_applied: lab_overrides,
    precision_overrides_applied: precision_overrides,

    nutrient_profile_before_override,
    nutrient_profile_canonical,
    override_diff,

    nutrient_profile_formatted,

    requirements_canonical: requirements,
    deviations_canonical: deviations,
    evaluation,

    inclusion_checks,
    overall,

    needs_precision: needs_precision || undefined,
    precision_text: precision_text || undefined,

    version: "AgroCore v1.1 (major-contributor precision: CP+DM ✅)"
  };
}

module.exports = { analyzeFormula };
