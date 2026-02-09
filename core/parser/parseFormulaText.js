// core/parser/parseFormulaText.js

const aliasDB = require("../db/ingredientAliases.v0.json");
const ingredientsDB = require("../db/ingredients.poultry.v0.json");
const { suggestClosest } = require("../utils/fuzzySuggest");

function cleanName(text) {
  return (text || "")
    .toLowerCase()
    .trim()
    .replace(/[%]/g, "")
    .replace(/[(),]/g, " ")
    .replace(/[_-]/g, " ")
    .replace(/\s+/g, " ");
}

function buildAliasMap(db) {
  const map = {};
  for (const canonical of Object.keys(db || {})) {
    map[cleanName(canonical)] = canonical;
    for (const a of db[canonical] || []) {
      map[cleanName(a)] = canonical;
    }
  }
  return map;
}

const ALIAS_MAP = buildAliasMap(aliasDB);
const CANDIDATES = Array.from(
  new Set([
    ...Object.keys(ingredientsDB || {}),
    ...Object.keys(aliasDB || {})
  ])
);

function canonicalizeIngredient(raw) {
  const key = cleanName(raw);
  return ALIAS_MAP[key] || null;
}

/**
 * Merge policy (lot-ready):
 * - Merge only if BOTH ingredient AND lot are equal.
 * - lot is optional (null). Later, if you supply lot ids, same ingredient with different lot will remain separate.
 */
function mergeItemsLotReady(items) {
  const map = new Map();

  for (const it of items) {
    const lot = it.lot ?? null;
    const mergeKey = `${it.ingredient}__LOT__${lot}`;

    const prev = map.get(mergeKey);
    if (!prev) {
      map.set(mergeKey, { ...it, lot });
    } else {
      prev.inclusion = (Number(prev.inclusion) || 0) + (Number(it.inclusion) || 0);

      if (it.is_unknown) {
        prev.is_unknown = true;
        prev.raw = prev.raw ? `${prev.raw}; ${it.raw}` : it.raw;
      }
    }
  }

  const out = Array.from(map.values()).map(x => ({
    ...x,
    inclusion: +Number(x.inclusion).toFixed(4)
  }));

  out.sort((a, b) => (b.inclusion || 0) - (a.inclusion || 0));
  return out;
}

function parseFormulaText(formulaText) {
  const lines = (formulaText || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const rawItems = [];
  const skipped = [];
  const unknown_raw = [];
  let total = 0;

  for (const line of lines) {
    // Accept: "Corn 55", "Corn: 55", "Corn 55%", "Corn=55"
    // (lot support later via structured JSON input; not from text yet)
    const match = line.match(/^(.+?)[\s:=]+(-?\d+(\.\d+)?)\s*%?$/);

    if (!match) {
      skipped.push(line);
      continue;
    }

    const rawName = match[1];
    const inclusion = Number(match[2]);

    if (!rawName || !Number.isFinite(inclusion)) {
      skipped.push(line);
      continue;
    }

    const canonical = canonicalizeIngredient(rawName);

    if (!canonical) {
      const rawClean = cleanName(rawName);

      unknown_raw.push({
        raw: rawName,
        cleaned: rawClean,
        inclusion,
        suggestions: suggestClosest(rawClean, CANDIDATES, 5)
      });

      rawItems.push({
        ingredient: rawClean,
        inclusion,
        is_unknown: true,
        raw: rawName,
        lot: null
      });

      total += inclusion;
      continue;
    }

    rawItems.push({ ingredient: canonical, inclusion, lot: null });
    total += inclusion;
  }

  const items = mergeItemsLotReady(rawItems);

  return { items, total, skipped, unknown_raw };
}

module.exports = { parseFormulaText };
