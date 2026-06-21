/**
 * TableRepo.gs — generic header-keyed access to a flat sheet table.
 *
 * Reads the header row once and maps every data row to a plain object. Writes locate
 * rows by primary key. Keeps things boring and predictable; typed repos extend it.
 */
class TableRepo {
  /**
   * @param {string} sheetName
   * @param {string|string[]} idKey  primary key column, or array for a composite key
   */
  constructor(sheetName, idKey) {
    this.sheetName = sheetName;
    this.idKey = idKey || 'id';
    this._cache = null; // { headers, objects, rowIndexByKey }
  }

  sheet() { return getOrCreateSheet_(this.sheetName); }

  /** Build the composite/simple key string for an object. */
  keyOf(obj) {
    if (Array.isArray(this.idKey)) {
      return this.idKey.map((k) => String(obj[k] == null ? '' : obj[k])).join('\u0000');
    }
    return String(obj[this.idKey] == null ? '' : obj[this.idKey]);
  }

  /** Read the whole table once and memoize for this request. */
  _load() {
    if (this._cache) return this._cache;
    const sheet = this.sheet();
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    const headers = lastCol >= 1 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
    const objects = [];
    const rowIndexByKey = {};
    if (lastRow > 1 && lastCol >= 1) {
      const values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
      for (let r = 0; r < values.length; r++) {
        const obj = {};
        for (let c = 0; c < headers.length; c++) obj[headers[c]] = values[r][c];
        objects.push(obj);
        rowIndexByKey[this.keyOf(obj)] = r + 2; // 1-based sheet row
      }
    }
    this._cache = { headers, objects, rowIndexByKey };
    return this._cache;
  }

  invalidate() { this._cache = null; }

  /** All rows as objects. */
  all() { return this._load().objects.slice(); }

  /** Find by primary key. */
  byId(id) {
    const cache = this._load();
    const row = cache.rowIndexByKey[String(id)];
    if (!row) return null;
    return cache.objects[row - 2] || null;
  }

  /** First object matching predicate, else null. */
  find(predicate) {
    const objs = this._load().objects;
    for (let i = 0; i < objs.length; i++) if (predicate(objs[i])) return objs[i];
    return null;
  }

  /** All objects matching predicate. */
  filter(predicate) { return this._load().objects.filter(predicate); }

  headers() { return this._load().headers.slice(); }

  _rowFromObject(obj, headers) {
    return headers.map((h) => {
      const v = obj[h];
      return v === undefined ? '' : v;
    });
  }

  /** Append one object; returns it. */
  insert(obj) {
    const sheet = this.sheet();
    const headers = this.headers();
    sheet.appendRow(this._rowFromObject(obj, headers));
    this.invalidate();
    return obj;
  }

  /** Append many objects in one write. */
  insertMany(objs) {
    if (!objs || !objs.length) return [];
    const sheet = this.sheet();
    const headers = this.headers();
    const rows = objs.map((o) => this._rowFromObject(o, headers));
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
    this.invalidate();
    return objs;
  }

  /** Patch an existing row by primary key; returns the merged object or null. */
  update(id, patch) {
    const cache = this._load();
    const rowNum = cache.rowIndexByKey[String(id)];
    if (!rowNum) return null;
    const headers = cache.headers;
    const merged = Object.assign({}, cache.objects[rowNum - 2], patch);
    this.sheet().getRange(rowNum, 1, 1, headers.length).setValues([this._rowFromObject(merged, headers)]);
    this.invalidate();
    return merged;
  }

  /** Insert if key missing, else update. */
  upsert(obj) {
    const existing = this.byId(this.keyOf(obj));
    return existing ? this.update(this.keyOf(obj), obj) : this.insert(obj);
  }

  /** Delete one row by primary key; returns true if removed. */
  remove(id) {
    const cache = this._load();
    const rowNum = cache.rowIndexByKey[String(id)];
    if (!rowNum) return false;
    this.sheet().deleteRow(rowNum);
    this.invalidate();
    return true;
  }

  /** Delete every row matching predicate (bottom-up to keep indices valid). */
  removeWhere(predicate) {
    const cache = this._load();
    const sheet = this.sheet();
    const toDelete = [];
    cache.objects.forEach((obj, i) => { if (predicate(obj)) toDelete.push(i + 2); });
    toDelete.sort((a, b) => b - a).forEach((rowNum) => sheet.deleteRow(rowNum));
    if (toDelete.length) this.invalidate();
    return toDelete.length;
  }
}
