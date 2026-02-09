// core/rules/evaluateDeviations.js

function evaluateDeviations(deviations) {
  const rules = {
    // thresholds are percent deviation from requirement
    me:  { warn: -3,  fail: -6, direction: "min" },
    cp:  { warn: -2,  fail: -5, direction: "min" },
    lys: { warn: -2,  fail: -5, direction: "min" },
    met: { warn: -5,  fail: -10, direction: "min" },
    thr: { warn: -2,  fail: -5, direction: "min" },
    ca:  { warn: -5,  fail: -10, direction: "min" },
    avp: { warn: -5,  fail: -10, direction: "min" },
    na:  { warn: -5,  fail: -10, direction: "min" }
  };

  const findings = [];
  let worst = "OK"; // OK, WARN, FAIL

  for (const key of Object.keys(deviations)) {
    const r = rules[key];
    if (!r) continue;

    const pct = deviations[key].pct; // negative means below requirement
    if (pct === null || pct === undefined) continue;

    let status = "OK";

    if (pct <= r.fail) status = "FAIL";
    else if (pct <= r.warn) status = "WARN";

    if (status === "FAIL") worst = "FAIL";
    else if (status === "WARN" && worst !== "FAIL") worst = "WARN";

    findings.push({
      nutrient: key,
      status,
      pct,
      diff: deviations[key].diff
    });
  }

  // Sort: FAIL first, then WARN, then OK
  const rank = { FAIL: 0, WARN: 1, OK: 2 };
  findings.sort((a, b) => rank[a.status] - rank[b.status]);

  return { overall: worst, findings };
}

module.exports = { evaluateDeviations };
