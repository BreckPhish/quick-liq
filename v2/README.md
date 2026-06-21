# Tin Plate INVENT v2 — Beverage Inventory Platform

A ground-up rebuild of the beverage-inventory tool, on a **clean, normalized Google
Sheets backend** and a modern Google Apps Script web app. Designed for tablets in a
working bar: fast counting, reliable autosave, batch-cocktail math, and one-tap order
guides — without the structural debt of v1.

---

## Why a rebuild

v1 worked but coupled everything to spreadsheet *presentation*: section headings were
rows in the item sheet, edit-locks were stored as **cell background colors**, dates were
found by scanning for label text, and the client maintained two parallel models
(`baseRows` → `allRows`) rebuilt on every change. v2 fixes the foundation:

| v1 (legacy) | v2 (this build) |
|---|---|
| Headings + items in one `INVENT` sheet | Separate normalized tables (`Items`, `Sections`, `SectionItems`, …) |
| Lock state = cell background color | `locked` boolean columns |
| Dates found by scanning label text | A `Meta`/`Settings` key-value table |
| Shortcuts/secondary as a side map | One `SectionItems` join table (an item can live in many sections) |
| Count locations hard-coded (BAR/OTHER/OFFICE) | A configurable `Locations` table |
| One 11k-line client script | Layered server (repos/services/api) + modular client |
| Hard-coded `@domain` auth + hard-coded PINs | Config-driven access in `Settings` |
| Calculations inline & duplicated | Pure, **unit-tested** service functions |

---

## Architecture

```
Browser (PWA-style, tablet)
  └─ Client (Index.html + Styles.html + Client_*.html)
        │  google.script.run
        ▼
  Web layer        Api.gs            ← thin endpoints, validation, auth gate
        │
  Domain layer     *Service.gs       ← pure logic: batch math, ordering, units (testable)
        │
  Data layer       Repositories.gs   ← one repository per table, object-mapped rows
        │           TableRepo.gs      ← generic header-keyed read/write/cache
        ▼
  Storage          Google Sheets     ← normalized tables, machine-readable, no presentation
```

**Principles**
- *Data is data.* Every sheet is a flat table with a header row and stable IDs. No
  presentation (colors, layout, headings) lives in the data tables.
- *One source of truth per concept.* Organization (sections/groups) is config, not
  inferred from item rows.
- *Pure calculations.* Unit conversion, batch contributions, and order math are pure
  functions with `Tests.gs` coverage — no spreadsheet calls inside them.
- *Thin endpoints.* `Api.gs` validates input, calls a service/repo, returns a typed
  result `{ ok, data?, error? }`. Every mutation is auth-gated and lock-guarded.
- *Self-healing setup.* `setup()` creates/repairs every sheet and seeds defaults, so the
  app works out of the box on an empty spreadsheet.

---

## Backend schema (Google Sheets tables)

Each is its own sheet; row 1 is the header; `id` columns are stable strings. Booleans are
`TRUE`/`FALSE`; timestamps are ISO strings. `*Json` columns hold structured config.

### `Items` — the catalog (one row per product)
`id · commonName · orderName · categoryId · vendorId · bottleSizeAmount · bottleSizeUnit ·
par · cost · caseSize · notes · archived · createdAt · updatedAt`

### `Locations` — configurable count columns (replaces hard-coded BAR/OTHER/OFFICE)
`id · name · sortOrder · active`  → seeded with `BAR`, `OTHER`, `OFFICE`.

### `Counts` — the live working count (long format)
`itemId · locationId · qty · updatedAt`  (one row per item × location with a value)

### `Sections` — display sections
`id · name · type(home|secondary) · groupId · sortOrder · color · headingAlign ·
columnsJson(per-location enable) · createdAt`

### `SectionItems` — which items appear in which section, and in what order
`sectionId · itemId · sortOrder`  (an item may appear in several sections — this replaces
v1 "shortcuts" and "secondary section itemIds" with one clean join)

### `Groups` — nestable groups of sections/groups
`id · name · parentGroupId · sortOrder · color · headingAlign · columnsJson · createdAt`

### `Vendors` — distributors
`id · name · ref · repName · repPhone · repEmail · orderDaysJson · sheetName · active`

### `Categories` — beverage categories
`id · name · sortOrder`

### `Recipes` — batch cocktail recipes
`id · name · groupId · yieldAmount · yieldUnit · bottleSizeAmount · bottleSizeUnit ·
bottleCount · createdAt · updatedAt`

### `RecipeIngredients`
`recipeId · kind(inventory|custom) · itemId · name · amount · unit · metaJson`

### `Settings` — UI customization + app config (key → JSON value)
keys include: `ui.text`, `ui.colors`, `ui.layout`, `access.launchPin`,
`access.settingsPin`, `access.allowedDomains`, `meta.lastCompleted`, `meta.initials`.

> **Migration:** `Migrate.gs` (later phase) reads a legacy `INVENT` sheet and populates
> these tables, so existing data carries over.

---

## Calculations (pure, tested — see `Tests.gs`)

Identical math to v1 but isolated and verified:

- **Unit → mL:** `ML ×1`, `L ×1000`, `FL OZ ×29.5735295625`.
- **Batch contribution (bottles of a base liquor tied up in batches):**
  `((bottleCount × batchBottleMl) / yieldMl) × (ingredientMl / itemBottleMl)`, summed per
  item across recipes.
- **Counting totals:** per item, `OTHER` folds in batch contribution; `TOTAL = Σ(locations) + batch`.

---

## Project layout

> **Why the numeric prefixes?** Apps Script evaluates top-level code (and `class extends`)
> in **alphabetical file order**. The prefixes encode the real dependency order so base
> classes / constants are always defined before the files that use them at load time.

```
v2/
  appsscript.json          GAS manifest (V8, Sheets advanced service, web app)
  .clasp.json.example      copy → .clasp.json with your scriptId to use clasp
  0_Config.gs              constants, sheet names, defaults
  1_Util.gs                small pure helpers (ids, norm, parsing, locks)
  2_UnitService.gs         volume parsing/conversion (pure, tested)
  3_BatchService.gs        batch contribution math (pure, tested)
  4_TableRepo.gs           generic header-keyed table access + per-request cache
  5_Repositories.gs        typed repos (Items, Counts, Sections, Recipes, Settings, …)
  6_Schema.gs              table definitions + setup()/repair + seeding
  7_Auth.gs                access gate + PIN verification (config-driven)
  8_Api.gs                 google.script.run endpoints (thin, locked, typed results)
  9_Tests.gs               runTests() for the pure services
  Index.html               app shell
  Styles.html              design system
  Client_Core.html         state, server bridge, boot, launch PIN, page nav
  Client_Render.html       section/group/row rendering, search, recipe summary
  Client_Counting.html     counting interactions, autosave + offline queue, +/- adjust
  docs/DATA_MODEL.md       schema rationale & relationships
```

## Roadmap

- **Phase 1 ✅:** schema + bootstrap, data layer, pure calc services + tests, core API
  (bootstrap/items/counts/sections/groups/recipes), counting UI (render, search, autosave,
  offline queue), auth gate.
- **Phase 2 ✅:** full batch-recipe editor UI (create/edit/delete + ingredients), and a
  **computed** order guide (`OrderingService`, grouped by distributor) — order quantities
  are derived in code from on-hand vs par, replacing v1's `LET/VLOOKUP` formula injection.
- **Phase 2.5 (in progress):** ✅ item add/edit/archive/delete modal (tap a name to edit;
  "+ Add item"; section placement; "(Unsectioned)" catch-all so no item is ever hidden).
  Next: distributor/vendor CRUD UI, section/group create + drag reorder.
- **Phase 3 ✅:** PDF export (inventory + order guide) and email, via the GAS temp-sheet→PDF
  pattern (`B_Reports.gs`) + a Reports modal (download / email selected reports).
- **Migration ✅:** `A_Migrate.gs` — `migrateFromV1('OLD_SPREADSHEET_ID')` imports legacy
  items, counts (G/H/J→locations), sections + membership, shortcuts/secondary sections,
  groups, batch recipes, vendors, and archived flags into the v2 tables (preserves item ids).
- **Phase 4 ✅:** PIN-gated **Settings** page — access config (PINs, allowed domains),
  appearance (company/portal names), full **data backup/restore** (JSON export/import),
  an in-app **v1 migration runner**, and list management (locations/categories/vendors/
  sections/groups) — all via `C_Settings.gs`.
- **Phase 5 (hosting-limited):** A true installable PWA + offline service worker is **not
  feasible under Apps Script hosting** (the app is served in a sandboxed iframe; SW scope /
  a stable manifest path aren't available). The in-session **offline autosave queue**
  already covers flaky-Wi-Fi resilience during a count. Full offline cold-start + real-time
  multi-device sync would require the hosted-DB path (e.g. Supabase) noted in the rebuild
  guidance — a clean future migration, since the data layer is already adapter-shaped.

## Status

Phases 1–4 are complete: this is a working, end-to-end beverage-inventory app on a clean
normalized backend — counting, item management, **Move-mode drag-reorder** (items within/
between sections + section reordering, mouse & touch), batch recipes, computed order guide,
PDF/email reports, settings, backup/restore, and v1 migration. Deploy steps below.

## Deploy

1. Create a new Google Sheet; open **Extensions → Apps Script**.
2. Add these files (or `clasp push` with `.clasp.json`).
3. Run `setup()` once (creates tables + seeds defaults).
4. **Deploy → New deployment → Web app**; open the URL on the tablet.
