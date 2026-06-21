/**
 * Tests.gs — run with runTests() from the Apps Script editor.
 * Covers the pure services (no spreadsheet needed). Returns a summary and logs failures.
 */

function runTests() {
  const results = [];
  const t = function (name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, error: String(e && e.message ? e.message : e) }); }
  };
  const eq = function (a, b, msg) {
    if (a !== b) throw new Error((msg || 'expected') + ': got ' + a + ', want ' + b);
  };
  const approx = function (a, b, eps, msg) {
    if (Math.abs(a - b) > (eps || 1e-6)) throw new Error((msg || 'approx') + ': got ' + a + ', want ' + b);
  };

  // --- Units ---
  t('normalizeUnit handles variants', function () {
    eq(normalizeUnit_('ml'), 'ML');
    eq(normalizeUnit_('Liters'), 'L');
    eq(normalizeUnit_('fl. oz.'), 'FL OZ');
    eq(normalizeUnit_('oz'), 'FL OZ');
    eq(normalizeUnit_('cups'), '');
  });
  t('toMl converts', function () {
    eq(toMl_(750, 'ML'), 750);
    eq(toMl_(1, 'L'), 1000);
    approx(toMl_(1, 'FL OZ'), 29.5735295625);
    eq(Number.isNaN(toMl_(0, 'ML')), true);
    eq(Number.isNaN(toMl_(5, 'cups')), true);
  });
  t('parseBottleSizeMl parses free text', function () {
    eq(parseBottleSizeMl_('750 ML'), 750);
    eq(parseBottleSizeMl_('1 L'), 1000);
    approx(parseBottleSizeMl_('25.4 FL OZ'), 25.4 * 29.5735295625);
    eq(Number.isNaN(parseBottleSizeMl_('a bottle')), true);
  });

  // --- Batch math ---
  t('ingredientBottles: 3 of 6 batch bottles (750ml) from a 5000ml yield, 750ml of a 750ml item', function () {
    const recipe = { bottleCount: 3, yieldAmount: 5000, yieldUnit: 'ML', bottleSizeAmount: 750, bottleSizeUnit: 'ML' };
    const ing = { amount: 750, unit: 'ML' };
    const item = { bottleSizeMl: 750 };
    // (3 * 750 / 5000) * (750/750) = 0.45
    approx(ingredientBottles_(recipe, ing, item), 0.45);
  });
  t('ingredientBottles: zero on bad inputs', function () {
    eq(ingredientBottles_({ bottleCount: 0 }, {}, {}), 0);
    eq(ingredientBottles_({ bottleCount: 2, yieldAmount: 5000, yieldUnit: 'ML', bottleSizeAmount: 750, bottleSizeUnit: 'ML' },
      { amount: 750, unit: 'ML' }, { bottleSizeMl: 0 }), 0);
  });
  t('batchContributions sums across recipes and rounds', function () {
    const recipes = [
      { ingredients: [{ kind: 'inventory', itemId: 'A', amount: 750, unit: 'ML' }],
        bottleCount: 3, yieldAmount: 5000, yieldUnit: 'ML', bottleSizeAmount: 750, bottleSizeUnit: 'ML' },
      { ingredients: [{ kind: 'inventory', itemId: 'A', amount: 1000, unit: 'ML' },
                      { kind: 'custom', name: 'Syrup', amount: 500, unit: 'ML' }],
        bottleCount: 1, yieldAmount: 4000, yieldUnit: 'ML', bottleSizeAmount: 1000, bottleSizeUnit: 'ML' },
    ];
    const map = batchContributions_(recipes, { A: 750 });
    // r1: 0.45 ; r2: (1*1000/4000)*(1000/750)=0.333333 → total ~0.783333
    approx(map.A, 0.783333, 1e-5);
  });
  t('itemTotal folds locations + batch', function () {
    approx(itemTotal_({ BAR: '2', OTHER: '1.5' }, 0.5), 4.0);
  });

  const failed = results.filter((r) => !r.ok);
  failed.forEach((r) => console.error('FAIL ' + r.name + ': ' + r.error));
  const summary = { passed: results.length - failed.length, failed: failed.length, total: results.length, failures: failed };
  console.log('Tests: ' + summary.passed + '/' + summary.total + ' passed');
  return summary;
}
