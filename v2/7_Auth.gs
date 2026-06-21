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

/** Settings unlock token (server-side gate so privileged endpoints can't be called directly). */
const SETTINGS_UNLOCK_TTL_MS = 60 * 60 * 1000; // 1 hour
const PROP_SETTINGS_UNLOCK = 'V2_SETTINGS_UNLOCK_UNTIL';

/** Verify the settings PIN (admin actions). The launch PIN also unlocks settings. */
function verifySettingsPin(pin) {
  const settings = new SettingsRepo();
  const settingsPin = String(settings.get(SETTING_KEYS.ACCESS_SETTINGS_PIN) || '').trim();
  const launchPin = String(settings.get(SETTING_KEYS.ACCESS_LAUNCH_PIN) || '').trim();
  const given = String(pin || '').trim();
  const ok = !!given && (given === settingsPin || given === launchPin);
  if (ok) {
    PropertiesService.getUserProperties()
      .setProperty(PROP_SETTINGS_UNLOCK, String(Date.now() + SETTINGS_UNLOCK_TTL_MS));
  }
  return { ok: ok };
}

/** Throw unless the settings PIN was verified recently (within the TTL) by this user. */
function assertSettingsUnlocked_() {
  let until = 0;
  try { until = num_(PropertiesService.getUserProperties().getProperty(PROP_SETTINGS_UNLOCK), 0); } catch (e) { until = 0; }
  if (!until || Date.now() > until) throw new Error('Settings PIN verification required.');
}
