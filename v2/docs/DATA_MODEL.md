# Data model — rationale & relationships

The v2 backend is a set of **normalized, flat tables** (one Google Sheet each). Nothing
about *presentation* lives in the data; organization is explicit config.

## Entity relationships

```
Categories ──┐
Vendors ─────┤
             ▼
           Items ───< Counts >─── Locations
             │
             └──< SectionItems >── Sections ──> Groups ──> Groups (parent, nestable)
             │
             └──< RecipeIngredients >── Recipes ──> Groups
Settings (key → JSON: ui, access, meta)
```

`──<` = one-to-many, `>───<` = many-to-many via a join table.

## Key decisions

- **No heading rows in the item table.** Sections/Groups are their own tables; membership
  is the `SectionItems` join. An item can appear in many sections (this *replaces* v1's
  separate "shortcuts" map and "secondary section itemIds" with one mechanism).
- **Counts are long-format** (`itemId, locationId, qty`). Locations are data, so adding a
  4th count column (e.g. "WALK-IN") is a row in `Locations`, not a code change.
- **Locks/visibility are booleans/JSON**, never cell colors. Per-section column config
  lives in `Sections.columnsJson`.
- **Stable IDs.** Items use a monotonic numeric id (never recycled). Sections/groups use
  slug keys; recipes use generated ids.
- **Batch demand is computed in code** (`BatchService`), not a spreadsheet formula. The
  result (`batchContributions`) is returned to the client and folded into totals. If a
  live in-sheet order guide is needed later, the same numbers can be written as plain
  values — no fragile `LET/VLOOKUP` injection.
- **Access is configuration.** `Settings: access.allowedDomains / launchPin / settingsPin`
  — changeable without redeploying; empty domain list = open to any signed-in user.
- **Distributors carry their own ops data.** `Vendors` holds `ref`, `active`, `orderDaysJson`
  (the days an order must be placed), `orderNote` (free-text cutoff), `minOrder` (dollar
  minimum), and `repsJson` (an array of `{name, role, phone, email}` — multiple reps).
  Legacy single-rep columns (`repName/repPhone/repEmail`) are kept in sync with the first
  rep for back-compat. The order guide shows reps, order-by days, and minimum vs. the
  estimated order total (Σ suggested units × item cost), flagging orders under minimum.
- **Batch bottles are surfaced, not hidden.** Live counting and the inventory PDF show a
  read-only **BATCH** column (bottles tied up in batch recipes) and a **TOTAL** = locations +
  batch; the order guide's on-hand includes batch and annotates the batch portion.

## Calculation contracts (see `3_BatchService.gs` + `9_Tests.gs`)

- `toMl(amount, unit)` — ML×1, L×1000, FL OZ×29.5735295625; NaN on invalid.
- `ingredientBottles(recipe, ingredient, item)` =
  `((bottleCount × batchBottleMl) / yieldMl) × (ingredientMl / itemBottleMl)`.
- `batchContributions(recipes, itemBottleMlById)` → `{ itemId: bottles }` (rounded 6dp).
- `itemTotal(locationQtys, batchBottles)` = `Σ(locations) + batch` (rounded 1dp).

## Migration from v1 (later phase)

`Migrate.gs` will read the legacy `INVENT` sheet: detect heading rows → `Sections`;
items → `Items` (+ `Counts` from G/H/J, lock booleans from background color); legacy
`uiSettings.sectionShortcuts`/`secondarySections` → `SectionItems`; `BATCH RECIPES_JSON`
→ `Recipes`/`RecipeIngredients`; `DISTRO DATA` → `Vendors`.
