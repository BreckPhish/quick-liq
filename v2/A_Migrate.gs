/**
 * A_Migrate.gs — one-time importer from a legacy v1 spreadsheet into the v2 tables.
 *
 * v2 lives in its own (new) spreadsheet. This reads the OLD spreadsheet by id and
 * populates the normalized v2 tables in the active spreadsheet. Run setup() first.
 *
 *   migrateFromV1('OLD_SPREADSHEET_ID')   // from the Apps Script editor
 *
 * Faithful where it matters (items, counts, sections, membership, groups, recipes,
 * vendors, archived). Intentional simplifications:
 *   - v1 per-cell edit locks (stored as cell background color) are NOT migrated; v2
 *     models column enablement per-section instead (configure in Settings later).
 */

const V1 = Object.freeze({
  INVENT: 'INVENT',
  APP_SETTINGS: '_APP_SETTINGS',
  SECTION_GROUPS: 'SECTION GROUPS',
  BATCH_RECIPES: 'BATCH RECIPES',
  // 1-based legacy column indices on INVENT.
  COL: { B: 2, C: 3, D: 4, E: 5, G: 7, H: 8, J: 10, M: 13, N: 14, O: 15, P: 16, Q: 17, R: 18 },
});

function migrateFromV1(sourceSpreadsheetId) {
  if (!sourceSpreadsheetId) throw new Error('Pass the legacy spreadsheet id.');
  return withLock_(function () {
    setup(); // ensure v2 tables exist + defaults seeded
    const src = SpreadsheetApp.openById(sourceSpreadsheetId);

    const summary = { items: 0, counts: 0, sections: 0, sectionItems: 0, groups: 0, recipes: 0, vendors: 0, archived: 0 };

    // Lookups that create-on-demand.
    const catRepo = new CategoriesRepo();
    const vendorRepo = new VendorsRepo();
    const catByName = indexByNameLower_(catRepo.all());
    const vendorByName = indexByNameLower_(vendorRepo.all());

    const ensureCategory = function (name) {
      const key = String(name || '').trim(); if (!key) return '';
      const lc = key.toLowerCase();
      if (catByName[lc]) return catByName[lc];
      const id = makeKey_(key) || genId_('cat');
      catRepo.insert({ id: id, name: norm_(key), sortOrder: catRepo.all().length + 1 });
      catByName[lc] = id; return id;
    };
    const ensureVendor = function (name) {
      const key = String(name || '').trim(); if (!key) return '';
      const lc = key.toLowerCase();
      if (vendorByName[lc]) return vendorByName[lc];
      const id = makeKey_(key) || genId_('ven');
      vendorRepo.insert({ id: id, name: norm_(key), ref: '', repName: '', repPhone: '', repEmail: '', orderDaysJson: '[]', sheetName: norm_(key), active: true });
      vendorByName[lc] = id; summary.vendors++; return id;
    };

    /* ---- Parse INVENT: sections + items + counts ---- */
    const invent = src.getSheetByName(V1.INVENT);
    const sectionsRepo = new SectionsRepo();
    const sectionByKey = {};
    sectionsRepo.all().forEach(function (s) { sectionByKey[String(s.id)] = true; });

    const itemRows = [];        // for Items insertMany
    const countRows = [];       // for Counts insertMany
    const sectionItemRows = []; // for SectionItems insertMany
    const sectionOrderCounter = {};
    let maxNumericId = 1000;

    if (invent) {
      const values = invent.getDataRange().getValues();
      const C = V1.COL;
      let currentSectionId = '';
      let sortInSection = 0;
      for (let r = 1; r < values.length; r++) {
        const row = values[r];
        const b = String(row[C.B - 1] == null ? '' : row[C.B - 1]).trim();
        const idVal = String(row[C.M - 1] == null ? '' : row[C.M - 1]).trim();
        if (!b && !idVal) continue;
        const isHeading = b && !idVal;
        if (isHeading) {
          const key = makeKey_(b);
          currentSectionId = key;
          sortInSection = 0;
          if (!sectionByKey[key]) {
            sectionsRepo.insert({ id: key, name: norm_(b), type: 'home', groupId: '',
              sortOrder: Object.keys(sectionByKey).length + 1, color: '', headingAlign: 'left',
              columnsJson: '{}', createdAt: nowIso_() });
            sectionByKey[key] = true; summary.sections++;
          }
          continue;
        }
        // Item row
        const id = idVal || String(nextNumericId_());
        const numeric = parseInt(id, 10);
        if (Number.isFinite(numeric) && numeric > maxNumericId) maxNumericId = numeric;
        const sizeText = String(row[C.D - 1] == null ? '' : row[C.D - 1]).trim();
        const sizeMatch = sizeText.match(/^\s*(\d+(?:\.\d+)?)\s*(.*)$/);
        const now = nowIso_();
        itemRows.push({
          id: id,
          commonName: norm_(b),
          orderName: String(row[C.C - 1] || ''),
          categoryId: ensureCategory(row[C.N - 1]),
          vendorId: ensureVendor(row[C.O - 1]),
          bottleSizeAmount: sizeMatch ? Number(sizeMatch[1]) : '',
          bottleSizeUnit: sizeMatch ? (normalizeUnit_(sizeMatch[2]) || '') : '',
          par: row[C.E - 1] == null ? '' : row[C.E - 1],
          cost: row[C.P - 1] == null ? '' : row[C.P - 1],
          caseSize: row[C.Q - 1] == null ? '' : row[C.Q - 1],
          notes: String(row[C.R - 1] || ''),
          archived: false, createdAt: now, updatedAt: now,
        });
        summary.items++;
        // Counts → BAR/OTHER/OFFICE
        [['BAR', C.G], ['OTHER', C.H], ['OFFICE', C.J]].forEach(function (pair) {
          const q = num_(row[pair[1] - 1], NaN);
          if (Number.isFinite(q) && q !== 0) {
            countRows.push({ itemId: id, locationId: pair[0], qty: q, updatedAt: now });
            summary.counts++;
          }
        });
        // Membership into current section
        if (currentSectionId) {
          sortInSection++;
          sectionItemRows.push({ sectionId: currentSectionId, itemId: id, sortOrder: sortInSection });
          summary.sectionItems++;
        }
      }
    }

    /* ---- Legacy uiSettings: shortcuts, secondary sections, archived ---- */
    const ui = readLegacyJson_(src, V1.APP_SETTINGS, 'UI_SETTINGS_JSON') || {};
    // Secondary sections → v2 sections + membership
    (Array.isArray(ui.secondarySections) ? ui.secondarySections : []).forEach(function (sec) {
      const key = sec.key || makeKey_(sec.label || sec.heading || '');
      if (!key) return;
      if (!sectionByKey[key]) {
        sectionsRepo.insert({ id: key, name: norm_(sec.label || sec.heading || key), type: 'secondary', groupId: '',
          sortOrder: Object.keys(sectionByKey).length + 1, color: '', headingAlign: 'left', columnsJson: '{}', createdAt: nowIso_() });
        sectionByKey[key] = true; summary.sections++;
      }
      (Array.isArray(sec.itemIds) ? sec.itemIds : []).forEach(function (itemId, i) {
        sectionItemRows.push({ sectionId: key, itemId: String(itemId), sortOrder: i + 1 });
        summary.sectionItems++;
      });
    });
    // Shortcuts (item pinned into a home section) → membership
    const shortcuts = ui.sectionShortcuts && typeof ui.sectionShortcuts === 'object' ? ui.sectionShortcuts : {};
    Object.keys(shortcuts).forEach(function (sectionKey) {
      (Array.isArray(shortcuts[sectionKey]) ? shortcuts[sectionKey] : []).forEach(function (itemId, i) {
        sectionItemRows.push({ sectionId: sectionKey, itemId: String(itemId), sortOrder: 9000 + i });
        summary.sectionItems++;
      });
    });
    const archivedIds = Array.isArray(ui.archivedItemIds) ? ui.archivedItemIds.map(String) : [];

    /* ---- Bulk write items / counts / membership ---- */
    if (archivedIds.length) {
      const arch = {}; archivedIds.forEach(function (id) { arch[id] = true; });
      itemRows.forEach(function (it) { if (arch[String(it.id)]) { it.archived = true; summary.archived++; } });
    }
    if (itemRows.length) new ItemsRepo().insertMany(itemRows);
    if (countRows.length) new CountsRepo().insertMany(countRows);
    if (sectionItemRows.length) new SectionItemsRepo().insertMany(dedupeSectionItems_(sectionItemRows));

    // Keep the numeric id counter ahead of any migrated id.
    PropertiesService.getScriptProperties().setProperty(APP.PROP_NEXT_NUMERIC, String(maxNumericId + 1));

    /* ---- Groups ---- */
    const groups = readLegacyJson_(src, V1.SECTION_GROUPS, 'SECTION_GROUPS_JSON') || [];
    if (Array.isArray(groups) && groups.length) {
      const groupsRepo = new GroupsRepo();
      groups.forEach(function (g, i) {
        const id = g.key || makeKey_(g.name || ('group' + i));
        groupsRepo.upsert({ id: id, name: norm_(g.name || id), parentGroupId: '', sortOrder: i + 1,
          color: g.color || '', headingAlign: g.headingAlign || 'left', columnsJson: toJson_(g.columns || {}), createdAt: nowIso_() });
        summary.groups++;
      });
      // Second pass: parent links + section membership
      groups.forEach(function (g) {
        const id = g.key || makeKey_(g.name || '');
        (Array.isArray(g.groupKeys) ? g.groupKeys : []).forEach(function (childKey) {
          groupsRepo.update(childKey, { parentGroupId: id });
        });
        (Array.isArray(g.sectionKeys) ? g.sectionKeys : []).forEach(function (sk) {
          sectionsRepo.update(sk, { groupId: id });
        });
      });
    }

    /* ---- Batch recipes ---- */
    const recipes = readLegacyJson_(src, V1.BATCH_RECIPES, 'BATCH_RECIPES_JSON') || [];
    if (Array.isArray(recipes) && recipes.length) {
      const recRepo = new RecipesRepo();
      const ingRepo = new RecipeIngredientsRepo();
      recipes.forEach(function (rec) {
        const id = rec.id || genId_('rec');
        recRepo.upsert({ id: id, name: norm_(rec.name || ''), groupId: rec.groupKey || '',
          yieldAmount: num_(rec.yieldAmount, 0), yieldUnit: normalizeUnit_(rec.yieldUnit) || 'ML',
          bottleSizeAmount: num_(rec.bottleSizeAmount, 0), bottleSizeUnit: normalizeUnit_(rec.bottleSizeUnit) || 'ML',
          bottleCount: round_(num_(rec.bottleCount, 0), 1), createdAt: nowIso_(), updatedAt: nowIso_() });
        ingRepo.setForRecipe(id, (rec.ingredients || []).map(function (ing) {
          return { kind: ing.kind === 'custom' ? 'custom' : 'inventory', itemId: ing.itemId || '',
            name: ing.name || '', amount: num_(ing.amount, 0), unit: ing.unit || 'ML',
            meta: { vendor: ing.vendor, categoryN: ing.categoryN, orderName: ing.orderName, packageSize: ing.packageSize, par: ing.par, cost: ing.cost, csSize: ing.csSize, notes: ing.notes } };
        }));
        summary.recipes++;
      });
    }

    return { ok: true, summary: summary };
  });
}

/* ---- migration helpers ---- */

function indexByNameLower_(records) {
  const map = {};
  (records || []).forEach(function (r) { if (r.name) map[String(r.name).toLowerCase()] = String(r.id); });
  return map;
}

function dedupeSectionItems_(rows) {
  const seen = {};
  const out = [];
  rows.forEach(function (r) {
    const k = String(r.sectionId) + '|' + String(r.itemId);
    if (seen[k]) return;
    seen[k] = true; out.push(r);
  });
  return out;
}

/** Read a legacy KEY/VALUE sheet's JSON blob by key. */
function readLegacyJson_(src, sheetName, key) {
  const sheet = src.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 1) return null;
  const values = sheet.getDataRange().getValues();
  for (let r = 0; r < values.length; r++) {
    if (String(values[r][0]) === key) return parseJson_(String(values[r][1] || ''), null);
  }
  return null;
}
