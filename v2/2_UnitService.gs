/**
 * UnitService.gs — pure volume parsing & conversion. No spreadsheet access.
 * Mirrors v1 behavior exactly, but isolated and unit-tested (see Tests.gs).
 */

/** Normalize a free-text unit to one of VOLUME_UNITS, or '' if unknown. */
function normalizeUnit_(unit) {
  const raw = String(unit == null ? '' : unit)
    .trim().toUpperCase().replace(/[.]/g, '').replace(/\s+/g, ' ');
  if (raw === 'ML' || raw === 'MILLILITER' || raw === 'MILLILITERS') return 'ML';
  if (raw === 'L' || raw === 'LITER' || raw === 'LITERS' || raw === 'LITRE' || raw === 'LITRES') return 'L';
  if (raw === 'FL OZ' || raw === 'FLOZ' || raw === 'FLUID OUNCE' || raw === 'FLUID OUNCES' || raw === 'OZ') return 'FL OZ';
  return '';
}

/** Convert (amount, unit) → milliliters, or NaN if invalid. */
function toMl_(amount, unit) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return NaN;
  const u = normalizeUnit_(unit);
  if (!u) return NaN;
  return value * ML_PER[u];
}

/**
 * Parse a free-text bottle size like "750 ML", "1 L", "25.4 FL OZ", "25 OZ" → mL (NaN if unparseable).
 */
function parseBottleSizeMl_(raw) {
  const m = String(raw == null ? '' : raw).trim()
    .match(/^\s*(\d+(?:\.\d+)?)\s*(ML|MILLILITERS?|LIT(?:ER|RE)S?|L|FL\.?\s*OZ\.?|FLOZ|FLUID\s+OUNCES?|OZ)\s*$/i);
  return m ? toMl_(m[1], m[2]) : NaN;
}
