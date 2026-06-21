/**
 * Auth.gs — access gate + PIN verification, all config-driven (no hard-coded values).
 *
 * Access rules live in the Settings table, so they can be changed without redeploying:
 *   access.allowedDomains : []  (empty = allow any signed-in Google user)
 *   access.launchPin      : string
 *   access.settingsPin    : string
 */

/** Throw if the current user is not allowed. Empty allow-list = open to any signed-in user. */
function assertAccess_() {
  const domains = new SettingsRepo().get(SETTING_KEYS.ACCESS_ALLOWED_DOMAINS) || [];
  if (!Array.isArray(domains) || domains.length === 0) return; // no restriction configured
  let email = '';
  try { email = String(Session.getActiveUser().getEmail() || ''); } catch (e) { email = ''; }
  // Fail closed: a restriction is configured but we can't verify who this is.
  if (!email) throw new Error('Access denied: could not verify your account for the domain restriction.');
  const ok = domains.some((d) => email.toLowerCase().endsWith('@' + String(d).toLowerCase()));
  if (!ok) throw new Error('Access denied: this account is not permitted to use INVENT.');
}

/** Verify the launch PIN (entry to the app). */
function verifyLaunchPin(pin) {
  const expected = new SettingsRepo().get(SETTING_KEYS.ACCESS_LAUNCH_PIN);
  return { ok: String(pin || '').trim() === String(expected == null ? '' : expected).trim() };
}

/** Verify the settings PIN (admin actions). The launch PIN also unlocks settings. */
function verifySettingsPin(pin) {
  const settings = new SettingsRepo();
  const settingsPin = String(settings.get(SETTING_KEYS.ACCESS_SETTINGS_PIN) || '').trim();
  const launchPin = String(settings.get(SETTING_KEYS.ACCESS_LAUNCH_PIN) || '').trim();
  const given = String(pin || '').trim();
  return { ok: given === settingsPin || given === launchPin };
}
