// core/normalize/normalizeFormula.js

function normalizeFormula(items) {
  const total = items.reduce((sum, it) => sum + (Number(it.inclusion) || 0), 0);

  if (!total || total <= 0) {
    return { items: [], total: 0, normalized: false };
  }

  const scaled = items.map(it => ({
    ingredient: it.ingredient,
    inclusion: +(it.inclusion * 100 / total).toFixed(4)
  }));

  const newTotal = +scaled.reduce((s, it) => s + it.inclusion, 0).toFixed(4);

  return {
    items: scaled,
    total: newTotal,
    normalized: Math.abs(total - 100) > 0.01
  };
}

module.exports = { normalizeFormula };
