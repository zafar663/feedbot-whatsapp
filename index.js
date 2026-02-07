require("dotenv").config();
const express = require("express");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

/**
 * NutriPilot AI — vFinal Nutrient Estimate
 * - Core1: Formula Review (manual + bulk paste)
 * - Flexible parsing for ingredient names like "SBM44% 25.34", "Sunflower meal26-28%5"
 * - Estimates DM, AMEn, CP, EE, CF, Ca, AvP, Na, Cl, K + digestible AAs
 * - Compares targets for Ross / Cobb500 / Hubbard (broiler only)
 */

/* -------------------------- MENUS / TEXT -------------------------- */

const VERSION = "NutriPilot AI vNutrient✅ (Ross+Cobb500+Hubbard targets; broiler only)";

const MAIN_MENU =
  `NutriPilot AI\n\n` +
  `How can we help you today?\n\n` +
  `1) Formulation & Diet Control\n` +
  `2) Performance & Production Intelligence\n` +
  `3) Raw Materials, Feed Mill & Quality\n` +
  `4) Expert Review\n` +
  `5) Nutrition Partner Program\n\n` +
  `Reply with a number or type MENU.`;

const CORE1_MENU =
  `Formulation & Diet Control\n\n` +
  `1) Formula review (MVP)\n` +
  `2) Reformulation (next)\n` +
  `3) Diet approval / risk check (next)\n` +
  `4) Additives & enzymes guidance (next)\n\n` +
  `Reply 1 for now, or type MENU.`;

const FORMULA_REVIEW_METHOD =
  `Formula Review – Submit your diet\n\n` +
  `Choose input method:\n\n` +
  `1) Guided manual entry (% only)\n` +
  `2) Bulk paste (% only)\n` +
  `3) Upload Excel/CSV (next)\n` +
  `4) Upload photo/PDF (next)\n\n` +
  `Reply 1 or 2 for now, or type MENU.`;

const ESTIMATE_MODE =
  `Nutrient Estimate Mode\n\n` +
  `1) Quick estimate (defaults)\n` +
  `2) Lab-assisted estimate (recommended)\n\n` +
  `Reply 1 or 2.\n(Type MENU anytime)`;

/* -------------------------- SESSION STORE -------------------------- */
// In-memory (simple + reliable). We can swap to Redis later.
const sessions = new Map();

function getSession(key) {
  if (!sessions.has(key)) sessions.set(key, freshSession());
  return sessions.get(key);
}
function resetSession(key) {
  sessions.set(key, freshSession());
}
function freshSession() {
  return {
    step: "MAIN", // MAIN, CORE1, FR_ANIMAL, FR_POULTRY_TYPE, FR_STRAIN, FR_STAGE, FR_FORM, FR_METHOD, FR_MANUAL, FR_BULK, EST_MODE, LAB_CPDM
    lastReport: "",
    fr: {
      animal: null,        // "poultry" | others
      poultryType: null,   // "broiler" | "layer" | "broiler breeder" | "layer breeder"
      strain: null,        // "ross" | "cobb500" | "hubbard" | "other"
      stage: null,         // "starter" | "grower" | "finisher" | "withdrawal"
      feedForm: null,      // "mash" | "crumble" | "pellet"
      method: null,        // "manual" | "bulk"
      items: [],           // { name, key, pct, meta: {cpTag?} }
      lab: {               // overrides by ingredient key
        // key: { dm: number(%) , cp: number(% as-fed) }
      }
    }
  };
}

/* -------------------------- UTILITIES -------------------------- */

function norm(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

function firstDigit(raw) {
  const m = String(raw || "").trim().match(/^(\d)/);
  return m ? m[1] : null;
}

function safeNum(x) {
  if (x === null || x === undefined) return null;
  const s = String(x)
    .trim()
    .replace(/,/g, "")
    .replace(/o/gi, "0"); // fixes DLM99%o.122 -> 0.122
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

// Pull the last number in a string (handles "SBM44% 25.34", "Sunflower meal26-28%5", "Bajra 4,")
function extractTrailingNumber(text) {
  const s = String(text || "").replace(/,/g, " ").trim();
  const m = s.match(/(-?\d+(?:\.\d+)?)\s*%?\s*$/);
  if (!m) return null;
  return safeNum(m[1]);
}

// Remove trailing numeric chunk from ingredient name
function stripTrailingNumber(text) {
  const s = String(text || "").trim();
  return s.replace(/(-?\d+(?:\.\d+)?)\s*%?\s*$/, "").trim();
}

// If ingredient name contains CP tag like "SBM44%" or "Fishmeal54%" capture 44/54
function extractCpTag(name) {
  const m = String(name || "").match(/(\d{2})(?:\s*-\s*\d{2})?\s*%/); // "26-28%" -> 26 (keep first)
  if (!m) return null;
  const v = safeNum(m[1]);
  if (v === null) return null;
  // sanity range for CP tag
  if (v < 5 || v > 80) return null;
  return v;
}

function canonicalKey(name) {
  const n = norm(name);
  // basic synonym normalization (expand later)
  if (n.includes("maize") || n === "corn") return "corn";
  if (n.includes("sbm") || n.includes("soybean meal")) return "sbm";
  if (n.includes("soybean oil") || n.includes("soya oil")) return "soy_oil";
  if (n.includes("fishmeal") || n.includes("fish meal")) return "fishmeal";
  if (n.includes("canola")) return "canola_meal";
  if (n.includes("sunflower")) return "sunflower_meal";
  if (n.includes("rice broken") || n.includes("broken rice")) return "broken_rice";
  if (n.includes("ddgs")) return "ddgs";
  if (n.includes("corn gluten")) return "cgf60";
  if (n.includes("salt")) return "salt";
  if (n.includes("limestone")) return "limestone";
  if (n.includes("dcp") || n.includes("dicalcium")) return "dcp";
  if (n.includes("mcp") || n.includes("monocalcium")) return "mcp";
  if (n.includes("dlm") || n.includes("methionine")) return "dl_met";
  if (n.includes("lysine")) return "lys";
  if (n.includes("threonine")) return "thr";
  if (n.includes("valine")) return "val";
  if (n.includes("phytase")) return "phytase";
  if (n.includes("protease")) return "protease";
  if (n.includes("nsp")) return "nsp_enzyme";
  if (n.includes("premix") && n.includes("vit")) return "vit_premix";
  if (n.includes("premix") && n.includes("min")) return "min_premix";
  if (n.includes("choline")) return "choline";
  if (n.includes("toxin") || n.includes("binder")) return "toxin_binder";
  if (n.includes("cocci")) return "coccidiostat";
  if (n.includes("agp") || n.includes("antibiotic")) return "agp";
  if (n.includes("bajra") || n.includes("millet")) return "millet";
  return n.replace(/[^\w]+/g, "_").slice(0, 40);
}

/* -------------------------- DEFAULT INGREDIENT MATRIX -------------------------- */
/**
 * Values are typical (as-fed) unless noted.
 * Units:
 * - dm: % (dry matter)
 * - amen_kcalkg: kcal/kg (AMEn approx)
 * - cp, ee, cf, ca, avp, na, cl, k: %
 * - dig_*: % (standardized ileal digestible, *approx* defaults)
 *
 * NOTE: This is an MVP matrix; we’ll swap in best-in-class tables (AFZ/INRAE, Rostagno, AminoDat) later.
 */
const ING = {
  corn:          { dm: 88, amen_kcalkg: 3350, cp: 8.5,  ee: 3.8, cf: 2.2, ca: 0.03, avp: 0.08, na: 0.02, cl: 0.03, k: 0.30,
                   dig_lys: 0.20, dig_met: 0.17, dig_tsaa: 0.32, dig_thr: 0.22, dig_val: 0.32, dig_ile: 0.24, dig_arg: 0.34, dig_trp: 0.06 },
  broken_rice:   { dm: 89, amen_kcalkg: 3300, cp: 7.5,  ee: 1.0, cf: 0.8, ca: 0.02, avp: 0.06, na: 0.02, cl: 0.03, k: 0.20,
                   dig_lys: 0.18, dig_met: 0.16, dig_tsaa: 0.30, dig_thr: 0.20, dig_val: 0.28, dig_ile: 0.22, dig_arg: 0.30, dig_trp: 0.05 },
  millet:        { dm: 89, amen_kcalkg: 3200, cp: 11.0, ee: 4.0, cf: 2.5, ca: 0.03, avp: 0.10, na: 0.02, cl: 0.03, k: 0.35,
                   dig_lys: 0.26, dig_met: 0.20, dig_tsaa: 0.40, dig_thr: 0.26, dig_val: 0.45, dig_ile: 0.33, dig_arg: 0.50, dig_trp: 0.08 },
  sbm:           { dm: 89, amen_kcalkg: 2450, cp: 44.0, ee: 1.5, cf: 4.0, ca: 0.30, avp: 0.23, na: 0.03, cl: 0.05, k: 2.00,
                   dig_lys: 2.55, dig_met: 0.60, dig_tsaa: 1.20, dig_thr: 1.65, dig_val: 1.80, dig_ile: 1.70, dig_arg: 3.10, dig_trp: 0.55 },
  canola_meal:   { dm: 90, amen_kcalkg: 2000, cp: 36.0, ee: 3.5, cf: 10.0, ca: 0.70, avp: 0.35, na: 0.05, cl: 0.10, k: 1.20,
                   dig_lys: 1.50, dig_met: 0.55, dig_tsaa: 1.05, dig_thr: 1.20, dig_val: 1.55, dig_ile: 1.30, dig_arg: 2.05, dig_trp: 0.35 },
  sunflower_meal:{ dm: 90, amen_kcalkg: 1900, cp: 28.0, ee: 1.5, cf: 18.0, ca: 0.30, avp: 0.25, na: 0.05, cl: 0.10, k: 1.30,
                   dig_lys: 0.95, dig_met: 0.40, dig_tsaa: 0.75, dig_thr: 0.95, dig_val: 1.25, dig_ile: 0.95, dig_arg: 1.80, dig_trp: 0.28 },
  ddgs:          { dm: 89, amen_kcalkg: 2800, cp: 27.0, ee: 9.0, cf: 7.0, ca: 0.10, avp: 0.25, na: 0.10, cl: 0.10, k: 1.00,
                   dig_lys: 0.65, dig_met: 0.45, dig_tsaa: 0.85, dig_thr: 0.85, dig_val: 1.15, dig_ile: 0.85, dig_arg: 1.05, dig_trp: 0.22 },
  fishmeal:      { dm: 92, amen_kcalkg: 2900, cp: 60.0, ee: 8.0, cf: 0.0, ca: 5.00, avp: 3.00, na: 0.80, cl: 1.20, k: 0.60,
                   dig_lys: 4.80, dig_met: 1.70, dig_tsaa: 2.60, dig_thr: 2.70, dig_val: 3.20, dig_ile: 2.60, dig_arg: 3.40, dig_trp: 0.60 },
  soy_oil:       { dm: 99, amen_kcalkg: 8800, cp: 0.0,  ee: 99.0,cf: 0.0, ca: 0.00, avp: 0.00, na: 0.00, cl: 0.00, k: 0.00,
                   dig_lys: 0, dig_met: 0, dig_tsaa: 0, dig_thr: 0, dig_val: 0, dig_ile: 0, dig_arg: 0, dig_trp: 0 },
  cgf60:         { dm: 90, amen_kcalkg: 3300, cp: 60.0, ee: 3.0, cf: 2.0, ca: 0.05, avp: 0.20, na: 0.05, cl: 0.08, k: 0.30,
                   dig_lys: 1.05, dig_met: 1.20, dig_tsaa: 2.10, dig_thr: 1.60, dig_val: 2.60, dig_ile: 2.00, dig_arg: 1.70, dig_trp: 0.35 },
  salt:          { dm: 99, amen_kcalkg: 0,    cp: 0.0,  ee: 0.0, cf: 0.0, ca: 0.00, avp: 0.00, na: 39.3, cl: 60.7, k: 0.00,
                   dig_lys: 0, dig_met: 0, dig_tsaa: 0, dig_thr: 0, dig_val: 0, dig_ile: 0, dig_arg: 0, dig_trp: 0 },
  limestone:     { dm: 99, amen_kcalkg: 0,    cp: 0.0,  ee: 0.0, cf: 0.0, ca: 38.0, avp: 0.00, na: 0.00, cl: 0.00, k: 0.00,
                   dig_lys: 0, dig_met: 0, dig_tsaa: 0, dig_thr: 0, dig_val: 0, dig_ile: 0, dig_arg: 0, dig_trp: 0 },
  dcp:           { dm: 98, amen_kcalkg: 0,    cp: 0.0,  ee: 0.0, cf: 0.0, ca: 23.0, avp: 18.0, na: 0.00, cl: 0.00, k: 0.00,
                   dig_lys: 0, dig_met: 0, dig_tsaa: 0, dig_thr: 0, dig_val: 0, dig_ile: 0, dig_arg: 0, dig_trp: 0 },
  mcp:           { dm: 98, amen_kcalkg: 0,    cp: 0.0,  ee: 0.0, cf: 0.0, ca: 17.0, avp: 21.0, na: 0.00, cl: 0.00, k: 0.00,
                   dig_lys: 0, dig_met: 0, dig_tsaa: 0, dig_thr: 0, dig_val: 0, dig_ile: 0, dig_arg: 0, dig_trp: 0 },
  dl_met:        { dm: 99, amen_kcalkg: 0,    cp: 0.0,  ee: 0.0, cf: 0.0, ca: 0.00, avp: 0.00, na: 0.00, cl: 0.00, k: 0.00,
                   dig_lys: 0, dig_met: 99.0, dig_tsaa: 99.0, dig_thr: 0, dig_val: 0, dig_ile: 0, dig_arg: 0, dig_trp: 0 },
  lys:           { dm: 99, amen_kcalkg: 0,    cp: 0.0,  ee: 0.0, cf: 0.0, ca: 0.00, avp: 0.00, na: 0.00, cl: 0.00, k: 0.00,
                   dig_lys: 78.0, dig_met: 0, dig_tsaa: 0, dig_thr: 0, dig_val: 0, dig_ile: 0, dig_arg: 0, dig_trp: 0 },
  thr:           { dm: 99, amen_kcalkg: 0,    cp: 0.0,  ee: 0.0, cf: 0.0, ca: 0.00, avp: 0.00, na: 0.00, cl: 0.00, k: 0.00,
                   dig_lys: 0, dig_met: 0, dig_tsaa: 0, dig_thr: 98.0, dig_val: 0, dig_ile: 0, dig_arg: 0, dig_trp: 0 },
  val:           { dm: 99, amen_kcalkg: 0,    cp: 0.0,  ee: 0.0, cf: 0.0, ca: 0.00, avp: 0.00, na: 0.00, cl: 0.00, k: 0.00,
                   dig_lys: 0, dig_met: 0, dig_tsaa: 0, dig_thr: 0, dig_val: 98.0, dig_ile: 0, dig_arg: 0, dig_trp: 0 },
  // premixes / additives (zeroed in MVP estimate; we can account later if user inputs label)
  vit_premix:    { dm: 95, amen_kcalkg: 0, cp: 0, ee: 0, cf: 0, ca: 0, avp: 0, na: 0, cl: 0, k: 0,
                   dig_lys: 0, dig_met: 0, dig_tsaa: 0, dig_thr: 0, dig_val: 0, dig_ile: 0, dig_arg: 0, dig_trp: 0 },
  min_premix:    { dm: 95, amen_kcalkg: 0, cp: 0, ee: 0, cf: 0, ca: 0, avp: 0, na: 0, cl: 0, k: 0,
                   dig_lys: 0, dig_met: 0, dig_tsaa: 0, dig_thr: 0, dig_val: 0, dig_ile: 0, dig_arg: 0, dig_trp: 0 },
  choline:       { dm: 98, amen_kcalkg: 0, cp: 0, ee: 0, cf: 0, ca: 0, avp: 0, na: 0, cl: 0, k: 0,
                   dig_lys: 0, dig_met: 0, dig_tsaa: 0, dig_thr: 0, dig_val: 0, dig_ile: 0, dig_arg: 0, dig_trp: 0 },
  toxin_binder:  { dm: 95, amen_kcalkg: 0, cp: 0, ee: 0, cf: 0, ca: 0, avp: 0, na: 0, cl: 0, k: 0,
                   dig_lys: 0, dig_met: 0, dig_tsaa: 0, dig_thr: 0, dig_val: 0, dig_ile: 0, dig_arg: 0, dig_trp: 0 },
  coccidiostat:  { dm: 95, amen_kcalkg: 0, cp: 0, ee: 0, cf: 0, ca: 0, avp: 0, na: 0, cl: 0, k: 0,
                   dig_lys: 0, dig_met: 0, dig_tsaa: 0, dig_thr: 0, dig_val: 0, dig_ile: 0, dig_arg: 0, dig_trp: 0 },
  phytase:       { dm: 95, amen_kcalkg: 0, cp: 0, ee: 0, cf: 0, ca: 0, avp: 0, na: 0, cl: 0, k: 0,
                   dig_lys: 0, dig_met: 0, dig_tsaa: 0, dig_thr: 0, dig_val: 0, dig_ile: 0, dig_arg: 0, dig_trp: 0 },
  protease:      { dm: 95, amen_kcalkg: 0, cp: 0, ee: 0, cf: 0, ca: 0, avp: 0, na: 0, cl: 0, k: 0,
                   dig_lys: 0, dig_met: 0, dig_tsaa: 0, dig_thr: 0, dig_val: 0, dig_ile: 0, dig_arg: 0, dig_trp: 0 },
  nsp_enzyme:    { dm: 95, amen_kcalkg: 0, cp: 0, ee: 0, cf: 0, ca: 0, avp: 0, na: 0, cl: 0, k: 0,
                   dig_lys: 0, dig_met: 0, dig_tsaa: 0, dig_thr: 0, dig_val: 0, dig_ile: 0, dig_arg: 0, dig_trp: 0 },
  agp:           { dm: 95, amen_kcalkg: 0, cp: 0, ee: 0, cf: 0, ca: 0, avp: 0, na: 0, cl: 0, k: 0,
                   dig_lys: 0, dig_met: 0, dig_tsaa: 0, dig_thr: 0, dig_val: 0, dig_ile: 0, dig_arg: 0, dig_trp: 0 }
};

/* -------------------------- TARGETS (Broiler Only) -------------------------- */
/**
 * Targets expressed as:
 * - amen_kcalkg, cp, ca, avp, na, cl, k (%)
 * - digestible AAs (%): dig_lys, dig_met, dig_tsaa, dig_thr, dig_val, dig_ile, dig_arg, dig_trp
 */
const TARGETS = {
  ross: {
    starter:   { amen_kcalkg: 2975, cp: 23.0, ca: 0.95, avp: 0.50, na_min: 0.18, na_max: 0.23, cl_min: 0.18, cl_max: 0.23, k_min: 0.60, k_max: 0.90,
                 dig_lys: 1.32, dig_met: 0.55, dig_tsaa: 1.00, dig_thr: 0.88, dig_val: 1.00, dig_ile: 0.88, dig_arg: 1.40, dig_trp: 0.21 },
    grower:    { amen_kcalkg: 3050, cp: 21.5, ca: 0.75, avp: 0.42, na_min: 0.18, na_max: 0.23, cl_min: 0.18, cl_max: 0.23, k_min: 0.60, k_max: 0.90,
                 dig_lys: 1.18, dig_met: 0.51, dig_tsaa: 0.92, dig_thr: 0.79, dig_val: 0.91, dig_ile: 0.80, dig_arg: 1.27, dig_trp: 0.19 },
    finisher:  { amen_kcalkg: 3100, cp: 19.5, ca: 0.65, avp: 0.36, na_min: 0.18, na_max: 0.23, cl_min: 0.18, cl_max: 0.23, k_min: 0.60, k_max: 0.90,
                 dig_lys: 1.08, dig_met: 0.48, dig_tsaa: 0.86, dig_thr: 0.72, dig_val: 0.84, dig_ile: 0.75, dig_arg: 1.17, dig_trp: 0.17 },
    withdrawal:{ amen_kcalkg: 3125, cp: 18.0, ca: 0.60, avp: 0.34, na_min: 0.18, na_max: 0.23, cl_min: 0.18, cl_max: 0.23, k_min: 0.60, k_max: 0.90,
                 dig_lys: 1.02, dig_met: 0.45, dig_tsaa: 0.82, dig_thr: 0.68, dig_val: 0.80, dig_ile: 0.70, dig_arg: 1.12, dig_trp: 0.16 }
  }, // Ross 2022 targets :contentReference[oaicite:3]{index=3}
  cobb500: {
    starter:   { amen_kcalkg: 2900, cp_min: 21.0, cp_max: 22.0, ca: 0.96, avp: 0.54, na_min: 0.16, na_max: 0.23, cl_min: 0.16, cl_max: 0.30, k_min: 0.60, k_max: 0.95,
                 dig_lys: 1.26, dig_met: 0.48, dig_tsaa: 0.94, dig_thr: 0.86, dig_val: 0.96, dig_ile: 0.81, dig_arg: 1.36, dig_trp: 0.21 },
    grower:    { amen_kcalkg: 2950, cp_min: 19.0, cp_max: 20.0, ca: 0.80, avp: 0.40, na_min: 0.16, na_max: 0.23, cl_min: 0.16, cl_max: 0.30, k_min: 0.60, k_max: 0.95,
                 dig_lys: 1.16, dig_met: 0.47, dig_tsaa: 0.88, dig_thr: 0.78, dig_val: 0.88, dig_ile: 0.75, dig_arg: 1.25, dig_trp: 0.18 },
    finisher:  { amen_kcalkg: 3050, cp_min: 18.0, cp_max: 19.0, ca: 0.74, avp: 0.37, na_min: 0.16, na_max: 0.23, cl_min: 0.16, cl_max: 0.30, k_min: 0.60, k_max: 0.95,
                 dig_lys: 1.06, dig_met: 0.44, dig_tsaa: 0.82, dig_thr: 0.70, dig_val: 0.81, dig_ile: 0.69, dig_arg: 1.16, dig_trp: 0.19 },
    withdrawal:{ amen_kcalkg: 3100, cp_min: 17.0, cp_max: 18.0, ca: 0.72, avp: 0.36, na_min: 0.16, na_max: 0.23, cl_min: 0.16, cl_max: 0.30, k_min: 0.60, k_max: 0.95,
                 dig_lys: 0.96, dig_met: 0.40, dig_tsaa: 0.74, dig_thr: 0.62, dig_val: 0.74, dig_ile: 0.63, dig_arg: 1.05, dig_trp: 0.17 }
  }, // Cobb500 2022 supplement :contentReference[oaicite:4]{index=4}
  hubbard: {
    starter:   { amen_kcalkg: 3000, cp_min: 22.0, cp_max: 23.0, ca_min: 0.98, ca_max: 1.03, avp_min: 0.48, avp_max: 0.50, na_min: 0.16, na_max: 0.23, cl_min: 0.16, cl_max: 0.30, k_min: 0.80, k_max: 0.95,
                 dig_lys: 1.23, dig_met: 0.49, dig_tsaa: 0.92, dig_thr: 0.80, dig_val: 0.93, dig_ile: 0.80, dig_arg: 1.29, dig_trp: 0.20 },
    grower:    { amen_kcalkg: 3050, cp_min: 19.5, cp_max: 20.0, ca_min: 0.89, ca_max: 0.92, avp_min: 0.43, avp_max: 0.44, na_min: 0.15, na_max: 0.19, cl_min: 0.15, cl_max: 0.21, k_min: 0.80, k_max: 0.90,
                 dig_lys: 1.09, dig_met: 0.45, dig_tsaa: 0.83, dig_thr: 0.72, dig_val: 0.84, dig_ile: 0.72, dig_arg: 1.15, dig_trp: 0.17 },
    finisher:  { amen_kcalkg: 3150, cp_min: 18.5, cp_max: 19.0, ca_min: 0.84, ca_max: 0.92, avp_min: 0.37, avp_max: 0.38, na_min: 0.15, na_max: 0.17, cl_min: 0.16, cl_max: 0.22, k_min: 0.75, k_max: 0.85,
                 dig_lys: 1.04, dig_met: 0.44, dig_tsaa: 0.80, dig_thr: 0.69, dig_val: 0.81, dig_ile: 0.69, dig_arg: 1.11, dig_trp: 0.18 },
    withdrawal:{ amen_kcalkg: 3200, cp_min: 17.0, cp_max: 17.5, ca_min: 0.68, ca_max: 0.76, avp_min: 0.33, avp_max: 0.34, na_min: 0.15, na_max: 0.18, cl_min: 0.16, cl_max: 0.22, k_min: 0.70, k_max: 0.80,
                 dig_lys: 0.93, dig_met: 0.40, dig_tsaa: 0.73, dig_thr: 0.63, dig_val: 0.73, dig_ile: 0.63, dig_arg: 1.00, dig_trp: 0.16 }
  } // Hubbard broiler manual appendix :contentReference[oaicite:5]{index=5}
};

/* -------------------------- PARSERS (manual + bulk) -------------------------- */

function parseAddLine(raw) {
  // Accept:
  // - "ADD Maize 27.45"
  // - "Maize27.45"
  // - "SBM44% 25.34"
  // - "Sunflower meal26-28%5"
  // - "Millet/Bajra 4,"
  const s = String(raw || "").trim();
  if (!s) return null;

  const upper = s.toUpperCase();
  const cleaned = s.replace(/,+$/, "").trim();

  let body = cleaned;
  if (upper.startsWith("ADD ")) body = cleaned.slice(4).trim();

  const pct = extractTrailingNumber(body);
  if (pct === null) return null;

  const namePart = stripTrailingNumber(body);
  const name = namePart.replace(/[:\-]+$/, "").trim();
  if (!name) return null;

  return {
    name,
    pct,
    cpTag: extractCpTag(name)
  };
}

function parseBulkPaste(text) {
  // Split by comma/semicolon/newline, extract ingredient + trailing number
  const chunks = String(text || "")
    .replace(/\r/g, "\n")
    .split(/[\n;,]+/)
    .map(x => x.trim())
    .filter(Boolean);

  const items = [];
  const unreadable = [];
  for (const c of chunks) {
    const parsed = parseAddLine(c);
    if (!parsed) unreadable.push(c);
    else items.push(parsed);
  }
  return { items, unreadable };
}

/* -------------------------- NUTRIENT ESTIMATION -------------------------- */

function applyLabOverrides(fr, est) {
  // est is per-item contributions; for items with lab dm/cp, adjust CP and scale digestible AAs by CP ratio.
  // We keep AMEn and minerals as defaults in MVP.
  const out = JSON.parse(JSON.stringify(est));
  for (const it of out.items) {
    const ov = fr.lab[it.key];
    if (!ov) continue;

    // override DM and CP
    if (Number.isFinite(ov.dm)) it.n.dm = ov.dm;
    if (Number.isFinite(ov.cp)) {
      const oldCP = it.n.cp;
      it.n.cp = ov.cp;

      // scale digestible AA fields roughly proportional to CP shift (major driver)
      const ratio = oldCP > 0 ? (ov.cp / oldCP) : 1;
      const aaKeys = ["dig_lys","dig_met","dig_tsaa","dig_thr","dig_val","dig_ile","dig_arg","dig_trp"];
      for (const k of aaKeys) {
        it.n[k] = (it.n[k] || 0) * ratio;
      }
    }
  }
  return out;
}

function buildPerItemNutrients(fr) {
  const items = fr.items.map(x => {
    const key = x.key;
    const base = ING[key] || null;
    const pct = x.pct;

    // If we have CP tag in ingredient name (e.g., SBM44%), and matrix is SBM,
    // we override base CP with tag and scale AAs with CP ratio.
    let n = base ? { ...base } : null;
    if (n && x.meta && Number.isFinite(x.meta.cpTag) && x.meta.cpTag > 0) {
      const oldCP = n.cp || 0;
      const newCP = x.meta.cpTag;
      n.cp = newCP;
      const ratio = oldCP > 0 ? (newCP / oldCP) : 1;
      const aaKeys = ["dig_lys","dig_met","dig_tsaa","dig_thr","dig_val","dig_ile","dig_arg","dig_trp"];
      for (const k of aaKeys) n[k] = (n[k] || 0) * ratio;
    }

    // fallback if unknown ingredient: zero
    if (!n) n = { dm: 0, amen_kcalkg: 0, cp: 0, ee: 0, cf: 0, ca: 0, avp: 0, na: 0, cl: 0, k: 0,
                  dig_lys: 0, dig_met: 0, dig_tsaa: 0, dig_thr: 0, dig_val: 0, dig_ile: 0, dig_arg: 0, dig_trp: 0 };

    return { name: x.name, key, pct, n };
  });

  return { items };
}

function sumDiet(est) {
  // Weighted sum (percent-of-diet basis)
  const totalPct = est.items.reduce((a, b) => a + (b.pct || 0), 0);

  const W = (val, pct) => (val * pct) / 100.0;

  const out = {
    totalPct,
    dm: 0,
    amen_kcalkg: 0,
    cp: 0,
    ee: 0,
    cf: 0,
    ca: 0,
    avp: 0,
    na: 0,
    cl: 0,
    k: 0,
    dig_lys: 0,
    dig_met: 0,
    dig_tsaa: 0,
    dig_thr: 0,
    dig_val: 0,
    dig_ile: 0,
    dig_arg: 0,
    dig_trp: 0
  };

  for (const it of est.items) {
    const p = it.pct || 0;
    out.dm += W(it.n.dm || 0, p);
    out.amen_kcalkg += W(it.n.amen_kcalkg || 0, p);
    out.cp += W(it.n.cp || 0, p);
    out.ee += W(it.n.ee || 0, p);
    out.cf += W(it.n.cf || 0, p);
    out.ca += W(it.n.ca || 0, p);
    out.avp += W(it.n.avp || 0, p);
    out.na += W(it.n.na || 0, p);
    out.cl += W(it.n.cl || 0, p);
    out.k += W(it.n.k || 0, p);

    out.dig_lys += W(it.n.dig_lys || 0, p);
    out.dig_met += W(it.n.dig_met || 0, p);
    out.dig_tsaa += W(it.n.dig_tsaa || 0, p);
    out.dig_thr += W(it.n.dig_thr || 0, p);
    out.dig_val += W(it.n.dig_val || 0, p);
    out.dig_ile += W(it.n.dig_ile || 0, p);
    out.dig_arg += W(it.n.dig_arg || 0, p);
    out.dig_trp += W(it.n.dig_trp || 0, p);
  }

  return out;
}

function fmt(x, dp = 2) {
  if (!Number.isFinite(x)) return "-";
  return x.toFixed(dp);
}

function withinRange(val, min, max) {
  if (!Number.isFinite(val)) return false;
  if (Number.isFinite(min) && val < min) return false;
  if (Number.isFinite(max) && val > max) return false;
  return true;
}

function compareToTargets(fr, diet) {
  const strain = fr.strain;
  const stage = fr.stage;

  if (fr.animal !== "poultry" || fr.poultryType !== "broiler") return { ok: false, note: "Targets only implemented for Broiler (Ross/Cobb500/Hubbard) in this MVP." };
  if (!["ross","cobb500","hubbard"].includes(strain)) return { ok: false, note: "No targets for this strain yet. I’ll still show estimated nutrients." };

  const t = (TARGETS[strain] || {})[stage];
  if (!t) return { ok: false, note: "No targets for this stage yet. I’ll still show estimated nutrients." };

  // Build rows
  const rows = [];

  // Energy
  rows.push({
    n: "AMEn (kcal/kg)",
    est: diet.amen_kcalkg,
    tgt: t.amen_kcalkg,
    status: Number.isFinite(t.amen_kcalkg) ? (diet.amen_kcalkg >= t.amen_kcalkg - 25 && diet.amen_kcalkg <= t.amen_kcalkg + 25 ? "OK" : "CHECK") : "-"
  });

  // CP (range or single)
  if (Number.isFinite(t.cp_min) || Number.isFinite(t.cp_max)) {
    rows.push({ n: "CP (%)", est: diet.cp, tgt: `${t.cp_min ?? "-"}–${t.cp_max ?? "-"}`, status: withinRange(diet.cp, t.cp_min, t.cp_max) ? "OK" : "CHECK" });
  } else {
    rows.push({ n: "CP (%)", est: diet.cp, tgt: t.cp, status: Number.isFinite(t.cp) ? (Math.abs(diet.cp - t.cp) <= 0.5 ? "OK" : "CHECK") : "-" });
  }

  // Minerals
  if (Number.isFinite(t.ca_min) || Number.isFinite(t.ca_max)) {
    rows.push({ n: "Ca (%)", est: diet.ca, tgt: `${t.ca_min ?? "-"}–${t.ca_max ?? "-"}`, status: withinRange(diet.ca, t.ca_min, t.ca_max) ? "OK" : "CHECK" });
  } else if (Number.isFinite(t.ca)) {
    rows.push({ n: "Ca (%)", est: diet.ca, tgt: t.ca, status: Math.abs(diet.ca - t.ca) <= 0.05 ? "OK" : "CHECK" });
  }

  if (Number.isFinite(t.avp_min) || Number.isFinite(t.avp_max)) {
    rows.push({ n: "AvP (%)", est: diet.avp, tgt: `${t.avp_min ?? "-"}–${t.avp_max ?? "-"}`, status: withinRange(diet.avp, t.avp_min, t.avp_max) ? "OK" : "CHECK" });
  } else if (Number.isFinite(t.avp)) {
    rows.push({ n: "AvP (%)", est: diet.avp, tgt: t.avp, status: Math.abs(diet.avp - t.avp) <= 0.03 ? "OK" : "CHECK" });
  }

  rows.push({ n: "Na (%)", est: diet.na, tgt: `${t.na_min ?? "-"}–${t.na_max ?? "-"}`, status: withinRange(diet.na, t.na_min, t.na_max) ? "OK" : "CHECK" });
  rows.push({ n: "Cl (%)", est: diet.cl, tgt: `${t.cl_min ?? "-"}–${t.cl_max ?? "-"}`, status: withinRange(diet.cl, t.cl_min, t.cl_max) ? "OK" : "CHECK" });
  rows.push({ n: "K (%)",  est: diet.k,  tgt: `${t.k_min ?? "-"}–${t.k_max ?? "-"}`,  status: withinRange(diet.k,  t.k_min,  t.k_max)  ? "OK" : "CHECK" });

  // Digestible AAs
  const aa = [
    ["dLys (%)", "dig_lys"],
    ["dMet (%)", "dig_met"],
    ["dTSAA (%)", "dig_tsaa"],
    ["dThr (%)", "dig_thr"],
    ["dVal (%)", "dig_val"],
    ["dIle (%)", "dig_ile"],
    ["dArg (%)", "dig_arg"],
    ["dTrp (%)", "dig_trp"]
  ];
  for (const [label, k] of aa) {
    if (!Number.isFinite(t[k])) continue;
    const estv = diet[k];
    rows.push({ n: label, est: estv, tgt: t[k], status: Math.abs(estv - t[k]) <= 0.03 ? "OK" : (estv >= t[k] ? "HIGH" : "LOW") });
  }

  return { ok: true, rows, t };
}

function formatWhatsAppTable(rows) {
  // fixed-ish widths
  const header = `Nutrient                 Est       Target     Flag`;
  const line = `--------------------------------------------------`;
  const body = rows.map(r => {
    const n = (r.n || "").padEnd(22, " ").slice(0, 22);
    const est = (typeof r.est === "number" ? fmt(r.est, r.n.includes("kcal") ? 0 : 2) : String(r.est)).padStart(8, " ").slice(0, 8);
    const tgt = (typeof r.tgt === "number" ? fmt(r.tgt, r.n.includes("kcal") ? 0 : 2) : String(r.tgt)).padStart(9, " ").slice(0, 9);
    const flag = String(r.status || "-").padStart(6, " ").slice(0, 6);
    return `${n}  ${est}  ${tgt}  ${flag}`;
  }).join("\n");

  return "```" + "\n" + header + "\n" + line + "\n" + body + "\n" + "```";
}

/* -------------------------- FLOW HELPERS -------------------------- */

function addItem(fr, parsed) {
  const key = canonicalKey(parsed.name);
  const pct = parsed.pct;

  // store meta cpTag if present
  const meta = {};
  if (Number.isFinite(parsed.cpTag)) meta.cpTag = parsed.cpTag;

  // replace if exists
  const idx = fr.items.findIndex(x => x.key === key);
  if (idx >= 0) fr.items[idx] = { name: parsed.name, key, pct, meta };
  else fr.items.push({ name: parsed.name, key, pct, meta });

  // cap
  fr.items = fr.items.slice(0, 120);
}

function removeItem(fr, name) {
  const k = canonicalKey(name);
  fr.items = fr.items.filter(x => x.key !== k);
  delete fr.lab[k];
}

function totalPct(fr) {
  return fr.items.reduce((a, b) => a + (b.pct || 0), 0);
}

/* -------------------------- ROUTES -------------------------- */

app.get("/", (req, res) => res.status(200).send(`Feedbot is running ✅\n${VERSION}`));

// Twilio will POST here. A GET /whatsapp shows "Cannot GET /whatsapp" and that’s normal.
app.post("/whatsapp", (req, res) => {
  try {
    const from = req.body.From || "unknown";
    const raw = (req.body.Body || "").trim();
    const msg = norm(raw);
    const choice = firstDigit(raw);

    const twiml = new twilio.twiml.MessagingResponse();
    const session = getSession(from);

    // Global commands
    if (!raw || ["hi", "hello", "start", "menu"].includes(msg)) {
      resetSession(from);
      twiml.message(MAIN_MENU);
      return res.type("text/xml").send(twiml.toString());
    }
    if (msg === "back") {
      resetSession(from);
      twiml.message(MAIN_MENU);
      return res.type("text/xml").send(twiml.toString());
    }
    if (msg === "result") {
      twiml.message(session.lastReport || `No report yet. Type MENU.\n\n${VERSION}`);
      return res.type("text/xml").send(twiml.toString());
    }

    /* ---------------- MAIN MENU ---------------- */
    if (session.step === "MAIN") {
      if (choice === "1") {
        session.step = "CORE1";
        twiml.message(CORE1_MENU);
      } else {
        twiml.message(`Not active yet (MVP).\n\nType MENU.\n\n${VERSION}`);
      }
      return res.type("text/xml").send(twiml.toString());
    }

    /* ---------------- CORE1 MENU ---------------- */
    if (session.step === "CORE1") {
      if (choice === "1") {
        session.step = "FR_ANIMAL";
        twiml.message(
          `Formula Review (MVP)\n\n` +
          `Step 1: Choose animal:\n` +
          `1) Poultry\n` +
          `2) Swine (next)\n` +
          `3) Dairy (next)\n` +
          `4) Beef cattle (next)\n` +
          `5) Small ruminants (next)\n` +
          `6) Horse (next)\n\n` +
          `Reply 1 for Poultry.\n(Type MENU anytime)`
        );
      } else {
        twiml.message(`Only 1 is active right now.\n\n${CORE1_MENU}`);
      }
      return res.type("text/xml").send(twiml.toString());
    }

    /* ---------------- Formula Review: Animal ---------------- */
    if (session.step === "FR_ANIMAL") {
      if (choice === "1") {
        session.fr.animal = "poultry";
        session.step = "FR_POULTRY_TYPE";
        twiml.message(
          `Poultry type:\n\n` +
          `1) Broiler\n` +
          `2) Layer\n` +
          `3) Broiler breeder\n` +
          `4) Layer breeder\n\n` +
          `Reply 1–4.`
        );
      } else {
        twiml.message(`Only Poultry is active in this MVP.\nReply 1.`);
      }
      return res.type("text/xml").send(twiml.toString());
    }

    /* ---------------- Poultry type ---------------- */
    if (session.step === "FR_POULTRY_TYPE") {
      const map = { "1":"broiler", "2":"layer", "3":"broiler breeder", "4":"layer breeder" };
      const pt = map[choice];
      if (!pt) {
        twiml.message(`Reply 1–4.\n\nPoultry type:\n1) Broiler\n2) Layer\n3) Broiler breeder\n4) Layer breeder`);
        return res.type("text/xml").send(twiml.toString());
      }
      session.fr.poultryType = pt;

      // Strain only for BROILER in MVP (targets)
      if (pt === "broiler") {
        session.step = "FR_STRAIN";
        twiml.message(
          `Broiler genetic line (for target matching):\n\n` +
          `1) Ross\n` +
          `2) Cobb500\n` +
          `3) Hubbard\n` +
          `4) Other (no targets)\n\n` +
          `Reply 1–4.`
        );
      } else {
        // other poultry types: still allow formula capture, but no targets yet
        session.fr.strain = "other";
        session.step = "FR_STAGE";
        twiml.message(
          `Stage (full stages):\n\n` +
          `1) Starter\n` +
          `2) Grower\n` +
          `3) Finisher\n` +
          `4) Withdrawal\n\n` +
          `Reply 1–4.`
        );
      }
      return res.type("text/xml").send(twiml.toString());
    }

    /* ---------------- Strain ---------------- */
    if (session.step === "FR_STRAIN") {
      const map = { "1":"ross", "2":"cobb500", "3":"hubbard", "4":"other" };
      const st = map[choice];
      if (!st) {
        twiml.message(`Reply 1–4.\n\n1) Ross\n2) Cobb500\n3) Hubbard\n4) Other`);
        return res.type("text/xml").send(twiml.toString());
      }
      session.fr.strain = st;
      session.step = "FR_STAGE";
      twiml.message(
        `Stage (full stages):\n\n` +
        `1) Starter\n` +
        `2) Grower\n` +
        `3) Finisher\n` +
        `4) Withdrawal\n\n` +
        `Reply 1–4.`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    /* ---------------- Stage ---------------- */
    if (session.step === "FR_STAGE") {
      const map = { "1":"starter", "2":"grower", "3":"finisher", "4":"withdrawal" };
      const stg = map[choice];
      if (!stg) {
        twiml.message(`Reply 1–4.\n\n1) Starter\n2) Grower\n3) Finisher\n4) Withdrawal`);
        return res.type("text/xml").send(twiml.toString());
      }
      session.fr.stage = stg;
      session.step = "FR_FORM";
      twiml.message(`Feed form?\n\n1) Mash\n2) Crumble\n3) Pellet\n\nReply 1–3.`);
      return res.type("text/xml").send(twiml.toString());
    }

    /* ---------------- Feed form ---------------- */
    if (session.step === "FR_FORM") {
      const map = { "1":"mash", "2":"crumble", "3":"pellet" };
      const f = map[choice];
      if (!f) {
        twiml.message(`Reply 1–3.\n\n1) Mash\n2) Crumble\n3) Pellet`);
        return res.type("text/xml").send(twiml.toString());
      }
      session.fr.feedForm = f;
      session.step = "FR_METHOD";
      twiml.message(FORMULA_REVIEW_METHOD);
      return res.type("text/xml").send(twiml.toString());
    }

    /* ---------------- Input method ---------------- */
    if (session.step === "FR_METHOD") {
      if (choice === "1") {
        session.fr.method = "manual";
        session.step = "FR_MANUAL";
        session.fr.items = [];
        session.fr.lab = {};
        twiml.message(
          `Manual Entry (% only)\n\n` +
          `Animal: ${session.fr.animal === "poultry" ? "Poultry" : "Other"}\n` +
          `Poultry: ${session.fr.poultryType || "-"}\n` +
          `Genetic line: ${session.fr.strain || "-"}\n` +
          `Stage: ${session.fr.stage || "-"}\n` +
          `Feed form: ${session.fr.feedForm || "-"}\n\n` +
          `Send each ingredient in ONE message:\n` +
          `ADD <ingredient name> <percent>\n\n` +
          `Examples:\n` +
          `ADD Maize 27.45\n` +
          `ADD SBM44% 25.34\n` +
          `ADD Sunflower meal26-28% 5\n\n` +
          `Commands:\nLIST\nREMOVE <ingredient name>\nDONE\nMENU`
        );
      } else if (choice === "2") {
        session.fr.method = "bulk";
        session.step = "FR_BULK";
        session.fr.items = [];
        session.fr.lab = {};
        twiml.message(
          `Bulk paste (% only)\n\n` +
          `Paste your whole formula in ONE message.\n` +
          `It can be messy: commas/lines/semicolons are fine.\n\n` +
          `Example:\nMaize27.45, SBM44% 25.34, Fishmeal54%12.26, Salt0.30\n\n` +
          `After paste: you can paste more, or type DONE.\nCommands: LIST / REMOVE <name> / DONE / MENU`
        );
      } else {
        twiml.message(FORMULA_REVIEW_METHOD);
      }
      return res.type("text/xml").send(twiml.toString());
    }

    /* ---------------- Manual capture ---------------- */
    if (session.step === "FR_MANUAL") {
      const fr = session.fr;

      if (msg === "list") {
        const lines = fr.items.map(x => `- ${x.name} = ${fmt(x.pct, 3)}%`).join("\n") || "(empty)";
        twiml.message(`Items: ${fr.items.length} | Total: ${fmt(totalPct(fr), 2)}%\n\n${lines}\n\nDONE to estimate.`);
        return res.type("text/xml").send(twiml.toString());
      }

      if (msg.startsWith("remove ")) {
        const name = raw.slice(7).trim();
        removeItem(fr, name);
        twiml.message(`Removed (if existed): ${name}\nItems: ${fr.items.length} | Total: ${fmt(totalPct(fr), 2)}%\n\nSend next: ADD <name> <pct>\nOr LIST / DONE / MENU`);
        return res.type("text/xml").send(twiml.toString());
      }

      if (msg === "done") {
        // go to estimate mode
        session.step = "EST_MODE";
        twiml.message(ESTIMATE_MODE);
        return res.type("text/xml").send(twiml.toString());
      }

      // Accept ADD or loose lines like "Bajra 4" or "Millet/Bajra 4,"
      const parsed = parseAddLine(raw);
      if (!parsed) {
        twiml.message(
          `I couldn’t read that.\n\n` +
          `Send: ADD <ingredient> <percent>\n` +
          `Example: ADD Bajra 4\n\n` +
          `Commands: LIST / REMOVE <name> / DONE / MENU`
        );
        return res.type("text/xml").send(twiml.toString());
      }

      addItem(fr, parsed);
      twiml.message(
        `✅ Added: ${parsed.name} = ${fmt(parsed.pct, 3)}%\n` +
        `Items: ${fr.items.length} | Total: ${fmt(totalPct(fr), 2)}%\n\n` +
        `Send next: ADD <name> <pct>\nOr LIST / REMOVE <name> / DONE`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    /* ---------------- Bulk capture ---------------- */
    if (session.step === "FR_BULK") {
      const fr = session.fr;

      if (msg === "list") {
        const lines = fr.items.map(x => `- ${x.name} = ${fmt(x.pct, 3)}%`).join("\n") || "(empty)";
        twiml.message(`Items: ${fr.items.length} | Total: ${fmt(totalPct(fr), 2)}%\n\n${lines}\n\nPaste more or DONE.`);
        return res.type("text/xml").send(twiml.toString());
      }

      if (msg.startsWith("remove ")) {
        const name = raw.slice(7).trim();
        removeItem(fr, name);
        twiml.message(`Removed (if existed): ${name}\nItems: ${fr.items.length} | Total: ${fmt(totalPct(fr), 2)}%\n\nPaste more or DONE.`);
        return res.type("text/xml").send(twiml.toString());
      }

      if (msg === "done") {
        session.step = "EST_MODE";
        twiml.message(ESTIMATE_MODE);
        return res.type("text/xml").send(twiml.toString());
      }

      // Parse bulk
      const { items, unreadable } = parseBulkPaste(raw);
      for (const it of items) addItem(fr, it);

      twiml.message(
        `Bulk paste processed.\n` +
        `Added: ${items.length} | Unreadable: ${unreadable.length}\n` +
        `Items: ${fr.items.length} | Total: ${fmt(totalPct(fr), 2)}%\n\n` +
        `Paste more, or type DONE.\n` +
        `Commands: LIST / REMOVE <name> / DONE / MENU`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    /* ---------------- Estimate mode ---------------- */
    if (session.step === "EST_MODE") {
      const fr = session.fr;

      if (choice === "1") {
        // Quick estimate
        const base = buildPerItemNutrients(fr);
        const diet = sumDiet(base);
        const comp = compareToTargets(fr, diet);

        let msgOut =
          `✅ Nutrient Estimate (Quick)\n` +
          `Animal: ${fr.animal} | Poultry: ${fr.poultryType} | Line: ${fr.strain} | Stage: ${fr.stage} | Form: ${fr.feedForm}\n` +
          `Items: ${fr.items.length} | Total: ${fmt(totalPct(fr), 2)}%\n\n`;

        // Always show key estimates
        const rowsCore = [
          { n: "DM (%)", est: diet.dm, tgt: "-", status: "-" },
          { n: "AMEn (kcal/kg)", est: diet.amen_kcalkg, tgt: "-", status: "-" },
          { n: "CP (%)", est: diet.cp, tgt: "-", status: "-" },
          { n: "EE (%)", est: diet.ee, tgt: "-", status: "-" },
          { n: "CF (%)", est: diet.cf, tgt: "-", status: "-" },
          { n: "Ca (%)", est: diet.ca, tgt: "-", status: "-" },
          { n: "AvP (%)", est: diet.avp, tgt: "-", status: "-" },
          { n: "Na (%)", est: diet.na, tgt: "-", status: "-" },
          { n: "Cl (%)", est: diet.cl, tgt: "-", status: "-" },
          { n: "K (%)",  est: diet.k,  tgt: "-", status: "-" },
          { n: "dLys (%)", est: diet.dig_lys, tgt: "-", status: "-" },
          { n: "dMet (%)", est: diet.dig_met, tgt: "-", status: "-" },
          { n: "dTSAA (%)", est: diet.dig_tsaa, tgt: "-", status: "-" },
          { n: "dThr (%)", est: diet.dig_thr, tgt: "-", status: "-" },
          { n: "dVal (%)", est: diet.dig_val, tgt: "-", status: "-" },
          { n: "dIle (%)", est: diet.dig_ile, tgt: "-", status: "-" },
          { n: "dArg (%)", est: diet.dig_arg, tgt: "-", status: "-" },
          { n: "dTrp (%)", est: diet.dig_trp, tgt: "-", status: "-" }
        ];
        msgOut += formatWhatsAppTable(rowsCore) + "\n\n";

        if (comp.ok) {
          msgOut += `🎯 Targets matched for ${fr.strain.toUpperCase()} (${fr.stage})\n`;
          msgOut += formatWhatsAppTable(comp.rows) + "\n\n";
          msgOut += `Type RESULT to see again, or MENU.`;
        } else {
          msgOut += `ℹ️ ${comp.note}\n\nType RESULT to see again, or MENU.`;
        }

        session.lastReport = msgOut;
        twiml.message(msgOut);
        return res.type("text/xml").send(twiml.toString());
      }

      if (choice === "2") {
        // Lab-assisted: ask DM+CP for majors (>=10%)
        const majors = fr.items.filter(x => (x.pct || 0) >= 10).slice(0, 8); // keep WhatsApp practical
        if (majors.length === 0) {
          twiml.message(`No major ingredients (≥10%) detected.\nReply 1 for Quick estimate.\n\n${ESTIMATE_MODE}`);
          return res.type("text/xml").send(twiml.toString());
        }
        session.step = "LAB_CPDM";
        session._labQueue = majors.map(x => ({ key: x.key, name: x.name, pct: x.pct }));
        session._labIndex = 0;

        const cur = session._labQueue[0];
        twiml.message(
          `Lab-assisted estimate (majors ≥10%)\n\n` +
          `Send DM% and CP% for:\n` +
          `• ${cur.name} (${fmt(cur.pct, 2)}%)\n\n` +
          `Format:\nDM 88 CP 8.8\n(or: 88 8.8)\n\n` +
          `Type SKIP to use defaults.`
        );
        return res.type("text/xml").send(twiml.toString());
      }

      twiml.message(ESTIMATE_MODE);
      return res.type("text/xml").send(twiml.toString());
    }

    /* ---------------- Lab DM+CP capture ---------------- */
    if (session.step === "LAB_CPDM") {
      const fr = session.fr;

      const q = session._labQueue || [];
      const i = session._labIndex || 0;
      const cur = q[i];

      if (!cur) {
        // finalize
        const base = buildPerItemNutrients(fr);
        const withLab = applyLabOverrides(fr, base);
        const diet = sumDiet(withLab);
        const comp = compareToTargets(fr, diet);

        let msgOut =
          `✅ Nutrient Estimate (Lab-assisted)\n` +
          `Animal: ${fr.animal} | Poultry: ${fr.poultryType} | Line: ${fr.strain} | Stage: ${fr.stage} | Form: ${fr.feedForm}\n` +
          `Items: ${fr.items.length} | Total: ${fmt(totalPct(fr), 2)}%\n\n`;

        // key estimates
        const rowsCore = [
          { n: "DM (%)", est: diet.dm, tgt: "-", status: "-" },
          { n: "AMEn (kcal/kg)", est: diet.amen_kcalkg, tgt: "-", status: "-" },
          { n: "CP (%)", est: diet.cp, tgt: "-", status: "-" },
          { n: "EE (%)", est: diet.ee, tgt: "-", status: "-" },
          { n: "CF (%)", est: diet.cf, tgt: "-", status: "-" },
          { n: "Ca (%)", est: diet.ca, tgt: "-", status: "-" },
          { n: "AvP (%)", est: diet.avp, tgt: "-", status: "-" },
          { n: "Na (%)", est: diet.na, tgt: "-", status: "-" },
          { n: "Cl (%)", est: diet.cl, tgt: "-", status: "-" },
          { n: "K (%)",  est: diet.k,  tgt: "-", status: "-" },
          { n: "dLys (%)", est: diet.dig_lys, tgt: "-", status: "-" },
          { n: "dMet (%)", est: diet.dig_met, tgt: "-", status: "-" },
          { n: "dTSAA (%)", est: diet.dig_tsaa, tgt: "-", status: "-" },
          { n: "dThr (%)", est: diet.dig_thr, tgt: "-", status: "-" },
          { n: "dVal (%)", est: diet.dig_val, tgt: "-", status: "-" },
          { n: "dIle (%)", est: diet.dig_ile, tgt: "-", status: "-" },
          { n: "dArg (%)", est: diet.dig_arg, tgt: "-", status: "-" },
          { n: "dTrp (%)", est: diet.dig_trp, tgt: "-", status: "-" }
        ];
        msgOut += formatWhatsAppTable(rowsCore) + "\n\n";

        if (comp.ok) {
          msgOut += `🎯 Targets matched for ${fr.strain.toUpperCase()} (${fr.stage})\n`;
          msgOut += formatWhatsAppTable(comp.rows) + "\n\n";
          msgOut += `Type RESULT to see again, or MENU.`;
        } else {
          msgOut += `ℹ️ ${comp.note}\n\nType RESULT to see again, or MENU.`;
        }

        session.lastReport = msgOut;
        session.step = "MAIN";
        twiml.message(msgOut);
        return res.type("text/xml").send(twiml.toString());
      }

      if (msg === "skip") {
        session._labIndex = i + 1;
      } else {
        // parse "DM 88 CP 8.8" OR "88 8.8"
        let dmVal = null, cpVal = null;

        const dmMatch = raw.match(/dm\s*([0-9]+(?:\.[0-9]+)?)/i);
        const cpMatch = raw.match(/cp\s*([0-9]+(?:\.[0-9]+)?)/i);

        if (dmMatch) dmVal = safeNum(dmMatch[1]);
        if (cpMatch) cpVal = safeNum(cpMatch[1]);

        if (dmVal === null || cpVal === null) {
          // try plain two numbers
          const nums = raw.match(/([0-9]+(?:\.[0-9]+)?)/g) || [];
          if (nums.length >= 2) {
            dmVal = safeNum(nums[0]);
            cpVal = safeNum(nums[1]);
          }
        }

        if (dmVal === null || cpVal === null) {
          twiml.message(
            `Couldn’t read DM+CP.\n\n` +
            `Send for: ${cur.name}\n` +
            `Format: DM 88 CP 8.8 (or: 88 8.8)\n` +
            `Or type SKIP.`
          );
          return res.type("text/xml").send(twiml.toString());
        }

        // store override: dm (%) and cp as-fed (%)
        fr.lab[cur.key] = { dm: dmVal, cp: cpVal };
        session._labIndex = i + 1;
      }

      // ask next
      const next = session._labQueue[session._labIndex];
      if (!next) {
        twiml.message(`✅ Captured lab inputs. Building report...\n(Type MENU anytime)`);
        // will finalize on next webhook call? Better finalize immediately:
        session._labQueue = []; // trigger finalize path
        session._labIndex = 999;
        // Re-run handler quickly by recursion is messy; instead just finalize now:
        const base = buildPerItemNutrients(fr);
        const withLab = applyLabOverrides(fr, base);
        const diet = sumDiet(withLab);
        const comp = compareToTargets(fr, diet);

        let msgOut =
          `✅ Nutrient Estimate (Lab-assisted)\n` +
          `Animal: ${fr.animal} | Poultry: ${fr.poultryType} | Line: ${fr.strain} | Stage: ${fr.stage} | Form: ${fr.feedForm}\n` +
          `Items: ${fr.items.length} | Total: ${fmt(totalPct(fr), 2)}%\n\n`;

        const rowsCore = [
          { n: "DM (%)", est: diet.dm, tgt: "-", status: "-" },
          { n: "AMEn (kcal/kg)", est: diet.amen_kcalkg, tgt: "-", status: "-" },
          { n: "CP (%)", est: diet.cp, tgt: "-", status: "-" },
          { n: "EE (%)", est: diet.ee, tgt: "-", status: "-" },
          { n: "CF (%)", est: diet.cf, tgt: "-", status: "-" },
          { n: "Ca (%)", est: diet.ca, tgt: "-", status: "-" },
          { n: "AvP (%)", est: diet.avp, tgt: "-", status: "-" },
          { n: "Na (%)", est: diet.na, tgt: "-", status: "-" },
          { n: "Cl (%)", est: diet.cl, tgt: "-", status: "-" },
          { n: "K (%)",  est: diet.k,  tgt: "-", status: "-" },
          { n: "dLys (%)", est: diet.dig_lys, tgt: "-", status: "-" },
          { n: "dMet (%)", est: diet.dig_met, tgt: "-", status: "-" },
          { n: "dTSAA (%)", est: diet.dig_tsaa, tgt: "-", status: "-" },
          { n: "dThr (%)", est: diet.dig_thr, tgt: "-", status: "-" },
          { n: "dVal (%)", est: diet.dig_val, tgt: "-", status: "-" },
          { n: "dIle (%)", est: diet.dig_ile, tgt: "-", status: "-" },
          { n: "dArg (%)", est: diet.dig_arg, tgt: "-", status: "-" },
          { n: "dTrp (%)", est: diet.dig_trp, tgt: "-", status: "-" }
        ];
        msgOut += formatWhatsAppTable(rowsCore) + "\n\n";

        if (comp.ok) {
          msgOut += `🎯 Targets matched for ${fr.strain.toUpperCase()} (${fr.stage})\n`;
          msgOut += formatWhatsAppTable(comp.rows) + "\n\n";
          msgOut += `Type RESULT to see again, or MENU.`;
        } else {
          msgOut += `ℹ️ ${comp.note}\n\nType RESULT to see again, or MENU.`;
        }

        session.lastReport = msgOut;
        session.step = "MAIN";
        twiml.message(msgOut);
        return res.type("text/xml").send(twiml.toString());
      }

      twiml.message(
        `Next: send DM% and CP% for:\n` +
        `• ${next.name} (${fmt(next.pct, 2)}%)\n\n` +
        `Format:\nDM 88 CP 8.8\n(or: 88 8.8)\n\n` +
        `Type SKIP to use defaults.`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    // fallback
    twiml.message(`Type MENU.\n\n${VERSION}`);
    return res.type("text/xml").send(twiml.toString());
  } catch (err) {
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("⚠️ NutriPilot error. Type MENU and try again.");
    return res.type("text/xml").send(twiml.toString());
  }
});

/* -------------------------- START -------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NutriPilot running on port ${PORT} — ${VERSION}`));
