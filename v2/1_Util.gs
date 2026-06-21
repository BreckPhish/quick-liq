/**
 * Util.gs — small pure helpers. No spreadsheet access here.
 */

/** Normalize a label: uppercase, collapse whitespace, trim. */
function norm_(s) {
  return String(s == null ? '' : s).toUpperCase().replace(/\s+/g, ' ').trim();
}

/** Coerce to a finite number, else fallback (default 0). */
function num_(value, fallback) {
  const n = parseFloat(String(value == null ? '' : value).trim());
  return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
}

/** Round to n decimal places, returned as a Number. */
function round_(value, places) {
  const f = Math.pow(10, places || 0);
  return Math.round((Number(value) || 0) * f) / f;
}

/** Coerce a sheet cell to boolean (handles TRUE/FALSE/1/0/"true"). */
function bool_(value) {
  if (value === true || value === false) return value;
  const s = String(value == null ? '' : value).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

/** ISO timestamp now. */
function nowIso_() {
  return new Date().toISOString();
}

/** A short, sortable, collision-resistant id. */
function genId_(prefix) {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 7);
  return (prefix ? prefix + '_' : '') + t + r;
}

/** Stable, monotonic numeric id via Script Properties (never recycled). */
function nextNumericId_() {
  const props = PropertiesService.getScriptProperties();
  const current = parseInt(props.getProperty(APP.PROP_NEXT_NUMERIC) || '1000', 10);
  const next = (Number.isFinite(current) ? current : 1000) + 1;
  props.setProperty(APP.PROP_NEXT_NUMERIC, String(next));
  return String(current);
}

/** Safe JSON parse with fallback. */
function parseJson_(text, fallback) {
  if (text == null || text === '') return fallback;
  try { return JSON.parse(text); } catch (e) { return fallback; }
}

/** Stringify for storage. */
function toJson_(value) {
  return JSON.stringify(value == null ? null : value);
}

/** Section/group key from a label (stable, alnum + underscore). */
function makeKey_(label) {
  return norm_(label).replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Acquire a document lock (falls back to script lock); returns the lock or null. */
function acquireLock_() {
  let lock = null;
  try { lock = LockService.getDocumentLock(); } catch (e) { lock = null; }
  if (!lock) { try { lock = LockService.getScriptLock(); } catch (e) { lock = null; } }
  if (!lock) return null;
  try { lock.waitLock(APP.LOCK_WAIT_MS); return lock; } catch (e) { return null; }
}

/** Run a function while holding the lock; always releases. */
function withLock_(fn) {
  const lock = acquireLock_();
  try {
    return fn();
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (e) {} }
  }
}
