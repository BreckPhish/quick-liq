/**
 * C_Settings.gs — settings + data management endpoints.
 *
 * Covers access/appearance config, full data export/import (backup/restore), and simple
 * list management for Locations / Categories / Vendors / Sections / Groups. All writes are
 * whitelisted and lock-guarded.
 */

/** Sheets that the generic list manager is allowed to mutate (all single-key 'id'). */
const EDITABLE_LIST_SHEETS = Object.freeze([
  SHEETS.LOCATIONS, SHEETS.CATEGORIES, SHEETS.VENDORS, SHEETS.SECTIONS, SHEETS.GROUPS,
]);

function assertListSheet_(sheetName) {
  if (EDITABLE_LIST_SHEETS.indexOf(sheetName) === -1) throw new Error('Not an editable list: ' + sheetName);
}

/* ---- Access / appearance ---- */

function getSettings() {
  return api_(function () {
    assertAccess_();
    const s = new SettingsRepo();
    return {
      uiText: s.get(SETTING_KEYS.UI_TEXT) || DEFAULTS.UI_TEXT,
      uiColors: s.get(SETTING_KEYS.UI_COLORS) || {},
      // Never ship raw PINs to the client; just whether one is set.
      hasLaunchPin: !!norm_(s.get(SETTING_KEYS.ACCESS_LAUNCH_PIN) || ''),
      hasSettingsPin: !!norm_(s.get(SETTING_KEYS.ACCESS_SETTINGS_PIN) || ''),
      allowedDomains: s.get(SETTING_KEYS.ACCESS_ALLOWED_DOMAINS) || [],
      lists: {
        Locations: new LocationsRepo().all().sort(function (a, b) { return num_(a.sortOrder) - num_(b.sortOrder); }),
        Categories: new CategoriesRepo().ordered(),
        Vendors: new VendorsRepo().all(),
        Sections: new SectionsRepo().ordered(),
        Groups: new GroupsRepo().ordered(),
      },
    };
  });
}

function saveAppSettings(payload) {
  return api_(function () {
    assertAccess_();
    return withLock_(function () {
      const s = new SettingsRepo();
      payload = payload || {};
      if (payload.uiText !== undefined) s.set(SETTING_KEYS.UI_TEXT, payload.uiText);
      if (payload.uiColors !== undefined) s.set(SETTING_KEYS.UI_COLORS, payload.uiColors);
      // Blank = keep the current PIN (the client never receives the existing value).
      if (norm_(payload.launchPin)) s.set(SETTING_KEYS.ACCESS_LAUNCH_PIN, String(payload.launchPin).trim());
      if (norm_(payload.settingsPin)) s.set(SETTING_KEYS.ACCESS_SETTINGS_PIN, String(payload.settingsPin).trim());
      if (payload.allowedDomains !== undefined) {
        const list = Array.isArray(payload.allowedDomains) ? payload.allowedDomains
          : String(payload.allowedDomains).split(/[,\s]+/).filter(Boolean);
        s.set(SETTING_KEYS.ACCESS_ALLOWED_DOMAINS, list);
      }
      return { ok: true };
    });
  });
}

/* ---- Generic list management ---- */

function upsertListItem(sheetName, record) {
  return api_(function () {
    assertAccess_();
    assertListSheet_(sheetName);
    return withLock_(function () {
      const repo = new TableRepo(sheetName, 'id');
      const rec = Object.assign({}, record);
      if (!rec.id) {
        rec.id = makeKey_(rec.name || '') || genId_('row');
        if (rec.createdAt === undefined && TABLE_COLUMNS[sheetName].indexOf('createdAt') !== -1) rec.createdAt = nowIso_();
        if (rec.sortOrder === undefined && TABLE_COLUMNS[sheetName].indexOf('sortOrder') !== -1) rec.sortOrder = repo.all().length + 1;
        if (sheetName === SHEETS.LOCATIONS && rec.active === undefined) rec.active = true;
        if (sheetName === SHEETS.SECTIONS && rec.type === undefined) rec.type = 'home';
      }
      const saved = repo.upsert(rec);
      return { record: saved };
    });
  });
}

function deleteListItem(sheetName, id) {
  return api_(function () {
    assertAccess_();
    assertListSheet_(sheetName);
    return withLock_(function () {
      let reassigned = 0;
      if (sheetName === SHEETS.SECTIONS) {
        new SectionItemsRepo().removeWhere((r) => String(r.sectionId) === String(id));
      } else if (sheetName === SHEETS.VENDORS) {
        reassigned = reassignItemRefs_('vendorId', id); // detach items from the deleted distributor
      } else if (sheetName === SHEETS.CATEGORIES) {
        reassigned = reassignItemRefs_('categoryId', id); // detach items from the deleted category
      }
      const removed = new TableRepo(sheetName, 'id').remove(id);
      return { removed, reassigned };
    });
  });
}

/** Clear an item field that references a now-deleted category/vendor. Returns count changed. */
function reassignItemRefs_(field, fromId) {
  const items = new ItemsRepo();
  const affected = items.filter((it) => String(it[field]) === String(fromId));
  affected.forEach((it) => items.update(it.id, { [field]: '', updatedAt: nowIso_() }));
  return affected.length;
}

function reorderListItems(sheetName, ids) {
  return api_(function () {
    assertAccess_();
    assertListSheet_(sheetName);
    return withLock_(function () {
      const repo = new TableRepo(sheetName, 'id');
      (ids || []).forEach((id, i) => repo.update(id, { sortOrder: i + 1 }));
      return { count: (ids || []).length };
    });
  });
}

/* ---- Backup / restore ---- */

function exportData() {
  return api_(function () {
    assertAccess_();
    const tables = {};
    Object.keys(TABLE_COLUMNS).forEach(function (name) { tables[name] = new TableRepo(name).all(); });
    return {
      version: APP.VERSION,
      exportedAt: nowIso_(),
      tables: tables,
    };
  });
}

function importData(payload) {
  return api_(function () {
    assertAccess_();
    return withLock_(function () {
      if (!payload || !payload.tables) throw new Error('Invalid backup payload.');
      let restored = 0;
      Object.keys(TABLE_COLUMNS).forEach(function (name) {
        const rows = payload.tables[name];
        if (!Array.isArray(rows)) return;
        clearTableData_(name);
        if (rows.length) new TableRepo(name).insertMany(rows);
        restored += rows.length;
      });
      return { ok: true, restored: restored };
    });
  });
}

/** Delete all data rows (keep the header). */
function clearTableData_(sheetName) {
  const sheet = getOrCreateSheet_(sheetName);
  const last = sheet.getLastRow();
  if (last > 1) sheet.deleteRows(2, last - 1);
}
