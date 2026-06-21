/**
 * Api.gs — web entry point + google.script.run endpoints.
 *
 * Endpoints are thin: validate, gate access, call a repo/service, return a typed result
 * { ok, data?, error? }. Mutations run inside a lock. No business logic lives here.
 */

function doGet() {
  const tmpl = HtmlService.createTemplateFromFile('Index');
  let email = '';
  try { email = String(Session.getEffectiveUser().getEmail() || ''); } catch (e) {}
  tmpl.senderEmail = email;
  return tmpl.evaluate()
    .setTitle(APP.NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Inline an HTML partial (Styles / client modules). */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/** Wrap an endpoint body: standard try/catch → { ok, data } | { ok:false, error }. */
function api_(fn) {
  try { return { ok: true, data: fn() }; }
  catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
}

/** Recompute batch contributions from current recipes + item bottle sizes. */
function computeBatchContributions_() {
  const recipes = RecipeIngredientsRepo.assembleAll();
  const bottleMl = new ItemsRepo().bottleSizeMlById();
  return batchContributions_(recipes, bottleMl);
}

/* ----------------------------------------------------------------------------- *
 *  READ
 * ----------------------------------------------------------------------------- */

/** One call to hydrate the whole client. */
function getBootstrap() {
  return api_(function () {
    assertAccess_();
    const settings = new SettingsRepo();
    return {
      app: { name: APP.NAME, version: APP.VERSION },
      ui: { text: settings.get(SETTING_KEYS.UI_TEXT) || DEFAULTS.UI_TEXT,
            colors: settings.get(SETTING_KEYS.UI_COLORS) || {},
            layout: settings.get(SETTING_KEYS.UI_LAYOUT) || {} },
      locations: new LocationsRepo().activeOrdered(),
      categories: new CategoriesRepo().ordered(),
      vendors: new VendorsRepo().all(),
      items: new ItemsRepo().all(),
      counts: new CountsRepo().byItem(),
      sections: new SectionsRepo().ordered(),
      sectionItems: new SectionItemsRepo().bySection(),
      groups: new GroupsRepo().ordered(),
      recipes: RecipeIngredientsRepo.assembleAll(),
      batchContributions: computeBatchContributions_(),
      meta: {
        lastCompleted: settings.get(SETTING_KEYS.META_LAST_COMPLETED) || '',
        initials: settings.get(SETTING_KEYS.META_INITIALS) || '',
      },
    };
  });
}

/* ----------------------------------------------------------------------------- *
 *  COUNTS
 * ----------------------------------------------------------------------------- */

/**
 * Save a batch of count edits.
 * @param {Array} edits  [{ itemId, locationId, qty }]
 */
function saveCounts(edits) {
  return api_(function () {
    assertAccess_();
    return withLock_(function () {
      const counts = new CountsRepo();
      const saved = (edits || []).map(function (e) {
        return counts.setQty(e.itemId, e.locationId, e.qty);
      });
      return { saved: saved.length };
    });
  });
}

/* ----------------------------------------------------------------------------- *
 *  ITEMS
 * ----------------------------------------------------------------------------- */

function createItem(data) {
  return api_(function () {
    assertAccess_();
    return withLock_(function () {
      if (!norm_(data && data.commonName)) throw new Error('Common name is required.');
      const item = new ItemsRepo().create(data || {});
      // Optionally place into a section at the end.
      if (data && data.sectionId) {
        const si = new SectionItemsRepo();
        const existing = si.filter((r) => String(r.sectionId) === String(data.sectionId));
        si.insert({ sectionId: String(data.sectionId), itemId: String(item.id), sortOrder: existing.length + 1 });
      }
      return { item };
    });
  });
}

function updateItem(id, data) {
  return api_(function () {
    assertAccess_();
    return withLock_(function () {
      const item = new ItemsRepo().patch(id, data || {});
      if (!item) throw new Error('Item not found: ' + id);
      return { item, batchContributions: computeBatchContributions_() };
    });
  });
}

function archiveItem(id, archived) {
  return api_(function () {
    assertAccess_();
    return withLock_(function () {
      const item = new ItemsRepo().patch(id, { archived: !!archived });
      if (!item) throw new Error('Item not found: ' + id);
      return { item };
    });
  });
}

function deleteItem(id) {
  return api_(function () {
    assertAccess_();
    return withLock_(function () {
      // Block deletion if used in a recipe.
      const used = new RecipeIngredientsRepo().find((r) => String(r.itemId) === String(id));
      if (used) throw new Error('Cannot delete: item is used in a batch recipe.');
      new SectionItemsRepo().removeWhere((r) => String(r.itemId) === String(id));
      new CountsRepo().removeWhere((r) => String(r.itemId) === String(id));
      const removed = new ItemsRepo().remove(id);
      return { removed };
    });
  });
}

/* ----------------------------------------------------------------------------- *
 *  SECTION MEMBERSHIP / ORDER
 * ----------------------------------------------------------------------------- */

function setSectionItemOrder(sectionId, itemIds) {
  return api_(function () {
    assertAccess_();
    return withLock_(function () {
      new SectionItemsRepo().setOrder(sectionId, itemIds || []);
      return { sectionId, count: (itemIds || []).length };
    });
  });
}

function addItemToSection(sectionId, itemId) {
  return api_(function () {
    assertAccess_();
    return withLock_(function () {
      const si = new SectionItemsRepo();
      const existing = si.filter((r) => String(r.sectionId) === String(sectionId));
      if (existing.some((r) => String(r.itemId) === String(itemId))) return { added: false };
      si.insert({ sectionId: String(sectionId), itemId: String(itemId), sortOrder: existing.length + 1 });
      return { added: true };
    });
  });
}

function removeItemFromSection(sectionId, itemId) {
  return api_(function () {
    assertAccess_();
    return withLock_(function () {
      const removed = new SectionItemsRepo().remove(String(sectionId) + String(itemId));
      return { removed };
    });
  });
}

/* ----------------------------------------------------------------------------- *
 *  RECIPES
 * ----------------------------------------------------------------------------- */

function saveRecipe(payload) {
  return api_(function () {
    assertAccess_();
    return withLock_(function () {
      const recipes = new RecipesRepo();
      const now = nowIso_();
      const id = payload && payload.id ? String(payload.id) : genId_('rec');
      const record = {
        id: id,
        name: norm_(payload.name),
        groupId: String(payload.groupId || ''),
        yieldAmount: num_(payload.yieldAmount, 0),
        yieldUnit: normalizeUnit_(payload.yieldUnit) || 'ML',
        bottleSizeAmount: num_(payload.bottleSizeAmount, 0),
        bottleSizeUnit: normalizeUnit_(payload.bottleSizeUnit) || 'ML',
        bottleCount: round_(num_(payload.bottleCount, 0), 1),
        createdAt: (recipes.byId(id) || {}).createdAt || now,
        updatedAt: now,
      };
      if (!record.name) throw new Error('Recipe name is required.');
      recipes.upsert(record);
      new RecipeIngredientsRepo().setForRecipe(id, payload.ingredients || []);
      return { recipes: RecipeIngredientsRepo.assembleAll(), batchContributions: computeBatchContributions_() };
    });
  });
}

function setRecipeBottleCount(id, bottleCount) {
  return api_(function () {
    assertAccess_();
    return withLock_(function () {
      const updated = new RecipesRepo().update(id, { bottleCount: round_(num_(bottleCount, 0), 1), updatedAt: nowIso_() });
      if (!updated) throw new Error('Recipe not found: ' + id);
      return { recipes: RecipeIngredientsRepo.assembleAll(), batchContributions: computeBatchContributions_() };
    });
  });
}

function deleteRecipe(id) {
  return api_(function () {
    assertAccess_();
    return withLock_(function () {
      new RecipeIngredientsRepo().removeWhere((r) => String(r.recipeId) === String(id));
      new RecipesRepo().remove(id);
      return { recipes: RecipeIngredientsRepo.assembleAll(), batchContributions: computeBatchContributions_() };
    });
  });
}

/* ----------------------------------------------------------------------------- *
 *  ORDER GUIDE
 * ----------------------------------------------------------------------------- */

/** Total on-hand per item = sum(location counts) + batch contribution. */
function onHandTotals_() {
  const counts = new CountsRepo().byItem();
  const batch = computeBatchContributions_();
  const items = new ItemsRepo().all();
  const totals = {};
  items.forEach(function (it) {
    const id = String(it.id);
    totals[id] = itemTotal_(counts[id] || {}, batch[id] || 0);
  });
  return totals;
}

/**
 * Computed order guide grouped by vendor.
 * @param {boolean} includeAtPar  also list items already at/above par
 */
function getOrderGuide(includeAtPar) {
  return api_(function () {
    assertAccess_();
    const items = new ItemsRepo().all();
    const vendorName = {};
    new VendorsRepo().all().forEach(function (v) { vendorName[String(v.id)] = v.name; });
    const groups = buildOrderGuide_(items, onHandTotals_(), { includeAtPar: !!includeAtPar });
    groups.forEach(function (g) { g.vendorName = vendorName[g.vendorId] || g.vendorId || 'UNASSIGNED'; });
    groups.sort(function (a, b) { return String(a.vendorName).localeCompare(String(b.vendorName)); });
    return { groups: groups };
  });
}

/* ----------------------------------------------------------------------------- *
 *  META
 * ----------------------------------------------------------------------------- */

function setMeta(lastCompleted, initials) {
  return api_(function () {
    assertAccess_();
    return withLock_(function () {
      const settings = new SettingsRepo();
      settings.set(SETTING_KEYS.META_LAST_COMPLETED, String(lastCompleted || ''));
      settings.set(SETTING_KEYS.META_INITIALS, String(initials || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3));
      return { ok: true };
    });
  });
}
