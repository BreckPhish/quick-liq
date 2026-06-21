/**
 * Repositories.gs — typed repositories over TableRepo.
 *
 * Each repo knows its sheet + primary key and adds small domain helpers. Keeping the
 * mapping here means the rest of the app never touches raw cells.
 */

class ItemsRepo extends TableRepo {
  constructor() { super(SHEETS.ITEMS, 'id'); }

  /** Active (non-archived) items. */
  active() { return this.filter((it) => !bool_(it.archived)); }

  /** Map itemId → bottle size in mL (for batch math). */
  bottleSizeMlById() {
    const map = {};
    this.all().forEach((it) => {
      const ml = toMl_(it.bottleSizeAmount, it.bottleSizeUnit);
      if (Number.isFinite(ml)) map[String(it.id)] = ml;
    });
    return map;
  }

  create(data) {
    const now = nowIso_();
    const item = {
      id: nextNumericId_(),
      commonName: norm_(data.commonName),
      orderName: String(data.orderName || ''),
      categoryId: String(data.categoryId || ''),
      vendorId: String(data.vendorId || ''),
      bottleSizeAmount: num_(data.bottleSizeAmount, ''),
      bottleSizeUnit: normalizeUnit_(data.bottleSizeUnit) || '',
      par: data.par == null ? '' : data.par,
      cost: data.cost == null ? '' : data.cost,
      caseSize: data.caseSize == null ? '' : data.caseSize,
      notes: String(data.notes || ''),
      archived: false,
      createdAt: now,
      updatedAt: now,
    };
    return this.insert(item);
  }

  patch(id, data) {
    const next = Object.assign({}, data, { updatedAt: nowIso_() });
    return this.update(id, next);
  }
}

class LocationsRepo extends TableRepo {
  constructor() { super(SHEETS.LOCATIONS, 'id'); }
  activeOrdered() {
    return this.filter((l) => bool_(l.active))
      .sort((a, b) => num_(a.sortOrder) - num_(b.sortOrder));
  }
}

class CountsRepo extends TableRepo {
  constructor() { super(SHEETS.COUNTS, ['itemId', 'locationId']); }

  /** Set (or clear) one item/location count. Empty/0 qty removes the row. */
  setQty(itemId, locationId, qty) {
    const value = num_(qty, NaN);
    if (!Number.isFinite(value) || value === 0) {
      this.remove(this.keyOf({ itemId: String(itemId), locationId: String(locationId) }));
      return { itemId, locationId, qty: 0 };
    }
    const row = { itemId: String(itemId), locationId: String(locationId), qty: value, updatedAt: nowIso_() };
    this.upsert(row);
    return row;
  }

  /** Map itemId → { locationId: qty }. */
  byItem() {
    const map = {};
    this.all().forEach((c) => {
      const id = String(c.itemId);
      if (!map[id]) map[id] = {};
      map[id][String(c.locationId)] = num_(c.qty, 0);
    });
    return map;
  }
}

class SectionsRepo extends TableRepo {
  constructor() { super(SHEETS.SECTIONS, 'id'); }
  ordered() { return this.all().sort((a, b) => num_(a.sortOrder) - num_(b.sortOrder)); }
}

class SectionItemsRepo extends TableRepo {
  constructor() { super(SHEETS.SECTION_ITEMS, ['sectionId', 'itemId']); }

  /** Map sectionId → [itemId] in sort order. */
  bySection() {
    const map = {};
    this.all()
      .sort((a, b) => num_(a.sortOrder) - num_(b.sortOrder))
      .forEach((si) => {
        const sid = String(si.sectionId);
        (map[sid] || (map[sid] = [])).push(String(si.itemId));
      });
    return map;
  }

  setOrder(sectionId, orderedItemIds) {
    this.removeWhere((si) => String(si.sectionId) === String(sectionId));
    this.insertMany(orderedItemIds.map((itemId, i) => ({
      sectionId: String(sectionId), itemId: String(itemId), sortOrder: i + 1,
    })));
  }
}

class GroupsRepo extends TableRepo {
  constructor() { super(SHEETS.GROUPS, 'id'); }
  ordered() { return this.all().sort((a, b) => num_(a.sortOrder) - num_(b.sortOrder)); }
}

class VendorsRepo extends TableRepo {
  constructor() { super(SHEETS.VENDORS, 'id'); }
}

class CategoriesRepo extends TableRepo {
  constructor() { super(SHEETS.CATEGORIES, 'id'); }
  ordered() { return this.all().sort((a, b) => num_(a.sortOrder) - num_(b.sortOrder)); }
}

class RecipesRepo extends TableRepo {
  constructor() { super(SHEETS.RECIPES, 'id'); }
}

class RecipeIngredientsRepo extends TableRepo {
  constructor() { super(SHEETS.RECIPE_INGREDIENTS, ['recipeId', 'itemId', 'name']); }

  forRecipe(recipeId) { return this.filter((r) => String(r.recipeId) === String(recipeId)); }

  /** Replace all ingredients for a recipe. */
  setForRecipe(recipeId, ingredients) {
    this.removeWhere((r) => String(r.recipeId) === String(recipeId));
    this.insertMany((ingredients || []).map((ing) => ({
      recipeId: String(recipeId),
      kind: ing.kind === 'custom' ? 'custom' : 'inventory',
      itemId: String(ing.itemId || ''),
      name: String(ing.name || ''),
      amount: num_(ing.amount, ''),
      unit: normalizeUnit_(ing.unit) || '',
      metaJson: toJson_(ing.meta || {}),
    })));
  }

  /** All recipes assembled with their ingredients (for batch math / UI). */
  static assembleAll() {
    const recipes = new RecipesRepo().all();
    const ingredients = new RecipeIngredientsRepo().all();
    const byRecipe = {};
    ingredients.forEach((ing) => {
      (byRecipe[String(ing.recipeId)] || (byRecipe[String(ing.recipeId)] = [])).push({
        kind: ing.kind, itemId: String(ing.itemId || ''), name: ing.name,
        amount: num_(ing.amount, 0), unit: ing.unit, meta: parseJson_(ing.metaJson, {}),
      });
    });
    return recipes.map((r) => Object.assign({}, r, { ingredients: byRecipe[String(r.id)] || [] }));
  }
}

class SettingsRepo extends TableRepo {
  constructor() { super(SHEETS.SETTINGS, 'key'); }

  /** Get a parsed JSON value, or null if missing. */
  get(key) {
    const row = this.byId(key);
    if (!row) return null;
    return parseJson_(row.value, null);
  }

  /** Store a value as JSON. */
  set(key, value) {
    this.upsert({ key: String(key), value: toJson_(value) });
    return value;
  }
}
