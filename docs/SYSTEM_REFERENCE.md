# Tin Plate "quick‑liq" — Complete System Reference

> A thorough technical map of the beverage‑inventory web app (the "INVENT" / Beverage
> Management Portal) and its linked Google Sheet. Written as a rebuild reference:
> every dataset variable, organizational structure, function group, and calculation is
> documented so the app can be re‑implemented with a cleaner, more reliable architecture.

---

## 0. What the app is

A **Google Apps Script (GAS) web app** bound to a single Google Sheet. It is a
single‑page application used on iPads / Samsung tablets to:

- Count bar inventory across three locations per item (BAR / OTHER / OFFICE).
- Organize hundreds of beverage items into sections, groups, and dynamic views.
- Define **cocktail batch recipes** that auto‑compute how much of each base liquor is
  tied up in pre‑batched bottles, and fold that into counts and order guides.
- Generate / email / zip **PDF** inventory sheets and distributor order guides.
- Persist heavy per‑user customization (labels, colors, layout, button names).

**Tech stack:** vanilla JS (one large `<script>`), HTML, CSS — all inlined by GAS
`HtmlService` templating. No build step, no framework, no external JS libraries. The
Google Sheet is both the database and the print/PDF source.

**The four source files:**

| File | Role | Size (approx) |
|---|---|---|
| `Code.gs` | Server: all `google.script.run` endpoints, Sheet I/O, PDF/email, calculations | ~5,035 lines |
| `JavaScript.html` | Client: one `<script>` with all app logic | ~11,680 lines |
| `Index.html` | Markup: page panels, overlays/modals, forms | ~1,172 lines |
| `Styles.html` | CSS: theme variables, layout grids, responsive, print | ~1,800 lines |

`Index.html` inlines the other two: `<?!= include('Styles') ?>` in `<head>`,
`<?!= include('JavaScript') ?>` before `</body>`, and prints `<?= senderEmail ?>`.

---

## 1. Architecture & request lifecycle

```
Browser (iPad/tablet)
  │  loads GAS web app URL
  ▼
doGet()  ── HtmlService.createTemplateFromFile('Index')
  │         tmpl.senderEmail = Session.getEffectiveUser().getEmail()
  │         setTitle('TIN PLATE — INVENT'); XFrameOptions = ALLOWALL
  │         ensureCleanupTrigger()  (installs hourly cleanupTempFiles trigger)
  ▼
Single HTML doc (Styles + JavaScript inlined)
  │
  ▼
Client boots → showLaunchPin_()  (last line of the script)
  │  user enters launch PIN → verifyLaunchPin('1968')
  ▼
initializeAppAfterLaunch_()  → wires listeners → refresh({mode:'percent'})
  │
  ▼
getInventData()  ── one big read of the Sheet → client state
  │
  ▼  (all subsequent mutations)
google.script.run.<endpoint>(payload)  → Sheet writes → returns deltas
```

- **No `doPost`.** All client→server calls are `google.script.run.<fn>()`.
- **No HTML caching.** Each load re‑reads settings sheets. Performance comes from
  batched range reads/writes and a one‑shot hidden‑row lookup via the Sheets API.
- **`include(filename)`** → `HtmlService.createHtmlOutputFromFile(filename).getContent()`.

---

## 2. The Google Sheet (the database)

Default spreadsheet id `1ZcYgv-1URnS11mq8STKsLaY383jxM7FgHK8pxgcg-h4`, overridable via
Script Property `SPREADSHEET_ID`. Resolution order: active spreadsheet → property → default.

### 2.1 `INVENT` sheet — the item table

Each item is a row. Section headings are also rows (col B set, col M/ID blank, or B
matches a known heading). `CONFIG.COL` maps meaning → 1‑based index → column letter:

| `CONFIG.COL.*` | Idx | Col | Meaning |
|---|---|---|---|
| `COMMON_NAME` | 2 | **B** | Item common name (also used to detect section headings) |
| `ORDER_NAME` | 3 | **C** | Name used on order guides |
| `BOTTLE_SIZE` | 4 | **D** | Free text, e.g. `"750 ML"` / `"25.4 FL OZ"`; parsed to mL for batch math |
| `PAR` | 5 | **E** | Par level |
| `G` | 7 | **G** | **BAR** count input |
| `H` | 8 | **H** | **OTHER** count input |
| `I` | 9 | **I** | Helper formula `=IFERROR(G{row}+H{row},"")` (server‑written) |
| `J` | 10 | **J** | **OFFICE** count input |
| `ID` | 13 | **M** | Item ID (numeric, monotonic, never recycled) |
| `CATEGORY` | 14 | **N** | Beverage category (drives BY BEVERAGE) |
| `VENDOR` | 15 | **O** | Vendor/distributor (drives BY DISTRIBUTOR) |
| `COST` | 16 | **P** | Unit cost |
| `CS_SIZE` | 17 | **Q** | Case size |
| `NOTES` | 18 | **R** | Notes |

- **Column A** is *not* in `CONFIG.COL` for INVENT but is load‑bearing in **order‑guide**
  tables — it stores the item ID (`$A` in the batch formula).
- **Header labels** for the three count columns are reported to the client as
  `{ g:'BAR', h:'OTHER', j:'OFFICE' }` (and can be per‑section overridden — see §4.4).
- **Lock state is encoded in cell background.** `CONFIG.LOCKED_BG='#2f2f2f'`,
  `CONFIG.UNLOCKED_BG='#ffffff'`. `isDarkLockedBg_(hex)` ⇒ dark+low‑chroma background ⇒
  that count input is disabled. This is how G/H/J editability is stored.
- **Standard scan width** for row reads/writes: 18 columns (A..R).
- **Format reference row:** `CONFIG.FORMAT_REFERENCE_ITEM_B = 'RED ROCKS CASK'` — new
  items copy formatting (B:E, M:O, P:R) from this row.
- **Default home sections** (`CONFIG.SECTION_HEADINGS`): `BAR SHELF #1..#4`,
  `EXTRAS/MIXERS`, `RED WINE`, `WHITE WINES`, `CANNED BEERS/FRIDGE PRODUCTS`, `KEGS`,
  `FOR COOKING`, `SODAS`.
- **Default vendors** (`CONFIG.VENDORS`): `RNDC, SOUTHERN, ELITE, BREAKTHRU, SODAS,
  SYSCO, OTHER`.
- **Default categories** (`CONFIG.CATEGORIES`): `WHITE WINE, RED WINE, VODKA, GIN, RUM,
  WHISKEY, LIQUEUR, TEQUILA/MEZCAL, MIXER, COOKING, BEER (CANS), BEER (KEGS)`.

### 2.2 `ORDER` sheet
A mirror used for PDF export and to hold the date/initials meta. Snapshotted alongside
INVENT during export/import.

### 2.3 Date / initials meta
Stored on both INVENT and ORDER. The server scans the top 10 rows × 26 cols for label
patterns (`LAST INVENTORY COMPLETED` / `INITIALS`, etc.) and writes 2 columns to the
right; fallback cells `P1` (date) / `P2` (initials). Initials normalized to A–Z, ≤3 chars.

### 2.4 Hidden / auxiliary sheets (auto‑created, hidden)

| Sheet (CONFIG const) | Stores | Shape |
|---|---|---|
| `_APP_SETTINGS` (`UI_SETTINGS_SHEET`) | One JSON blob under key `UI_SETTINGS_JSON` | `KEY`/`VALUE` rows; the entire `uiSettings` object |
| `SECTION GROUPS` (`SECTION_GROUPS_SHEET`) | `SECTION_GROUPS_JSON` array | group defs `{key,name,sectionKeys[],groupKeys[],color,headingAlign,columns,hideDisabledInputs,createdAt}` |
| `BATCH RECIPES` (`BATCH_RECIPES_SHEET`) | `BATCH_RECIPES_JSON` array | recipe objects (see §6) |
| `_BATCH_TOTALS` (`BATCH_TOTALS_SHEET`) | `ITEM_ID` / `BATCH_BOTTLES` | one row per item with batch demand; **VLOOKUP target** for order‑guide formulas |
| `DISTRO DATA` (`DISTRO_DATA_SHEET`) | 11‑col distributor mirror | `REF,NAME,KEY,SHEET,REP_NAME,REP_PHONE,REP_EMAIL,ORDER_DAYS,TABLE_COUNT,TEMPLATE,TABLES_JSON` |
| Per‑distributor order‑guide tabs | `BREAKTHRU, ELITE, RNDC, SODAS, SOUTHERN` + dynamic copies | native Sheets *tables* with category routing |

### 2.5 Script / Document Properties (no named ranges)
- **Script Properties:** `SPREADSHEET_ID`, `SECTION_LABEL_OVERRIDES` (JSON map →
  `{g,h,j,tab,color,align}`), `DISTRO_DATA_DIRTY` (resync flag), `NEXT_ITEM_ID`
  (monotonic counter).
- **LockService:** `getLock_()` prefers document lock, falls back to script lock; waits
  `CONFIG.LOCK_WAIT_MS = 20000` ms around all writes.

### 2.6 Order‑guide table catalog & routing
`ORDERING_TABLES` (keys A–L) defines each native table `{sheet,name,tableId,a1}`:

| Key | Sheet | Name | A1 | Key | Sheet | Name | A1 |
|---|---|---|---|---|---|---|---|
| A | BREAKTHRU | BREAK LIQWINE | B4:I32 | G | RNDC | RNDC LIQ | B4:I32 |
| B | BREAKTHRU | BREAK BEER | B33:I36 | H | RNDC | RNDC RED | B33:I47 |
| C | BREAKTHRU | BREAK NA | B37:I40 | I | RNDC | RNDC WHITE | B48:I59 |
| D | ELITE | ELITE BEER | B4:I14 | J | RNDC | RNDC BEER | B60:I61 |
| E | ELITE | ELITE LIQ | B15:I22 | K | SODAS | SODA | B4:I15 |
| F | ELITE | ELITE WINE | B23:I25 | L | SOUTHERN | SOUTH LIQWINE | B4:I25 |

`ROUTE_TABLE_LETTER` maps `(vendor, categoryGroup) → table key`. Built‑in vendors route
via `normalizeCategoryGroup_` (→ `WHITE_WINE / RED_WINE / LIQUOR / BEER / MIXER /
COOKING`). `REQUIRED_DISTRIBUTORS = [RNDC, BREAKTHRU, SOUTHERN, SYSCO, ELITE]` are
auto‑ensured; `VENDOR_ALIASES = { EAGLE: 'ELITE' }`. Dynamic (user‑created) distributors
match the *raw* category text against each table's `categories[]`.

---

## 3. Server (`Code.gs`) — function map

> Auth‑gated functions (`assertAuthorized_`) are marked 🔒. Note many mutators are **not**
> gated (see §3.7).

### 3.1 Web lifecycle
- `doGet()` → serves Index; installs cleanup trigger.
- `include(filename)` → inlines an HTML partial.

### 3.2 Inventory CRUD
- 🔒 `getInventData()` → the main read (shape below).
- 🔒 `saveInventEdits(edits)` → `{ok|missingIds|duplicateIds, ordering[], batchContributions}`.
  Per edit: optional section move, field writes, I‑formula, ordering resync, batch resync
  if a batch ingredient's bottle size changed.
- `setInventoryInputLocks({id,enableG,enableH,enableJ})` → sets G/H/J backgrounds.
- `reorderInventItem({id,targetId,position})` → same‑section reorder.
- `reorderSectionBlock(...)` / `reorderSectionByKey(...)` → reorder whole section blocks.
- 🔒 `addInventItem(payload)` → inserts row, assigns `NEXT_ITEM_ID`, copies template/format,
  writes I‑formula, inserts into the ordering table.
- `setItemArchived({id,archived,vendor,categoryN})` → toggles `uiSettings.archivedItemIds`;
  adds/removes from order guides; blocked if the item is used in a batch recipe.
- 🔒 `deleteInventItem({id,sourceSectionKey})` → permanent delete (only when
  `sourceSectionKey` starts with `DISTRO_`/`TYPE_`); blocked if in a batch recipe.
- 🔒 `removeInventItemFromHome({id})` → parks the item in the `ALL ITEMS` section.
- 🔒 `deleteInventSections({sectionKeys[],sectionLabels[]})` → deletes headers+items+ordering
  rows and cleans settings/overrides/groups.

#### `getInventData()` return shape
```
{ headers:{g:'BAR',h:'OTHER',j:'OFFICE'},
  rows:[{type:'header'|'item', ...}],         // flat, in sheet order
  sections:[{heading,key,row}], sectionLabels, vendors, categories,
  duplicates:[ids], uiSettings, secondarySections, distributors,
  orderGuideSheets, orderGuideSheetNames, sectionGroups,
  batchRecipes, batchContributions, lastCompleted, initials }
```
Item rows include: `id, b(name), orderName, bottleSize, par, categoryN, vendor, cost,
csSize, notes, o(=vendor), g, h, j, editable{g,h,j}, section`.

### 3.3 Sections / labels / groups
`renameSectionHeading`, `updateSecondarySection`, `addSection`, `addSectionGroup`,
`updateSectionGroup`, `deleteSectionGroup`, `setGroupSectionTypes`,
`setSectionGroupMembership`, `setGroupSectionMemberships`, `setGroupParent`. Group cycles
are prevented via `hasGroupPath_`/`buildGroupChildrenMap_`. A large helper layer handles
row/section navigation, label overrides, column settings, and item movement.

### 3.4 Distributors / order guides
- `createDistributor(payload)` — the add‑distributor wizard: validates name; clamps
  `tableCount` 1–10; copies a **template sheet**; discovers/clones table blocks; builds
  `tables[]` with categories; persists to `uiSettings.distributors`; assigns letter refs;
  syncs `DISTRO DATA`.
- `updateDistributor` / `deleteDistributor` — rename sheet/vendor (rewrites INVENT col O),
  rebuild tables, `resyncOrderingForDistributor_`.
- Discovery/seed/normalize layer: `getOrderingTableDefs_`, `resolveOrderingTargetTable_`,
  `autoSeedDistributorsFromInventory_`, `ensureRequiredDistributors_`,
  `normalizeOrderingVendor_`, `insertIntoOrderingTableByKey_`, `findOrderingRowsForId_`,
  `removeOrderingRows_`, `syncOrderingForItem_`, etc.

### 3.5 Batch recipes (server)
- 🔒 `saveBatchRecipe(payload)` / 🔒 `setBatchRecipeBottleCount({id,bottleCount})` /
  🔒 `deleteBatchRecipe({id})` → each returns `{ok, recipe?/recipes, batchContributions}`.
- `validateBatchRecipe_`, `calculateBatchContributions_`, `syncBatchTotalsAndOrderGuides_`,
  `ensureOrderGuideBatchFormula_` (calculations in §7).

### 3.6 PDF / email / zip
`generateInventoryPdf`, `getBlankOrderGuidePdf`, `getOrderGuidesPdf`, 🔒
`emailInventorySelection`, `getPrintZip`, plus a stack of export/blob/attachment helpers.
PDF export uses the export URL with an OAuth Bearer token, with a temp‑spreadsheet‑copy
fallback. `cleanupTempFiles()` (hourly trigger) trashes stale `TMP_*` Drive files.

### 3.7 Auth & PINs
- `assertAuthorized_()` — throws unless `Session.getActiveUser().getEmail()` ends with
  `@tinplatepizza.com`. **An empty email passes** (does not throw). Gates only the 🔒
  functions above. **Not** gated: `saveUiSettings`, distributor/section/group mutators,
  `setItemArchived`, `setInventoryInputLocks`, `importWebappData`, all PDF getters.
- `verifyLaunchPin(pin)` → `pin === '1968'`.
- `verifySettingsPin(pin)` → `pin === '1968' || pin === '1415'`.
- Which UI flows require which PIN is enforced **client‑side**.

### 3.8 Import / export & maintenance
- `exportWebappData()` (version 2) → meta + uiSettings + sectionLabels + sectionGroups +
  batchRecipes + per‑item counts/locks + full INVENT/ORDER snapshots.
- `importWebappData(payload)` → restores all of the above; resyncs batch totals.
- `compactInventSheet()` / `compactSheet_` → one‑time bloat cleanup (delete cols past Z,
  rows past lastRow+25). Run once to speed up loads.
- Advanced service: **Google Sheets API** used only by `getHiddenRowSet_` (one call to
  fetch all hidden‑by‑user rows; falls back to per‑row checks if not enabled).

---

## 4. Client (`JavaScript.html`) — data model & organization

### 4.1 Global state (declared at top of the script)

**Core data:** `baseRows` (server truth, flat header/item list), `allRows` (assembled by
`rebuildAllRows_`), `lastFilteredRows` (handed to `render`), `baseSectionsMeta`,
`sectionsMeta`, `sectionGroups`, `batchRecipes`, `batchContributions {id:bottles}`,
`groupMetaCache`, `sectionLabelOverrides {NORM_LABEL:{g,h,j,tab,color,align}}`, `vendors`,
`categories`, `secondarySections [{key,label,type,itemIds[]}]`,
`sectionShortcuts {sectionKey:[itemId]}`, `archivedItems (Set)`, `distributors`,
`orderGuideSheets/Names`, `distributorSections [{label,key:'DISTRO_…',itemIds}]`,
`typeSections [{label,key:'TYPE_…',itemIds}]`.

**Collapse / nav:** `collapsedByKey` (localStorage `invent_collapsed`),
`groupCollapsedByKey` (localStorage `invent_group_collapsed`), `tabButtonsByKey`,
`groupButtonsByKey`, `allBtn`, `rightButtonsInOrder`.

**Settings:** `uiSettings` (server‑persisted, see §6.1), `inventoryColumnSettings`,
`currentPage`, `defaultUiText`, `defaultUiStyles`.

**Pending edits / offline queue:** `pendingEdits (Map)`, `pendingMeta`,
`PENDING_EDITS_KEY='invent_pending_edits_v1'`, `PENDING_META_KEY='invent_pending_meta_v1'`,
flush/retry state, `PENDING_RETRY_BASE_MS=4000`, `PENDING_RETRY_MAX_MS=60000`.

**History / autosave:** `undoStack`/`redoStack`, `MAX_HISTORY=250`, `debounceTimers (Map)`,
`lastAutosaveInputs (Map)`, `DEBOUNCE_MS=650`, `batchBottleSaveTimers (Map)`.

**Drag:** `layoutEditMode`, `layoutDragState`, `behindBarDragState`,
`LAYOUT_DRAG_THRESHOLD=12`, `LAYOUT_SCROLL_MARGIN=70`, `LAYOUT_SCROLL_SPEED=14`,
`BEHIND_BAR_DRAG_STEP_PX=20`, `paletteDrag_`, plus add‑section/add‑group/category sweep state.

**Search:** `searchActive`, `searchCollapsedSnapshot`, `groupCollapsedSnapshot`,
`searchScrollSnapshot`, `searchFocusTarget_`, `filterDebounceTimer (160ms)`,
`keyboardAwareActive`.

**Identity constants:** `DISTRIBUTOR_GROUP_KEY='BY_DISTRIBUTOR'`,
`TYPE_GROUP_KEY='BY_TYPE'`, `ALL_ITEMS_GROUP_KEY='ALL_ITEMS'`,
`NEUTRAL_HOME_LABEL='ALL ITEMS'`, prefixes `DISTRO_`/`TYPE_`/`BATCH_RECIPE_`,
`RED_WINE_INUSE_ITEMS (Set)`, `SIMPLE_RIGHT_NAV=true`, nav size constants.

### 4.2 The item‑row object
Single‑letter fields map to **spreadsheet columns**: `b`=name (B), `g/h/j`=the three count
inputs (G/H/J, the DOM `data-field` values), `o`=vendor alias (O). Named fields: `id,
orderName, vendor, bottleSize, par, cost, csSize, categoryN, notes, section, editable
{g,h,j}`. Fields added during assembly: `sectionType('home'|'secondary')`, `isShortcut`,
`refSectionKey`, `dynamicType('distributor'|'type'|'batch')`, and batch fields
(`isBatchIngredient, isRecipeOnlyIngredient, batchRecipeId, batchBottleEquivalent,
batchRecipeAmount, batchRecipeUnit`). Header rows: `{type:'header', label, key, row,
sectionType, dynamicType?, batchRecipeId?, batchBottleCount?}`.

### 4.3 Section keys
```js
makeSectionKeyClient_(label) = norm_(label).replace(/[^A-Z0-9]+/g,'_').replace(/^_+|_+$/g,'')
// "White Wines" → "WHITE_WINES"
```
Dynamic keys are prefixed (`DISTRO_…`, `TYPE_…`, `BATCH_RECIPE_…`). Predicates:
`isDistributorSectionKey_`, `isTypeSectionKey_`, `isDynamicHomeSectionKey_`,
`isNeutralHomeLabel_`, `isReorderableSecondarySection_`, `isProtectedGroupKey_`.

### 4.4 Organizational structures (how items are arranged)

- **Sections** — home (real spreadsheet headings) vs **secondary/location** (user‑created,
  stored in `secondarySections` with explicit `itemIds` order). `fieldCfgForSection_(label)`
  returns the three column labels + disable flags (hard‑coded per section type, overlaid
  with `sectionLabelOverrides`).
- **Shortcuts (tabs/pins)** — `sectionShortcuts{sectionKey:[itemId]}`: an item pinned into
  a section appears (cloned) there even though its home `section` differs. Created by
  dragging a search result onto a section (`copyItemToSectionShortcut_`), reorderable in
  MOVE mode (`reorderShortcutItem_`), persisted via `saveUiSettings`.
- **Groups** — `sectionGroups [{key,name,sectionKeys[],groupKeys[],color,headingAlign,
  columns,hideDisabledInputs}]`; groups can nest groups.
- **Dynamic groups** — `BY DISTRIBUTOR` and `BY BEVERAGE`, auto‑built from item
  vendor/category, both wrapped inside an **ALL ITEMS** parent group. The
  `ALL ITEMS` spreadsheet section is a hidden *parking area*: its items stay in `baseRows`
  (so they feed the dynamic views) but are never rendered in the home flow.
- **Batch recipe sections** — each recipe renders as a section under its `groupKey`, with
  child rows = the recipe's ingredients (showing bottles‑per‑recipe).

### 4.5 `rebuildAllRows_()` — assembly pipeline
1. `rebuildSectionsMeta_()`; build `baseItems = Map<id,item>` from `baseRows`.
2. Walk `baseRows` with a header‑buffer state machine. Skip the neutral `ALL ITEMS`
   section in the home flow. On `flush()`, push header → its items → `pushShortcuts()`
   (shortcut clones in stored order).
3. Append **secondary sections** (clones in `itemIds` order).
4. Append **batch recipe sections** (header + ingredient clones / recipe‑only synthetics).
5. Append **distributor sections** (clones sorted by name).
6. Append **type/beverage sections** (clones sorted by name).
7. `allRows = rows; rebuildGroupMetaCache_()`.

Group ancestry is cached in `groupMetaCache` (`groupMetaByKey`, `parentBySection`,
`parentByGroup`); `getGroupChainForSectionKey_` walks it.

### 4.6 Rendering pipeline
`render(rows)` → `renderRows_(rows)` then a fixed sequence of `wire*`/`apply*` calls:
`applyPendingEditsToDom_, wireAutosave_, wireRowFocusHighlights_, wireRowClickFocus_,
wireBehindBarDrag_, wireCollapsers_, wireGroupCollapsers_, wireGroupEditButtons_,
wireLayoutDrag_, wireSectionEditButtons_, wireItemEditButtons_, wireBatchBottleCounts_,
wireSectionEditOrderButtons_, wireEditModalOrderButtons_, wireEditModalActionButtons_,
updateEditMoveButtons_, updateSectionMoveButtons_, updateRightTabStates_, wireNavTopSync_,
scheduleNavTopSync_, applyButtonSettings_, applyInputVisibilitySettings_,
applyLayoutEditMode_, scheduleFitItemNames_`.

`renderRows_` → `buildSectionBlocks_` (flat list → `[{header,items}]`) → `buildGroupTree_`
(nodes, metrics, parent maps) → two recursive emitters (`renderSectionBlock_`,
`renderGroupBlock_`) that produce header/body/row/line/spacer HTML.

**Column enablement** is three‑layered per input: `fieldCfgForSection_().forceDisable` ∧
group column state (`getGroupColumnStateBySectionKey_`) ∧ per‑section override
(`isSectionColumnEnabled_`) ∧ not layout‑edit ∧ not archived.

**Item‑name auto‑fit** (`fitItemNames_`, base 14px, floor 6px): shrinks each name's font to
fit its column on one line; deferred to rAF; re‑run on resize/orientation/`ResizeObserver`
of `#rows` and on `document.fonts.ready`.

### 4.7 Search & filtering
- Normal mode (`focusSearchUnderByBeverage_`): does **not** hide rows — it manipulates
  collapse state so only the relevant area (preferring BY BEVERAGE) is open, then scrolls
  + flashes the match. Clearing restores the snapshotted collapse maps and scroll.
- MOVE mode: shows a floating **search palette** (`renderSearchPalette_`); dragging a
  result onto a section pins it (`copyItemToSectionShortcut_`).
- `applyFilter()` (160 ms debounce) builds `lastFilteredRows` (headers emitted only if they
  have items, except BY BEVERAGE sections which show even when empty).

---

## 5. Client — interactions

### 5.1 Editing & autosave
- Every count input change → `recordPendingEdit_` (writes `pendingEdits` Map +
  `localStorage`) and `updateRowDataField_` (updates the in‑memory model so re‑renders keep
  the value) → debounced (`DEBOUNCE_MS=650`) `saveInventEdits`.
- A **flush queue** with exponential backoff (4 s → 60 s) retries failed saves; a save pill
  shows idle/pending/ok/err; a `beforeunload` guard warns if edits are unsent.
- Edit modal (`#editOverlay`): per‑field lock checkboxes, detail fields, validation
  (name/section required, batch items need a parseable bottle size, par/cost/csSize
  regexes). Save → `saveInventEdits` (+ `setInventoryInputLocks` for lock changes).
- Add item → `addInventItem`; duplicate → `addInventItem`; archive →
  `setItemArchived`. **Delete vs Remove scope:** in a dynamic view the button is **DELETE**
  → permanent `deleteInventItem`; elsewhere it is **REMOVE** → detach shortcut/secondary or
  park via `removeInventItemFromHome`.

### 5.2 Drag systems (five independent pointer systems)
1. **Behind‑bar drag** — vertical drag on a row's name/label surface adjusts BAR (col G) in
   tenths (0.0–1.0); 20 px per 0.1; commits a synthetic `input` event.
2. **Layout‑edit ("MOVE") drag** — types `item / section / group / line`; threshold 12 px;
   auto‑scroll near edges; drop‑target detection per type; `performLayoutDrop_` dispatches
   to item/section/group/line handlers. Persistence: `reorderInventItem`,
   `reorderSecondaryItem_`+`saveUiSettings`, `reorderShortcutItem_`+`saveUiSettings`,
   `setSectionGroupMembership`/`setGroupParent`/`reorderSectionByKey`, layout‑line settings.
   Server mutations are serialized through `enqueueLayoutMutation_`.
3. **Search palette drag‑to‑pin** — creates a ghost; drop on a (non‑dynamic, non‑neutral)
   section → `copyItemToSectionShortcut_`.
4. **Add‑section / Add‑group / Category** — paint‑to‑select sweeps in modals (not reorders);
   persist only on the modal's save (`addSection`, group chain, `createDistributor`).

> All draggable surfaces set `touch-action:none`; tappable controls use
> `touch-action:manipulation` so touch parity matches mouse without breaking pinch‑zoom.

### 5.3 Bottom‑bar +/- adjust
`selectedItemField {id,field,input}` tracks the last‑focused count input.
`adjustSelectedItemField_(±1)` clamps ≥0, dispatches a synthetic `input` (autosave), and
**deliberately does not call `.focus()`** so the on‑screen keypad doesn't pop on touch.

### 5.4 Batch recipes UI
Manager overlay lists recipe cards; the editor captures name, group, yield (amount+unit),
batch‑bottle size (amount+unit), bottle count, and ingredients (inventory item or custom).
Inventory ingredients with no parseable bottle size are disabled ("SET BOTTLE SIZE FIRST").
Inline per‑section **bottle‑count** inputs debounce 250 ms → `setBatchRecipeBottleCount`.
Save/delete go through `saveBatchRecipe`/`deleteBatchRecipe` and refresh
`batchContributions`.

### 5.5 Settings & customization
`uiSettings` keys: `text{pageTitle,heading1,heading2,subheading}`, `textStyles{align/size/
color}`, `buttons{[btnKey]:{label,base,highlight}}`, `colors{[cssVar]:value}`,
`layout{navScale,navHeightScale,navSlotSpacing,navPositions,navHeights}`,
`inventoryColumns{[key]:{g,h,j:false}}`, `hideDisabledInputs`, `sectionShortcuts`,
`secondarySections`, `sectionTypes`. The Customize modal edits text/colors/nav/buttons;
button rename/visibility keyed by `data-btn-key`; Inventory‑Columns modal toggles g/h/j per
section. Import/export round‑trips the whole webapp state.

### 5.6 PIN gates (client)
`showLaunchPin_()` is the last statement of the script (app is locked until then).
`confirmLaunchPin_` → `verifyLaunchPin` → `initializeAppAfterLaunch_()` (wires listeners,
ResizeObserver, keyboard‑aware search, then `refresh`). `openSettingsModal` gates behind
`verifySettingsPin`.

### 5.7 Pages & navigation
`showPage_('inventory'|'ordering'|'settings')` toggles `.pagePanel.active`; ordering lazily
loads the published‑sheet iframe; settings hits the PIN gate. **Right nav**
(`buildRightNav_`): MOVE (sticky first), TOP, then one button per group/section, then ALL;
state colors red/green/yellow for collapsed/expanded/mixed. `SIMPLE_RIGHT_NAV=true` means
the right side flows naturally (the slot/position math is effectively dead on the right).

---

## 6. Batch‑recipe data model

```jsonc
// BATCH_RECIPES_JSON — array of:
{
  "id": "…", "name": "…", "groupKey": "…",
  "yieldAmount": 5000, "yieldUnit": "ML",          // total batch volume produced
  "bottleSizeAmount": 750, "bottleSizeUnit": "ML", // size of the batch storage bottle
  "bottleCount": 3.0,                              // how many batch bottles currently on hand
  "ingredients": [
    { "kind": "inventory", "itemId": "123", "amount": 750, "unit": "ML" },
    { "kind": "custom", "name": "Simple Syrup", "amount": 500, "unit": "ML",
      "vendor": "", "categoryN": "", "orderName": "", "packageSize": "",
      "par": "", "cost": "", "csSize": "", "notes": "" }
  ]
}
```

---

## 7. Calculations (consolidated, verbatim)

### 7.1 Volume conversion (client & server identical)
```
ML    → ×1
L     → ×1000
FL OZ → ×29.5735295625
```
`parseBottleSizeMl(raw)` accepts e.g. `750 ML`, `1 L`, `25.4 FL OZ`, `25 OZ`.

### 7.2 Batch contribution per ingredient (bottles of base liquor tied up in batches)
```js
recipeFraction = (bottleCount * batchBottleMl) / yieldMl;      // fraction of a full batch on hand
bottles        = recipeFraction * (ingredientMl / itemBottleMl);
// i.e. ((bottleCount * batchBottleMl) / yieldMl) * (ingredientMl / itemBottleMl)
```
- `bottleCount` = batch bottles currently on hand.
- `batchBottleMl` = size of one batch storage bottle (mL).
- `yieldMl` = total volume the recipe produces (mL).
- `ingredientMl` = amount of this ingredient per full batch (mL).
- `itemBottleMl` = the inventory item's own bottle size (mL, parsed from col D).

Server `calculateBatchContributions_` sums this across all recipes per item id, rounds to 6
decimals → `{itemId: bottles}` (= `batchContributions`).

### 7.3 Order‑guide injection
`syncBatchTotalsAndOrderGuides_` writes `_BATCH_TOTALS` (`ITEM_ID`,`BATCH_BOTTLES`), then for
each order‑guide table row whose col A matches an affected id, sets the **BAR/quantity
column** (`CONFIG.ORDER_GUIDE_BAR_COL = 6`, col F):
```
=LET(qlBase, IFERROR(<existingBaseExpr>, ""),
     qlBatch, IFNA(VLOOKUP($A<row>, '_BATCH_TOTALS'!$A:$B, 2, FALSE), 0),
     IF(AND(qlBase="", qlBatch=0), "", IFERROR(VALUE(qlBase),0) + qlBatch))
```
So the order‑guide quantity = manually entered base + batch‑driven bottle demand. Number
format `0.0`.

### 7.4 Paperwork / counts (client `buildPrintPages_`)
Per item:
```js
barVal   = liveFieldValue_(id,'g');
otherRaw = liveFieldValue_(id,'h');
otherVal = batchOther > 0 ? formatTotal_(parseCount_(otherRaw) + getBatchContributionForItem_(id)) : otherRaw;
backVal  = liveFieldValue_(id,'j');
total    = formatTotal_(parseCount_(barVal) + parseCount_(otherVal) + parseCount_(backVal));
```
**OTHER folds in the batch contribution**, and **TOTAL = BAR + OTHER(+batch) + BACK**.
`formatTotal_` rounds to 1 decimal; `parseCount_` coerces blanks to 0. Pagination measures
a shell page's body height and fills rows until overflow. Title: *TIN PLATE BEVERAGE
INVENTORY*; columns Distributor / Item / BAR / OTHER / BACK / TOTAL; zebra striping;
section‑break / section‑end rules around "Shelf #4".

### 7.5 Item IDs
Monotonic via `NEXT_ITEM_ID`; `nextId = max(maxExistingNumericId+1, prop)`, never recycled.

---

## 8. UI reference (Index.html + Styles.html)

### 8.1 Page structure
- **Header:** `h1` (company / portal name), `#savePill` (idle/ok/err/pending),
  `.pageTabs` (`#…` `data-page` buttons), date `#lastCompleted` + initials `#initials`,
  Print/Email icon buttons, `#banner`.
- **`#pageInventory`:** `#leftNav`, `#rightNav`, `.wrap` → `#printPages` / `#printMeasure`
  / **`#rows`** (main render target) / `#status`; `.bottomBar` → `.bottomAdjustControls`
  (`#decreaseSelectedFieldBtn` / `#increaseSelectedFieldBtn`) + `#q` search + CLEAR.
- **`#pageOrdering`:** loader + `#orderingFrame` (published‑sheet iframe).
- **`#pageSettings`:** a card that opens the settings modal.

### 8.2 Overlays / modals (by id)
`#launchPinOverlay`, `#loadingOverlay`, `#orderGuidesOverlay`, `#inventoryColumnsOverlay`,
`#settingsOverlay`, `#batchRecipesOverlay` (manager `#batchRecipeManagerView` + editor
`#batchRecipeEditorView`), `#distributorsOverlay`, `#manageDistributorsOverlay`,
`#settingsPinOverlay`, `#customizeOverlay`, `#clearOverlay`, `#deleteSectionsOverlay`,
`#sectionEditOverlay`, `#shortcutOverlay`, `#groupEditOverlay`, `#printOverlay`,
`#emailOverlay`, `#editOverlay`, `#addOverlay`, `#addMenuOverlay`, `#addSectionOverlay`,
`#addGroupOverlay`, `#groupTypeOverlay`, `#typeGroupOverlay`, `#addDistributorOverlay`
(3‑step wizard), and the floating `#searchResultsPalette` (not an overlay).

### 8.3 Key form fields
- **Add item:** `#newSection #newCategory #newVendor #newCommon(B) #newOrder(C)
  #newSize(D) #newPar(E) #newCost(P) #newCsSize(Q) #newNotes(R)`.
- **Edit item:** `#editSection #editCategory #editVendor #editCommon #editOrder #editSize
  #editPar #editCost #editCsSize #editNotes`; counts `#editG/#editField2/#editJ` with locks
  `#editLockG/H/J`.
- **Batch editor:** `#batchRecipeName #batchRecipeGroup #batchRecipeYieldAmount/Unit
  #batchRecipeBottleSizeAmount/Unit #batchRecipeBottleCount` + `#batchIngredientList`.

### 8.4 CSS systems (Styles.html)
- **Theme tokens** (`:root`): color palette (`--bg #0b1220`, `--card`, `--text`, `--muted`,
  `--border`, warn/err, tab red/green/yellow, flash + add‑yellow pairs), layout metrics
  (`--bottomBarH`, `--navBaseW/H`, `--navHeightScale`, `--navSlotGap`, derived
  `--navBtnH/--navSlotH`, `--rightNavW/--leftNavW`, `--navOffsetY`). Runtime vars per
  element for section/group/line/button theming.
- **`.itemRow` grid:** `minmax(0,3fr) repeat(3, minmax(46px,0.72fr))`, left gutter 44px for
  the edit pencil. Modifiers `.archived .zebra .rowFocus .behindBarDragRow`.
- **Groups:** `.group` / `.groupHeading` pill headers + `.groupBody`; chevron rotates when
  collapsed; `.numBadge` count.
- **Right nav:** fixed, scrollable; `.tabBtn` states `.stateCollapsed/.stateExpanded/
  .stateMixed`; MOVE control `#toggleLayoutEditBtn.layoutEditFab` is `position:sticky;top:0`.
- **Drag visuals:** `.layoutDropLine` (blue 3px line), `.layoutDragSource` (0.65 opacity),
  `.sectionDropHover` (yellow outline); `body.layoutEditOn` disables field pointer events
  and sets `cursor:grab; touch-action:none`.
- **Launch lock:** `body.launchLocked` hides everything except `#launchPinOverlay`.
- **Responsive:** `≤520px` phone; `521–1024px` iPad; **`600–1366px` (Galaxy Tab A9+) forces
  single‑line rows**; `≤700px` collapses batch grids; `(hover:none)+(pointer:coarse)`
  enlarges nav/inputs (≥16px to prevent iOS zoom) and tap targets; `@media print` renders
  `.printPages` letter‑portrait with page breaks.
- **Z‑index:** header 10 · navs 20 · bottom bar 25 · overlays 60 · palette/drop‑line ~70 ·
  loading 90 · palette ghost 200 · launch PIN 1000.

### 8.5 Hooks & a11y
`data-page`, `data-btn-key`/`data-btn-rename`/`data-btn-icon`/`data-btn-default`,
`data-section-key`/`-color`/`-heading-align`, `data-field`/`data-field-cell`,
`data-batch-ingredient-*`. ARIA roles on PIN dialog, loading status, save pill, icon
buttons; `inputmode`/`pattern`; safe‑area insets; `:focus-visible` outlines.

---

## 9. Known constraints, coupling & setup

**Setup steps for a working deploy**
1. Set Script Property `SPREADSHEET_ID`.
2. Enable the **Google Sheets API** advanced service (fast hidden‑row detection).
3. Run `compactInventSheet()` once on a bloated sheet.
4. The hourly `cleanupTempFiles` trigger auto‑installs on first load.
5. Deploy as web app; all four files must be synced to the GAS project (editing the repo
   does nothing until redeploy).

**Structural coupling / fragility (candidates to fix in a rebuild)**
- **Sheet is the database, the print source, and the schema.** Section headings are rows in
  the same sheet as items; lock state is stored as *cell background color*; date/initials
  are found by scanning for label text. This couples presentation to storage and makes
  loads slow and brittle.
- **Two parallel models** (`baseRows` → `rebuildAllRows_` → `allRows`) re‑derived on every
  change; organizational truth is split across `uiSettings`, `SECTION GROUPS`,
  `sectionLabelOverrides` (Script Property), `secondarySections`, and the sheet itself.
- **Order‑guide demand is a spreadsheet formula** (`LET(... VLOOKUP('_BATCH_TOTALS' ...))`)
  injected per row into native Sheets tables — powerful but opaque and easy to break on
  table resizes.
- **Auth is a hard domain lock** (`@tinplatepizza.com`); a blank email passes; many mutators
  aren't gated at all. **PINs are hard‑coded** (`1968` / `1415`) and verified server‑side but
  gated client‑side.
- **Inconsistent persistence**: some state in the sheet, some in JSON blobs, some in Script
  Properties, some in `localStorage` (collapse state, pending edits).
- **Right‑nav positioning code is dead** (`SIMPLE_RIGHT_NAV=true`) — leftover complexity.
- **Performance**: full‑sheet read on every load; GAS 6‑minute execution and quota limits;
  PDF export depends on OAuth token + fallback copies.

**Rebuild recommendations (for the "out‑of‑the‑box" version)**
- Separate **data** (a real DB or a normalized Sheet with one row per item and *no* heading
  rows) from **presentation** (sections/groups/labels as pure config).
- Make editability/locks, dates, and meta **fields**, not formatting.
- Replace the dual `baseRows/allRows` derivation with a single normalized store + selectors;
  represent the org tree (sections → groups → ALL ITEMS → dynamic views) as explicit data.
- Compute batch contributions and order quantities in code, write plain values (keep a
  formula only if live‑editing in Sheets is required).
- Move auth to real accounts/roles; make PINs configurable; gate every mutator.
- Consolidate persistence into one settings document with versioned migrations; keep
  offline queue + autosave (these work well) and the touch‑first UX patterns.
