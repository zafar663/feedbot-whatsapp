// core/utils/fuzzySuggest.js

function bigrams(s) {
  const x = (s || "").toLowerCase();
  const out = [];
  for (let i = 0; i < x.length - 1; i++) out.push(x.slice(i, i + 2));
  return out;
}

function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

function suggestClosest(name, candidates, limit = 5) {
  const n = (name || "").toLowerCase().trim();
  if (!n) return [];

  const ngrams = bigrams(n);

  const scored = (candidates || []).map(c => {
    const score = jaccard(ngrams, bigrams(c));
    return { c, score };
  });

  scored.sort((x, y) => y.score - x.score);

  // Keep only useful suggestions
  return scored
    .filter(x => x.score >= 0.25)
    .slice(0, limit)
    .map(x => x.c);
}

module.exports = { suggestClosest };
