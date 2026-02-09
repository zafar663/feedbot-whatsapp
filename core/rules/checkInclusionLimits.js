// core/rules/checkInclusionLimits.js

function statusRank(s) {
  return s === "FAIL" ? 2 : s === "WARN" ? 1 : 0; // higher = worse
}

function checkInclusionLimits(normalizedItems, limitsForKey) {
  const findings = [];
  let overall = "OK";

  // Build map of ingredient -> inclusion
  const map = {};
  for (const it of normalizedItems || []) {
    map[it.ingredient] = Number(it.inclusion) || 0;
  }

  // Evaluate only ingredients that have limits defined
  for (const ingredient of Object.keys(limitsForKey || {})) {
    const lim = limitsForKey[ingredient];
    const val = map[ingredient] ?? 0;

    let status = "OK";
    let reason = "within range";

    // Hard limits (FAIL)
    if (typeof lim.max === "number" && val > lim.max) {
      status = "FAIL";
      reason = `above hard max (${lim.max}%)`;
    } else if (typeof lim.min === "number" && val < lim.min) {
      status = "FAIL";
      reason = `below hard min (${lim.min}%)`;
    }
    // Soft recommended (WARN) - only if not already FAIL
    else {
      if (typeof lim.rec_max === "number" && val > lim.rec_max) {
        status = "WARN";
        reason = `above recommended max (${lim.rec_max}%)`;
      } else if (typeof lim.rec_min === "number" && val < lim.rec_min) {
        status = "WARN";
        reason = `below recommended min (${lim.rec_min}%)`;
      }
    }

    if (statusRank(status) > statusRank(overall)) overall = status;

    findings.push({
      ingredient,
      inclusion: +val.toFixed(4),
      limits: lim,
      status,
      reason
    });
  }

  // Sort FAIL first, then WARN, then OK
  const order = { FAIL: 0, WARN: 1, OK: 2 };
  findings.sort((a, b) => order[a.status] - order[b.status]);

  return { overall, findings };
}

module.exports = { checkInclusionLimits };
