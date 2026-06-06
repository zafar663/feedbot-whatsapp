const axios = require("axios");
const { applyIngredientRulesToPool } = require("../nutripilot-agrocore/core/services/ingredient-rules.service.cjs");

const payload = {
  objective: "least_cost",
  optimization_profile: "deep_fix_cost_ross308_starter",
  locale: "US",
  region: "global",
  version: "v1",
  species: "poultry",
  type: "broiler",
  production: "meat",
  breed: "Ross308",
  phase: "starter",

  ingredient_pool: [
    { id:"corn_grain_avg", ingredient_name:"Corn", inclusion:55, min:35, max:75, cost:0.30, enabled:true, nutrient_profile:{ me:3390, cp:8, ca:0.03, avp:0.08, na:0.02, cl:0.05, k:0.30, sid_lys:0.20, sid_met:0.18, sid_metcys:0.30, sid_thr:0.25, sid_trp:0.06, sid_arg:0.35, sid_val:0.35, sid_ile:0.25, sid_leu:0.80 } },
    { id:"soybean_meal_44_5_cp", ingredient_name:"SBM 44.5", inclusion:35, min:20, max:45, cost:0.70, enabled:true, nutrient_profile:{ me:2450, cp:44.5, ca:0.30, avp:0.20, na:0.02, cl:0.05, k:2.10, sid_lys:2.60, sid_met:0.55, sid_metcys:1.15, sid_thr:1.60, sid_trp:0.55, sid_arg:3.10, sid_val:1.85, sid_ile:1.75, sid_leu:3.20 } },
    { id:"fish_meal_54_cp", ingredient_name:"Fish Meal 54", inclusion:3, min:0, max:8, cost:1.20, enabled:true, nutrient_profile:{ me:2850, cp:54, ca:5.0, avp:2.5, na:0.50, cl:0.60, k:0.80, sid_lys:3.80, sid_met:1.35, sid_metcys:1.80, sid_thr:2.20, sid_trp:0.50, sid_arg:3.40, sid_val:2.60, sid_ile:2.20, sid_leu:4.20 } },
    { id:"soy_oil", ingredient_name:"Soy Oil", inclusion:2, min:0, max:8, cost:0.90, enabled:true, nutrient_profile:{ me:9000, cp:0, ca:0, avp:0, na:0, cl:0, k:0, sid_lys:0, sid_met:0, sid_metcys:0, sid_thr:0, sid_trp:0, sid_arg:0, sid_val:0, sid_ile:0, sid_leu:0 } },
    { id:"limestone", ingredient_name:"Limestone", inclusion:0.5, min:0, max:2, cost:0.10, enabled:true, nutrient_profile:{ me:0, cp:0, ca:38, avp:0, na:0, cl:0, k:0, sid_lys:0, sid_met:0, sid_metcys:0, sid_thr:0, sid_trp:0, sid_arg:0, sid_val:0, sid_ile:0, sid_leu:0 } },
    { id:"dcp", ingredient_name:"DCP", inclusion:0.5, min:0, max:2, cost:0.60, enabled:true, nutrient_profile:{ me:0, cp:0, ca:23, avp:18, na:0, cl:0, k:0, sid_lys:0, sid_met:0, sid_metcys:0, sid_thr:0, sid_trp:0, sid_arg:0, sid_val:0, sid_ile:0, sid_leu:0 } },
    { id:"salt", ingredient_name:"Salt", inclusion:0.2, min:0, max:0.5, cost:0.12, enabled:true, nutrient_profile:{ me:0, cp:0, ca:0, avp:0, na:39, cl:60, k:0, sid_lys:0, sid_met:0, sid_metcys:0, sid_thr:0, sid_trp:0, sid_arg:0, sid_val:0, sid_ile:0, sid_leu:0 } },
    { id:"dl_met", ingredient_name:"DL-Met", inclusion:0.2, min:0, max:1, cost:4.00, enabled:true, nutrient_profile:{ me:0, cp:0, ca:0, avp:0, na:0, cl:0, k:0, sid_lys:0, sid_met:99, sid_metcys:99, sid_thr:0, sid_trp:0, sid_arg:0, sid_val:0, sid_ile:0, sid_leu:0 } },
    { id:"l_lys_hcl", ingredient_name:"L-Lys HCl", inclusion:0.1, min:0, max:1, cost:3.00, enabled:true, nutrient_profile:{ me:0, cp:0, ca:0, avp:0, na:0, cl:0, k:0, sid_lys:78, sid_met:0, sid_metcys:0, sid_thr:0, sid_trp:0, sid_arg:0, sid_val:0, sid_ile:0, sid_leu:0 } }
  ],

  starting_formula: [
    { id:"corn_grain_avg", inclusion:55 },
    { id:"soybean_meal_44_5_cp", inclusion:35 },
    { id:"fish_meal_54_cp", inclusion:3 },
    { id:"soy_oil", inclusion:2 },
    { id:"limestone", inclusion:0.5 },
    { id:"dcp", inclusion:0.5 },
    { id:"salt", inclusion:0.2 },
    { id:"dl_met", inclusion:0.2 },
    { id:"l_lys_hcl", inclusion:0.1 }
  ],

  nutrient_constraints: [
    { key:"me", min:2975, target:2975, max:null, enabled:true },
    { key:"cp", min:23, target:23, max:null, enabled:true },
    { key:"ca", min:0.95, target:0.95, max:null, enabled:true },
    { key:"avp", min:0.5, target:0.5, max:null, enabled:true },
    { key:"na", min:0.18, target:0.18, max:null, enabled:true },
    { key:"cl", min:0.18, target:0.18, max:null, enabled:true },
    { key:"k", min:0.6, target:0.6, max:null, enabled:true },
    { key:"sid_lys", min:1.32, target:1.32, max:null, enabled:true },
    { key:"sid_met", min:0.55, target:0.55, max:null, enabled:true },
    { key:"sid_metcys", min:1.0, target:1.0, max:null, enabled:true },
    { key:"sid_thr", min:0.88, target:0.88, max:null, enabled:true },
    { key:"sid_trp", min:0.21, target:0.21, max:null, enabled:true },
    { key:"sid_arg", min:1.4, target:1.4, max:null, enabled:true },
    { key:"sid_val", min:1.0, target:1.0, max:null, enabled:true },
    { key:"sid_ile", min:0.88, target:0.88, max:null, enabled:true },
    { key:"sid_leu", min:1.45, target:1.45, max:null, enabled:true }
  ]
};

async function main() {
  const ruleResult = applyIngredientRulesToPool(payload.ingredient_pool, {
    species: payload.species,
    type: payload.type,
    production: payload.production,
    breed: payload.breed,
    phase: payload.phase
  });

  payload.ingredient_pool = ruleResult.ingredient_pool;
  payload.practical_rule_version = ruleResult.rule_version;
  payload.practical_rule_warnings = ruleResult.warnings;
  payload.practical_rule_detected = ruleResult.detected;

  console.log("\nRULE RESULT:");
  console.log(JSON.stringify({
    practical_rule_version: payload.practical_rule_version,
    practical_rule_detected: payload.practical_rule_detected,
    practical_rule_warnings: payload.practical_rule_warnings,
    fish_meal_after_rules: payload.ingredient_pool.find(x => x.id === "fish_meal_54_cp")
  }, null, 2));

  const resp = await axios.post("http://localhost:3001/v1/optimize", payload, {
    timeout: 30000,
    validateStatus: () => true
  });

  console.log("\nOPTIMIZER RESULT:");
  console.log(JSON.stringify({
    status: resp.data?.status,
    cost_summary: resp.data?.cost_summary,
    formula_summary: resp.data?.formula_summary,
    nutrient_results: resp.data?.nutrient_results,
    optimized_formula: resp.data?.optimized_formula,
    starting_formula_comparison: resp.data?.starting_formula_comparison,
    practical_rule_version: payload.practical_rule_version,
    practical_rule_detected: payload.practical_rule_detected
  }, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
