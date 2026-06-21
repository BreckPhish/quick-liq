/**
 * BatchService.gs — pure batch-cocktail math. No spreadsheet access.
 *
 * A batch recipe ties up base liquor in pre-made batch bottles. Given how many batch
 * bottles are on hand, we compute how many *bottles of each base liquor* that represents,
 * so it can be folded into inventory counts and order demand.
 */

/**
 * Bottles of one inventory ingredient consumed by the batch bottles currently on hand.
 *
 * @param {Object} recipe     { bottleCount, yieldAmount, yieldUnit, bottleSizeAmount, bottleSizeUnit }
 * @param {Object} ingredient { amount, unit }  amount of this ingredient per full batch
 * @param {Object} item       { bottleSizeMl }  the inventory item's own bottle size in mL
 * @returns {number} bottles (0 if any input is invalid)
 */
function ingredientBottles_(recipe, ingredient, item) {
  const bottleCount = Number(recipe && recipe.bottleCount) || 0;
  const yieldMl = toMl_(recipe && recipe.yieldAmount, recipe && recipe.yieldUnit);
  const batchBottleMl = toMl_(recipe && recipe.bottleSizeAmount, recipe && recipe.bottleSizeUnit);
  const ingredientMl = toMl_(ingredient && ingredient.amount, ingredient && ingredient.unit);
  const itemBottleMl = Number(item && item.bottleSizeMl);

  if (bottleCount <= 0) return 0;
  if (![yieldMl, batchBottleMl, ingredientMl, itemBottleMl].every(Number.isFinite)) return 0;
  if (itemBottleMl <= 0 || yieldMl <= 0) return 0;

  // fraction of a full batch currently on hand × ingredient's share of one item bottle
  return ((bottleCount * batchBottleMl) / yieldMl) * (ingredientMl / itemBottleMl);
}

/**
 * Sum batch contributions across all recipes → { itemId: bottles }.
 *
 * @param {Array}  recipes        each with .ingredients[] (kind 'inventory' have .itemId)
 * @param {Object} itemBottleMlById  map itemId → bottle size in mL
 * @returns {Object} map itemId → total bottles (rounded to 6 dp)
 */
function batchContributions_(recipes, itemBottleMlById) {
  const totals = {};
  (recipes || []).forEach(function (recipe) {
    (recipe && recipe.ingredients || []).forEach(function (ing) {
      if (!ing || ing.kind === 'custom') return;
      const itemId = String(ing.itemId == null ? '' : ing.itemId).trim();
      if (!itemId) return;
      const bottleSizeMl = Number(itemBottleMlById && itemBottleMlById[itemId]);
      if (!Number.isFinite(bottleSizeMl) || bottleSizeMl <= 0) return;
      const bottles = ingredientBottles_(recipe, ing, { bottleSizeMl: bottleSizeMl });
      if (bottles > 0) totals[itemId] = (totals[itemId] || 0) + bottles;
    });
  });
  Object.keys(totals).forEach(function (id) { totals[id] = round_(totals[id], 6); });
  return totals;
}

/**
 * Inventory total for one item: sum of location counts + batch contribution.
 * @param {Object} locationQtys  map locationId → qty (numbers/strings)
 * @param {number} batchBottles  contribution from batchContributions_
 * @returns {number} rounded to 1 dp
 */
function itemTotal_(locationQtys, batchBottles) {
  let sum = Number(batchBottles) || 0;
  Object.keys(locationQtys || {}).forEach(function (locId) {
    sum += num_(locationQtys[locId], 0);
  });
  return round_(sum, 1);
}
