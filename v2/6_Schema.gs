/**
 * Schema.gs — table definitions + idempotent setup()/repair.
 *
 * Each table is a flat sheet: row 1 = headers (the column order below). setup() creates
 * any missing sheet, ensures headers exist, and seeds defaults. Safe to run repeatedly.
 */

/** Ordered column headers per table. The first column is the primary key unless noted. */
const TABLE_COLUMNS = Object.freeze({
  [SHEETS.ITEMS]: ['id', 'commonName', 'orderName', 'categoryId', 'vendorId',
    'bottleSizeAmount', 'bottleSizeUnit', 'par', 'cost', 'caseSize', 'notes',
    'archived', 'createdAt', 'updatedAt'],

  [SHEETS.LOCATIONS]: ['id', 'name', 'sortOrder', 'active'],

  // Composite key (itemId + locationId).
  [SHEETS.COUNTS]: ['itemId', 'locationId', 'qty', 'updatedAt'],

  [SHEETS.SECTIONS]: ['id', 'name', 'type', 'groupId', 'sortOrder', 'color',
    'headingAlign', 'columnsJson', 'createdAt'],

  // Composite key (sectionId + itemId).
  [SHEETS.SECTION_ITEMS]: ['sectionId', 'itemId', 'sortOrder'],

  [SHEETS.GROUPS]: ['id', 'name', 'parentGroupId', 'sortOrder', 'color',
    'headingAlign', 'columnsJson', 'createdAt'],

  [SHEETS.VENDORS]: ['id', 'name', 'ref', 'repName', 'repPhone', 'repEmail',
    'orderDaysJson', 'sheetName', 'active', 'repsJson', 'minOrder', 'orderNote'],

  [SHEETS.CATEGORIES]: ['id', 'name', 'sortOrder'],

  [SHEETS.RECIPES]: ['id', 'name', 'groupId', 'yieldAmount', 'yieldUnit',
    'bottleSizeAmount', 'bottleSizeUnit', 'bottleCount', 'createdAt', 'updatedAt'],

  // Composite/no single key; rows scoped by recipeId.
  [SHEETS.RECIPE_INGREDIENTS]: ['recipeId', 'kind', 'itemId', 'name', 'amount',
    'unit', 'metaJson'],

  // Key-value config.
  [SHEETS.SETTINGS]: ['key', 'value'],
});

/** Return the active spreadsheet (or one named by Script Property / default). */
function getSpreadsheet_() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  const id = PropertiesService.getScriptProperties().getProperty(APP.PROP_SPREADSHEET_ID);
  if (id) return SpreadsheetApp.openById(id);
  throw new Error('No active spreadsheet and no SPREADSHEET_ID script property set.');
}

/** Get or create a sheet, ensuring its header row matches TABLE_COLUMNS. */
function getOrCreateSheet_(name) {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  const cols = TABLE_COLUMNS[name];
  if (cols) ensureHeaders_(sheet, cols);
  return sheet;
}

/** Ensure row 1 holds exactly the given headers (adds missing columns, never deletes data). */
function ensureHeaders_(sheet, cols) {
  const width = cols.length;
  const existing = sheet.getLastColumn() >= 1
    ? sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), width)).getValues()[0]
    : [];
  let changed = existing.length < width;
  for (let i = 0; i < width; i++) {
    if (String(existing[i] || '') !== cols[i]) { changed = true; break; }
  }
  if (changed) {
    sheet.getRange(1, 1, 1, width).setValues([cols]);
    sheet.setFrozenRows(1);
  }
}

/**
 * setup() — create every table, seed defaults on a fresh spreadsheet. Idempotent.
 * Run once after adding the script to a Sheet (or anytime to repair structure).
 */
function setup() {
  return withLock_(function () {
    Object.keys(TABLE_COLUMNS).forEach(function (name) { getOrCreateSheet_(name); });

    seedSettingsDefaults_();
    seedIfEmpty_(SHEETS.LOCATIONS, function () {
      return DEFAULTS.LOCATIONS.map(function (l) {
        return { id: makeKey_(l.name), name: l.name, sortOrder: l.sortOrder, active: true };
      });
    });
    seedIfEmpty_(SHEETS.CATEGORIES, function () {
      return DEFAULTS.CATEGORIES.map(function (name, i) {
        return { id: makeKey_(name), name: name, sortOrder: i + 1 };
      });
    });
    seedIfEmpty_(SHEETS.VENDORS, function () {
      return DEFAULTS.VENDORS.map(function (name, i) {
        return { id: makeKey_(name), name: name, ref: String.fromCharCode(65 + i),
          repName: '', repPhone: '', repEmail: '', orderDaysJson: '[]', sheetName: name, active: true,
          repsJson: '[]', minOrder: '', orderNote: '' };
      });
    });
    seedIfEmpty_(SHEETS.SECTIONS, function () {
      return DEFAULTS.SECTIONS.map(function (name, i) {
        return { id: makeKey_(name), name: name, type: 'home', groupId: '',
          sortOrder: i + 1, color: '', headingAlign: 'left', columnsJson: '{}', createdAt: nowIso_() };
      });
    });

    return { ok: true, version: DEFAULTS.SCHEMA_VERSION };
  });
}

/** Seed a table only when it has no data rows. */
function seedIfEmpty_(sheetName, builder) {
  const sheet = getOrCreateSheet_(sheetName);
  if (sheet.getLastRow() > 1) return;
  const repo = new TableRepo(sheetName);
  repo.insertMany(builder());
}

/** Ensure the Settings table has the default access / text rows (without overwriting existing). */
function seedSettingsDefaults_() {
  const settings = new SettingsRepo();
  if (settings.get(SETTING_KEYS.SCHEMA_VERSION) == null) {
    settings.set(SETTING_KEYS.SCHEMA_VERSION, DEFAULTS.SCHEMA_VERSION);
  }
  if (settings.get(SETTING_KEYS.ACCESS_LAUNCH_PIN) == null) {
    settings.set(SETTING_KEYS.ACCESS_LAUNCH_PIN, DEFAULTS.ACCESS.launchPin);
    settings.set(SETTING_KEYS.ACCESS_SETTINGS_PIN, DEFAULTS.ACCESS.settingsPin);
    settings.set(SETTING_KEYS.ACCESS_ALLOWED_DOMAINS, DEFAULTS.ACCESS.allowedDomains);
  }
  if (settings.get(SETTING_KEYS.UI_TEXT) == null) {
    settings.set(SETTING_KEYS.UI_TEXT, DEFAULTS.UI_TEXT);
  }
}
