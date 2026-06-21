/**
 * 3b_OrderingService.gs — pure order-guide math. No spreadsheet access.
 *
 * v1 injected a LET/VLOOKUP formula into native Sheets tables to drive order quantities.
 * v2 computes order suggestions in code from on-hand totals vs. par, so the logic is
 * explicit, testable, and not tied to spreadsheet table geometry.
 */

/**
 * Suggested order for one item.
 * @param {Object} item     { par, caseSize }
 * @param {number} onHand   total on-hand (location counts + batch contribution)
 * @returns {Object} { par, onHand, deficit, suggestedUnits, suggestedCases }
 *                    suggestedUnits is whole bottles needed to reach par (ceil of deficit).
 */
function orderSuggestion_(item, onHand) {
  const par = num_(item && item.par, 0);
  const have = num_(onHand, 0);
  const caseSize = num_(item && item.caseSize, 0);
  const deficit = round_(par - have, 2);
  const suggestedUnits = par > 0 && deficit > 0 ? Math.ceil(deficit) : 0;
  const suggestedCases = caseSize > 0 && suggestedUnits > 0
    ? Math.ceil(suggestedUnits / caseSize) : 0;
  return { par: par, onHand: round_(have, 1), deficit: deficit, suggestedUnits: suggestedUnits, suggestedCases: suggestedCases };
}

/**
 * Build an order guide grouped by vendor.
 * @param {Array}  items        item records (id, commonName, orderName, vendorId, par, caseSize)
 * @param {Object} onHandById   map itemId → total on-hand
 * @param {Object} opts         { includeAtPar:false } — when true, list items even at/above par
 * @returns {Array} [{ vendorId, lines:[{ itemId, name, orderName, ...suggestion }] }]
 */
function buildOrderGuide_(items, onHandById, opts) {
  const includeAtPar = !!(opts && opts.includeAtPar);
  const byVendor = {};
  (items || []).forEach(function (it) {
    if (bool_(it.archived)) return;
    const onHand = num_(onHandById && onHandById[String(it.id)], 0);
    const s = orderSuggestion_(it, onHand);
    if (!includeAtPar && s.suggestedUnits <= 0) return;
    const vendorId = String(it.vendorId || '');
    (byVendor[vendorId] || (byVendor[vendorId] = [])).push({
      itemId: String(it.id),
      name: String(it.commonName || ''),
      orderName: String(it.orderName || it.commonName || ''),
      onHand: s.onHand, par: s.par,
      suggestedUnits: s.suggestedUnits, suggestedCases: s.suggestedCases,
    });
  });
  return Object.keys(byVendor).map(function (vendorId) {
    const lines = byVendor[vendorId].sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });
    return { vendorId: vendorId, lines: lines };
  });
}
