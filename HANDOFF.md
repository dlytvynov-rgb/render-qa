# Render QA — Handoff & Architecture Brief

> **Purpose of this file:** give another AI or developer everything needed to understand what this app is, how it's built, and — most importantly — **the exact check logic**. Written to be read top-to-bottom. UI text, prompts, and identifiers are in Ukrainian; they are quoted verbatim where they matter.

**Live app:** https://dlytvynov-rgb.github.io/render-qa/
**Repo:** https://github.com/dlytvynov-rgb/render-qa (public)

---

## 1. What it is

A QA tool for 3D architectural visualization (interior & exterior renders). A project manager uploads a client package — brief, drawings, references, specs — plus the finished renders. **Claude's vision API checks whether each render matches the technical brief (ТЗ)** and returns a per-point verdict, on-image zone markers, quality scores, and a PDF report.

It is a **100% client-side single-page app**. No backend. The browser:
- parses files locally (PDF via pdf.js, XLSX via SheetJS, DOCX via mammoth, DWG/DXF via a hand-written entity parser);
- calls `https://api.anthropic.com` **directly** with the `anthropic-dangerous-direct-browser-access` header;
- the user pastes their own Anthropic API key (stored only in `localStorage`, never committed).

Because it's static + client-side, it deploys to GitHub Pages (or any CDN) and is shared by URL. There is also an optional Electron desktop wrapper (`electron/`), secondary.

---

## 2. Run / build / deploy

```bash
npm install
npm run dev       # Vite dev server (UI)
npm run test      # vitest — 39 tests, covers all Cross-Check logic in src/sverka.js
npm run build     # static build → dist/index.html (single self-contained file)
npm run preview   # serve the build locally
# optional desktop:
npm run electron  # Electron dev
npm run dist       # build .exe/.dmg → release/
```

**Tech:** React 19 + Vite. `vite-plugin-singlefile` inlines everything into one `index.html`. `base: './'` so it works from a subpath (Pages) or `file://`. Fonts (Inter Tight, IBM Plex Mono) from Google Fonts; pdf.js / SheetJS / mammoth lazy-loaded from cdnjs. Deploy is automatic: push to `main` → `.github/workflows/deploy-pages.yml` runs test+build+publish.

**Anthropic model:** `claude-sonnet-4-20250514` (hardcoded in `callAPI`), with prompt-caching. All vision calls go through one function: `callAPI(parts, retries, apiKey)` in `src/App.jsx`.

---

## 3. File map

```
src/App.jsx          ★ ~3000 lines — ALL UI + logic in one file:
                       file parsing, upload zones, Claude calls, verdict rendering,
                       PDF report generation, the Lab, and every prompt constant.
src/sverka.js        ★ Cross-Check engine (pure, unit-tested): the 13-point registry,
                       document-type classifier, activation, row-merge with PM overrides,
                       and the focused single-check / compare prompt builders.
src/sverka.test.js     39 vitest tests for sverka.js (the only tested module — it's the
                       decision logic; App.jsx is UI).
src/theme.css          Design tokens (Zinc-dark "Viewport" system) + component classes (.vp-*).
src/main.jsx           React entry.
src/index.css          Vite reset.
index.html             HTML shell, font links, <title>.
vite.config.js         singlefile plugin + base './'.
electron/              Optional desktop wrapper (main.js serves dist/, exposes save-pdf).
.github/workflows/
   deploy-pages.yml    Auto-deploy to GitHub Pages on push to main.
   build.yml           Manual Electron .exe/.dmg build (workflow_dispatch only).
docs/superpowers/      Design specs + implementation plans (history of each feature).
ROADMAP.md             The intended 8-stage "smart ТЗ processing" pipeline (vision, not all built).
```

There is **no backend, no database, no server code** to hand over. The whole product is the front end.

---

## 4. Data flow (one analysis)

1. User picks a **mode** and drops files into zones (each file is parsed in-browser to `{pages:[{b64, preview, text}], textContent, type, ext, _docType, _tag}`).
2. `runAnalysis()` (in `App.jsx`) builds a Claude request as an array of `parts`:
   - a big **text prompt** (role + ТЗ + `ZONE_PROMPT` + the active check blocks + `JSON_SCHEMA`),
   - then the reference/brief/drawing images (labeled `БРИФ 1:`, `КРЕСЛЕННЯ 1:` …),
   - then the render image(s).
   - The reference/brief/drawing part is marked `cache_control: ephemeral` so it's prompt-cached across renders.
3. `callAPI` sends it, extracts the first JSON object from the reply, `JSON.parse`s it.
4. `normalizeZones()` clamps all `zone` coordinates to 0–100 %.
5. The result object is stored in `perData[renderIndex]` and rendered: verdict banner, tabs (Cross-Check / Звіт / ТЗ / Дефекти / Матеріали / Креслення), and **zone markers drawn on the render via `<AnnotatedImage>`** (canvas overlay).
6. Session is saved to `localStorage` (`rqa_session`) so it survives reload.

**Claude returns ONE JSON object.** Its full shape is the `JSON_SCHEMA` constant in `App.jsx` (an example is embedded there verbatim). Top-level keys: `tz_parsed`, `sverka`, `checks`, `items`, `corrections`, `defects`, `materials`, `quality`, `summary`, `globalSummary`.

---

## 5. THE CHECK LOGIC (the important part)

There are **two parallel check systems** the app asks Claude to fill in. They are complementary, not duplicates.

### 5A. QA checks — organized by defect TYPE (`checks[]`, tags `Q*` / `AD*`)

Defined in `QA_CHECKS` (`App.jsx`). Each check has an id, a short label, a color. Claude returns one entry per check in `checks[]` with `{id, status, group, note}`, `status ∈ ok | warn | fail | skipped`.

| id | label (uk) | meaning |
|----|-----------|---------|
| **Q1.1** | Левітація | Floating objects / missing contact shadows — furniture legs, decor not touching the surface. |
| **Q1.2** | Перетин | Geometry clipping — objects intersecting walls/floor/ceiling/each other. |
| **Q1.3** | Текстури | Texture problems — tiling/repetition, stretching, wrong scale, visible seams. |
| **Q1.4** | Зубчатість | Aliasing / jagged edges on curves, thin objects, railings. |
| **Q1.5** | Артефакти | Render artifacts — fireflies, noise, blotchy shadows, light leaks. |
| **Q1.6** | Відбиття | PBR material correctness — IOR, roughness, metalness, reflection plausibility. |
| **Q2.1** | Креслення | Compliance with supplied drawings (floorplan, elevations, RCP, sections, layout). |
| **Q2.2** | Мудборд/Бриф | Compliance with brief / moodboard (colors, style, season, day/night, mood). |
| **Q2.3** | Моделі | Specific requested furniture/models/plants present. |
| **Q3.1** | Геосеттинг | Realism details — outlets, license plates, curtains, vegetation, road signs, "88:88" clocks. |
| **Q3.2** | Написи/Лого | Text/logo/signage — placeholder/lorem, gibberish, wrong language, distorted logos. |
| **Q4.1** | Client Req | Client technical requirements — resolution/DPI, aspect ratio, file format, ##ACTQ studio standards. |
| **AD.1–AD.4** | (Art Director) | Independent artistic layer: composition, lighting, color/atmosphere, materials/texture feel. |

Groups used in `checks[].group`: `technical` (Q1.x), `tz` (Q2.x type-mismatch), `materials` (shade nuance), `geosetting` (Q3.x), `client` (Q4.x), `artistic` (AD.x).

The prompt for these is **assembled dynamically** in `runAnalysis` from `blocks[]` — only the relevant blocks are included based on what was uploaded and keyword-sniffing of the ТЗ text (`isExterior`, `isInterior`, `hasLogoMention`, `isMiddleEast`, `hasLandscape`). So an interior project without drawings won't get the exterior/RCP block, etc.

### 5B. Cross-Check — organized by DOCUMENT TYPE (`sverka[]`, ids `S1`–`S13`)

This is the studio's own checklist, and it lives in **`src/sverka.js`** (the tested module). Each item activates only when a document of the required type is present.

`SVERKA_CHECKS` (id → label → `needs` document types):

| id | label (uk) | activates when… |
|----|-----------|-----------------|
| S1 | Модель по референсу | a `reference` present |
| S2 | Студійні стандарти | always (`needs: []`) |
| S3 | FFE | an `ffe` doc present |
| S4 | Текст, позначки | always |
| S5 | Результат до референсу | a `reference` present |
| S6 | Деталі / вузли | a `detail` doc present |
| S7 | Ландшафтний план | a `landscape` doc present |
| S8 | Елевейшени (екстер'єр) | an `elevation` doc present |
| S9 | План розміщення | a `floorplan` doc present |
| S10 | RCP план | an `rcp` doc present |
| S11 | Матеріали | always |
| S12 | Розгортки | an `unfold` doc present |
| S13 | Ту-ду лист (правки) | a `todo` doc present **OR** mode === "revision" |

**Document types** (`DOC_TYPES`): `reference, ffe, landscape, elevation, floorplan, rcp, unfold, detail, todo`. Each uploaded file gets a `_docType`, assigned by `docTypeFromName(filename, zoneKey)` — a filename-keyword heuristic (e.g. `rcp|ceiling → rcp`, `elev|фасад → elevation`, `todo|правк → todo`; files in the references zone default to `reference`). The PM can override the type via a dropdown on each file chip.

Claude returns `sverka[]` entries: `{id, status, note, doc_ref, zone}`, `status ∈ ok | warn | fail | no_material`.

**Key functions in `sverka.js` (all pure, unit-tested):**
- `docTypeFromName(name, zoneKey) → docType|null` — the classifier.
- `activeSverka(docTypes[], mode) → [{...check, active}]` — which of the 13 are live for this package.
- `sverkaRows(aiSverka, overrides, activeChecks) → 13 rows` — merges Claude's answer with **PM manual overrides** (`sverkaOverrides` map), produces the final display rows. An AI verdict keeps a check "alive" even in a restored session where the files are gone.
- `sverkaPromptBlock(activeChecks, taggedFiles) → string` — the "── CROSS-CHECK ──" block injected into the analysis prompt, listing active checks with their document bindings.
- `sverkaSinglePrompt(check, docLabel, tzText, zoneRules)` — focused prompt for the **Lab** (test one check in isolation).
- `sverkaSingleComparePrompt(check, changeList, zoneRules)` + `sverkaIsComparison(checkId)` — **before/after comparison** prompt (currently S13 "to-do"): compares РЕНДЕР ДО vs РЕНДЕР ПІСЛЯ against a change list, returns per-change `{text, done: yes|partial|no|regressed}`.

**PM stays in charge:** Claude proposes verdicts; the PM can click any Cross-Check status to override it (a "ПМ" badge appears). Overrides persist to the session and the PDF. This is deliberate — see §8.

### 5C. Quality scoring (`quality`)

`STANDARDS` = `NON` (<55, low) / `MLR` (55–79, mid) / `SDC` (80–100, high). Claude returns two independent 0–100 numbers:
- `quality.score` — render quality (uses Q1.x + AD.x + Q3.x).
- `quality.tz_score` — ТЗ fulfillment (uses Q2.x + Q4.x), with `tz_done`/`tz_total`.
Plus `criteria[]` (4 named sub-scores) and `upgradeTips[]`. A render can be SDC 90 % but tz_score 40 % — intentional; they're different axes.

### 5D. Other result arrays
- `items[]` — visual ТЗ markers on the render `{id, comment, status: fixed|not_fixed|partial, note, zone}`.
- `defects[]` — found defects `{id, title, description, severity: high|medium|low, qa_tag, zone}`.
- `corrections[]` — suggested fixes `{id, title, description, priority, zone}`.
- `materials[]` — every material vs spec `{id, name, group, spec, expected, status: match|mismatch|missing|unknown, note, zone}`.
- `tz_parsed[]` — what Claude understood from the brief, grouped by category (shown in the "ТЗ розбір" tab).

All `zone` objects are `{x, y, w, h}` in **percent 0–100** of image size (see `ZONE_PROMPT` for the rules Claude is given).

---

## 6. App modes & the Lab

State in `App()`: `view ∈ "app" | "lab"`, and within `"app"`: `mode ∈ "tz-review" | "first" | "revision"`, `step ∈ 1 | 2`.

- **tz-review** — parse the ТЗ into a structured checklist (cards), editable, export to PDF. No renders needed.
- **first** — the main flow: renders vs ТЗ/refs/drawings → per-render verdict grid → detail page.
- **revision** — before/after pairs (round comparison): did the requested fixes get applied.
- **Lab** (`view="lab"`, `LabPage` component) — an isolated bench to calibrate ONE Cross-Check point: one render + one document + a check selector → verdict + zone + raw JSON. For the "to-do" check it switches to **ДО/ПІСЛЯ + change list** comparison. This is where you tune per-check prompt wording.

---

## 7. Key prompt constants (all in `App.jsx`)

- `ZONE_PROMPT` — the rules for how Claude must output zone coordinates (percent, small boxes, examples of right/wrong).
- `JSON_SCHEMA` — a full worked example of the exact JSON Claude must return (this IS the contract).
- `QUAL_C` — definitions of NON/MLR/SDC quality bands.
- `BLUEPRINT_COMPARE_PROMPT` — the drawing-compliance sub-prompt (Q2.1).
- The main role prompt (two-layer: PM checking ТЗ compliance + Art Director checking artistry) is built inline in `runAnalysis` as `cacheParts[0]`.
- Cross-Check prompt blocks come from `sverka.js` (`sverkaPromptBlock`, `sverkaSinglePrompt`, `sverkaSingleComparePrompt`).

To change how a check behaves, edit its wording in these constants / builders. The **Lab** is the fastest way to A/B a change on one image.

---

## 8. Constraints & gotchas (learned from research — respect these)

- **Claude does NOT receive image metadata.** Resolution / DPI / aspect / color-space (Q4.1) cannot be judged by the model — they must be computed client-side (e.g. via `exifr`). Q4.1 is currently asked of Claude and is therefore unreliable — a known gap.
- **Claude's object counting is approximate**, especially many small objects → RCP fixture counting (S10) is inherently shaky; corroborate.
- **Vision encoders downscale to ~224 px** → small defects (texture seams, aliasing, fireflies, tiny text, "88:88") vanish. The mitigation is cropping/zooming into suspect regions (a crop-tool loop) — not yet implemented, high-value.
- **Coordinates are approximate** and returned in Claude's internally-resized space. The app asks for percentages; Anthropic actually recommends absolute pixels + normalize yourself — worth A/B in the Lab.
- **Pairwise (A/B) comparison beats single-image** grading — the revision/compare flows lean on this.
- A full research memo on accuracy techniques + browser libraries (Tesseract.js, OpenCV.js, transformers.js/CLIP/DINOv2, pixelmatch, exifr, LPIPS/CLIP-IQA) exists in the project's private research notes; ask the owner if you're improving accuracy.

---

## 9. Testing & quality gates

- `npm run test` → 39 vitest tests, all green. They cover the entire `sverka.js` decision logic (registry integrity, classifier, activation, row-merge/overrides, prompt builders, comparison).
- `npm run build` must pass.
- `npm run lint` currently reports **4 pre-existing** `react-hooks` errors + 1 warning in `App.jsx` (ref-access-in-render in `useFileList`, setState-in-effect in `DetailPage`). They don't break build or runtime; noted for future cleanup. Don't add new ones.

## 10. Where to start if you're extending it

- Change/add a Cross-Check point → `src/sverka.js` (`SVERKA_CHECKS`, and the `needs` type). Add a test.
- Change a prompt / defect definition → the constants in `src/App.jsx` (§7); calibrate in the Lab.
- Add a browser-side deterministic check (metadata, OCR, before/after pixel diff) → new module, wire into `runAnalysis`; keep it client-side (no backend — that's the whole point).
- Never break `callAPI`, the `JSON_SCHEMA` contract, or `normalizeZones` — the UI depends on that shape.
