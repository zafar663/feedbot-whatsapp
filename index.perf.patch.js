"use strict";
// ─── PATCH INSTRUCTIONS for index.js ─────────────────────────────────────────
// This file documents the changes to apply to feedbot-whatsapp/index.js
// to add the PERF command and performance analysis flow.
//
// DO NOT require() this file — it is documentation only.
// Apply changes manually or via a patch script.
//
// ─────────────────────────────────────────────────────────────────────────────
// STEP 1: Add requires at top of index.js (after existing requires)
// ─────────────────────────────────────────────────────────────────────────────
//
// const { parsePerfText, looksLikePerfData } = require("./core/perf/perf-parser");
// const { analyzePerformance }               = require("./core/perf/perf-analyzer");
// const { buildPerfTable, buildAdviceText }  = require("./core/perf/perf-formatter");
// const { parseBreedFromText, parseAgeFromText, buildContextPrompt } = require("./core/perf/perf-context");
//
// ─────────────────────────────────────────────────────────────────────────────
// STEP 2: Add to whatsappHandler() — after the RESULT command block
// ─────────────────────────────────────────────────────────────────────────────
//
// // ---------------- PERF command ----------------
// if (/^PERF$/i.test(Body)) {
//   const last = session?.last_perf_data;
//   if (!last) return "No performance data stored. Send farm data first (e.g. 'Ross308 day28, BW 1420g, FCR 1.85, mort 2.1%')";
//   const result = analyzePerformance(last.parsed, last.context);
//   return buildPerfTable({ result, context: last.context });
// }
//
// // ---------------- ADVICE command ----------------
// if (/^ADVICE$/i.test(Body)) {
//   const last = session?.last_perf_result;
//   if (!last) return "No performance result stored. Send farm data and check it first.";
//   return buildAdviceText(last);
// }
//
// // ---------------- BREED INFO command ----------------
// if (/^BREED INFO$/i.test(Body)) {
//   const { listBreeds } = require("./core/breed-standards/breed-standards.data");
//   return "Available breeds:\n" + listBreeds().join("\n");
// }
//
// // ---------------- Auto-detect perf data in text ----------------
// if (NumMedia === 0 && looksLikePerfData(Body)) {
//   const parsed = parsePerfText(Body);
//   const breed  = parseBreedFromText(Body) || session?.perf_context?.breed;
//   const ageInfo = parseAgeFromText(Body)  || session?.perf_context;
//
//   if (!breed || !ageInfo) {
//     session.pending_perf_data = { text: Body, parsed };
//     session.updatedAt = nowMs();
//     return buildContextPrompt();
//   }
//
//   const context = { breed, age: ageInfo.age, ageUnit: ageInfo.ageUnit };
//   const result  = analyzePerformance(parsed, context);
//
//   session.last_perf_data   = { parsed, context };
//   session.last_perf_result = result;
//   session.updatedAt = nowMs();
//
//   const reply = buildPerfTable({ result, context });
//   if (result.overall === "FAIL" || result.overall === "WARN") {
//     return `${reply}\n\nReply ADVICE for recommendations.`;
//   }
//   return reply;
// }
//
// ─────────────────────────────────────────────────────────────────────────────
// STEP 3: Add perf_context and pending_perf_data to getSession() fresh object
// ─────────────────────────────────────────────────────────────────────────────
//   perf_context: null,
//   pending_perf_data: null,
//   last_perf_data: null,
//   last_perf_result: null,
