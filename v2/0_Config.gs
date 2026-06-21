/**
 * Config.gs — central constants for INVENT v2.
 *
 * Everything that v1 hard-coded across thousands of lines (sheet layout, lock colors,
 * label-scan patterns) is either gone (replaced by real columns) or lives here as a
 * single source of truth.
 */

const APP = Object.freeze({
  NAME: 'TIN PLATE — INVENT',
  VERSION: '2.0.0',

  // Lock acquisition window for any write.
  LOCK_WAIT_MS: 20000,

  // Script Property keys.
  PROP_SPREADSHEET_ID: 'SPREADSHEET_ID',
  PROP_NEXT_NUMERIC: 'V2_NEXT_NUMERIC_ID',
});

/** Sheet (table) names. Each is a flat, header-first table. */
const SHEETS = Object.freeze({
  ITEMS: 'Items',
  LOCATIONS: 'Locations',
  COUNTS: 'Counts',
  SECTIONS: 'Sections',
  SECTION_ITEMS: 'SectionItems',
  GROUPS: 'Groups',
  VENDORS: 'Vendors',
  CATEGORIES: 'Categories',
  RECIPES: 'Recipes',
  RECIPE_INGREDIENTS: 'RecipeIngredients',
  SETTINGS: 'Settings',
});

/** Settings keys (rows in the Settings table; values are JSON). */
const SETTING_KEYS = Object.freeze({
  UI_TEXT: 'ui.text',
  UI_COLORS: 'ui.colors',
  UI_LAYOUT: 'ui.layout',
  ACCESS_LAUNCH_PIN: 'access.launchPin',
  ACCESS_SETTINGS_PIN: 'access.settingsPin',
  ACCESS_ALLOWED_DOMAINS: 'access.allowedDomains',
  META_LAST_COMPLETED: 'meta.lastCompleted',
  META_INITIALS: 'meta.initials',
  SCHEMA_VERSION: 'schema.version',
});

/** Defaults seeded by setup() on a fresh spreadsheet. */
const DEFAULTS = Object.freeze({
  SCHEMA_VERSION: 2,

  LOCATIONS: [
    { name: 'BAR', sortOrder: 1, active: true },
    { name: 'OTHER', sortOrder: 2, active: true },
    { name: 'OFFICE', sortOrder: 3, active: true },
  ],

  CATEGORIES: [
    'WHITE WINE', 'RED WINE', 'VODKA', 'GIN', 'RUM', 'WHISKEY',
    'LIQUEUR', 'TEQUILA/MEZCAL', 'MIXER', 'COOKING', 'BEER (CANS)', 'BEER (KEGS)',
  ],

  VENDORS: ['RNDC', 'SOUTHERN', 'ELITE', 'BREAKTHRU', 'SODAS', 'SYSCO', 'OTHER'],

  SECTIONS: [
    'BAR SHELF #1', 'BAR SHELF #2', 'BAR SHELF #3', 'BAR SHELF #4',
    'EXTRAS/MIXERS', 'RED WINE', 'WHITE WINES', 'CANNED BEERS/FRIDGE PRODUCTS',
    'KEGS', 'FOR COOKING', 'SODAS',
  ],

  // Access: configurable, not hard-coded into logic. Empty domains = no domain restriction.
  ACCESS: {
    launchPin: '1968',
    settingsPin: '1415',
    allowedDomains: [], // e.g. ['tinplatepizza.com']; empty = allow any signed-in user
  },

  UI_TEXT: {
    pageTitle: 'TIN PLATE — INVENT',
    companyName: 'TIN PLATE HOSPITALITY GROUP, LLC',
    portalName: 'BEVERAGE MANAGEMENT PORTAL',
  },
});

/** Volume units understood throughout the app. */
const VOLUME_UNITS = Object.freeze(['ML', 'L', 'FL OZ']);
const ML_PER = Object.freeze({ ML: 1, L: 1000, 'FL OZ': 29.5735295625 });
