# Sverka Checklist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 13-point studio QA checklist («Сверка») that activates per uploaded document type, is filled by Claude, and is confirmable/overridable by the PM in a new DetailPage tab.

**Architecture:** Pure logic (registry, filename classifier, activation, row merge, prompt block) lives in a new `src/sverka.js` module with vitest tests. `src/App.jsx` wires it in: `_docType` tags on files, prompt/schema extension, new «Сверка» tab, PM overrides persisted in `perData`, PDF section.

**Tech Stack:** React 19 + Vite (existing), vitest (new devDep, tests only for pure module).

**Spec:** `docs/superpowers/specs/2026-07-14-sverka-checklist-design.md`

## Global Constraints

- Мова UI — українська, стиль існуючий: `fontFamily: "monospace"`, кольори статусів `#27ae60` (ok), `#e67e22` (warn), `#e74c3c` (fail), `#bbb`/`#aaa` (неактивне).
- Жодних нових runtime-залежностей; vitest — тільки devDependency.
- Старі сесії без `sverka`/`sverkaOverrides` не мають падати (fallback «не перевірено»).
- Після кожного таска: `npx vite build` проходить, `npx eslint src/sverka.js src/sverka.test.js` без нових помилок (App.jsx має 4 pre-existing react-hooks помилки — вони не в скоупі, нових не додавати).
- Verify-команди нижче написані для Git Bash.

---

### Task 1: Vitest + модуль sverka.js (реєстр + класифікатор імен)

**Files:**
- Modify: `package.json` (devDependencies + scripts.test)
- Create: `src/sverka.js`
- Create: `src/sverka.test.js`

**Interfaces:**
- Produces: `SVERKA_CHECKS: [{id, label, needs: string[]}]` (13 елементів, id S1–S13); `DOC_TYPES: {[type]: displayLabel}`; `docTypeFromName(filename: string, zoneKey?: string) → string|null`.

- [ ] **Step 1: Встановити vitest і додати скрипт**

```bash
cd /c/Users/dima/render-qa && npm i -D vitest
```

У `package.json` у `"scripts"` додати: `"test": "vitest run"`.

- [ ] **Step 2: Написати падаючі тести**

Створити `src/sverka.test.js`:

```js
import { describe, it, expect } from "vitest";
import { SVERKA_CHECKS, DOC_TYPES, docTypeFromName } from "./sverka.js";

describe("SVERKA_CHECKS", () => {
  it("містить 13 пунктів S1–S13", () => {
    expect(SVERKA_CHECKS).toHaveLength(13);
    expect(SVERKA_CHECKS.map(c => c.id)).toEqual(
      ["S1","S2","S3","S4","S5","S6","S7","S8","S9","S10","S11","S12","S13"]
    );
  });
  it("S2, S4, S11 — завжди активні (needs порожній)", () => {
    for (const id of ["S2", "S4", "S11"]) {
      expect(SVERKA_CHECKS.find(c => c.id === id).needs).toEqual([]);
    }
  });
  it("кожен needs-тип існує в DOC_TYPES", () => {
    SVERKA_CHECKS.flatMap(c => c.needs).forEach(t => expect(DOC_TYPES[t]).toBeTruthy());
  });
});

describe("docTypeFromName", () => {
  it.each([
    ["RCP_final.pdf", "rcp"],
    ["ceiling-plan.dwg", "rcp"],
    ["south_elevation.pdf", "elevation"],
    ["Фасад_північ.jpg", "elevation"],
    ["FFE_list.xlsx", "ffe"],
    ["landscape plan.pdf", "landscape"],   // landscape перемагає plan
    ["Ландшафт_v2.dwg", "landscape"],
    ["розгортки_стін.pdf", "unfold"],
    ["wall_unfolds.pdf", "unfold"],
    ["todo_round2.docx", "todo"],
    ["правки від клієнта.pdf", "todo"],
    ["detail_node_A.pdf", "detail"],
    ["Вузли.dwg", "detail"],
    ["floor plan.pdf", "floorplan"],
    ["Планування.dwg", "floorplan"],
    ["IMG_0234.jpg", null],
  ])("%s → %s", (name, expected) => {
    expect(docTypeFromName(name)).toBe(expected);
  });
  it("файл без збігів у зоні референсів → reference", () => {
    expect(docTypeFromName("moodboard_03.jpg", "refs")).toBe("reference");
  });
  it("збіг по імені сильніший за зону", () => {
    expect(docTypeFromName("ffe_ref.xlsx", "refs")).toBe("ffe");
  });
});
```

- [ ] **Step 3: Запустити — переконатись що падає**

Run: `cd /c/Users/dima/render-qa && npx vitest run src/sverka.test.js`
Expected: FAIL — `Cannot find module './sverka.js'`.

- [ ] **Step 4: Реалізувати `src/sverka.js`**

```js
// Студійний чеклист «Сверка»: пункт активний, якщо серед файлів є документ
// з типом із needs; порожній needs = активний завжди.
export const SVERKA_CHECKS = [
  { id: "S1",  label: "Модель по референсу",    needs: ["reference"] },
  { id: "S2",  label: "Студійні стандарти",      needs: [] },
  { id: "S3",  label: "FFE",                    needs: ["ffe"] },
  { id: "S4",  label: "Текст, позначки",         needs: [] },
  { id: "S5",  label: "Результат до референсу", needs: ["reference"] },
  { id: "S6",  label: "Деталі / вузли",          needs: ["detail"] },
  { id: "S7",  label: "Ландшафтний план",        needs: ["landscape"] },
  { id: "S8",  label: "Елевейшени (екстер'єр)",  needs: ["elevation"] },
  { id: "S9",  label: "План розміщення",         needs: ["floorplan"] },
  { id: "S10", label: "RCP план",                needs: ["rcp"] },
  { id: "S11", label: "Матеріали",               needs: [] },
  { id: "S12", label: "Розгортки",               needs: ["unfold"] },
  { id: "S13", label: "Ту-ду лист (правки)",     needs: ["todo"] },
];

export const DOC_TYPES = {
  reference: "Референс",
  ffe:       "FFE",
  landscape: "Ландшафт",
  elevation: "Елевейшн",
  floorplan: "План",
  rcp:       "RCP",
  unfold:    "Розгортка",
  detail:    "Вузли",
  todo:      "To-do",
};

// Порядок важливий: специфічні патерни (rcp, landscape) — до загального plan/план.
const NAME_RULES = [
  ["rcp",       /rcp|ceiling/],
  ["elevation", /elev|фасад|facade/],
  ["ffe",       /ffe|furniture/],
  ["landscape", /landscape|ландшафт|озелен/],
  ["unfold",    /розгорт|unfold|wall/],
  ["todo",      /todo|правк|fix|comment/],
  ["detail",    /detail|вузл|узл|node/],
  ["floorplan", /plan|план|layout/],
];

export function docTypeFromName(filename, zoneKey) {
  const nm = (filename || "").toLowerCase();
  for (const [type, re] of NAME_RULES) if (re.test(nm)) return type;
  if (zoneKey === "refs") return "reference";
  return null;
}
```

- [ ] **Step 5: Запустити тести — зелені**

Run: `cd /c/Users/dima/render-qa && npx vitest run src/sverka.test.js`
Expected: PASS (усі).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/sverka.js src/sverka.test.js
git commit -m "feat(sverka): add checklist registry and filename doc-type classifier with vitest"
```

---

### Task 2: activeSverka + sverkaRows + sverkaPromptBlock

**Files:**
- Modify: `src/sverka.js`
- Modify: `src/sverka.test.js`

**Interfaces:**
- Consumes: `SVERKA_CHECKS` з Task 1.
- Produces:
  - `activeSverka(docTypes: (string|null)[], mode: string) → [{id, label, needs, active: boolean}]`
  - `sverkaRows(aiSverka: array|undefined, overrides: object|undefined, activeChecks) → [{id, label, active, status, note, doc_ref, zone, overridden}]`; `status ∈ ok|warn|fail|no_material|unchecked`
  - `sverkaPromptBlock(activeChecks, taggedFiles: [{docType, label}]) → string`
  - `SVERKA_STATUS: {[status]: {icon, color, label}}` (для UI і PDF)

- [ ] **Step 1: Дописати падаючі тести в `src/sverka.test.js`**

```js
import { activeSverka, sverkaRows, sverkaPromptBlock, SVERKA_STATUS } from "./sverka.js";

describe("activeSverka", () => {
  it("порожній пакет: активні лише S2, S4, S11", () => {
    const act = activeSverka([], "first").filter(c => c.active).map(c => c.id);
    expect(act).toEqual(["S2", "S4", "S11"]);
  });
  it("rcp + reference вмикають S1, S5, S10", () => {
    const act = activeSverka(["rcp", "reference", null], "first");
    expect(act.find(c => c.id === "S10").active).toBe(true);
    expect(act.find(c => c.id === "S1").active).toBe(true);
    expect(act.find(c => c.id === "S5").active).toBe(true);
    expect(act.find(c => c.id === "S7").active).toBe(false);
  });
  it("S13 активний у режимі revision без документа", () => {
    expect(activeSverka([], "revision").find(c => c.id === "S13").active).toBe(true);
    expect(activeSverka([], "first").find(c => c.id === "S13").active).toBe(false);
  });
});

describe("sverkaRows", () => {
  const checks = activeSverka(["rcp"], "first");
  it("AI-статус потрапляє в рядок", () => {
    const rows = sverkaRows([{ id: "S10", status: "fail", note: "2 світильники зайві", doc_ref: "RCP.pdf", zone: { x: 1, y: 2, w: 3, h: 4 } }], {}, checks);
    const r = rows.find(x => x.id === "S10");
    expect(r.status).toBe("fail");
    expect(r.note).toBe("2 світильники зайві");
    expect(r.zone).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    expect(r.overridden).toBe(false);
  });
  it("override ПМ перекриває AI", () => {
    const rows = sverkaRows([{ id: "S10", status: "fail" }], { S10: "ok" }, checks);
    expect(rows.find(x => x.id === "S10")).toMatchObject({ status: "ok", overridden: true });
  });
  it("неактивний пункт → no_material навіть якщо AI щось повернув", () => {
    const rows = sverkaRows([{ id: "S7", status: "ok" }], {}, checks);
    expect(rows.find(x => x.id === "S7").status).toBe("no_material");
  });
  it("активний пункт без відповіді AI → unchecked; без sverka взагалі — теж", () => {
    expect(sverkaRows([], {}, checks).find(x => x.id === "S2").status).toBe("unchecked");
    expect(sverkaRows(undefined, undefined, checks).find(x => x.id === "S10").status).toBe("unchecked");
  });
  it("завжди 13 рядків у порядку реєстру", () => {
    expect(sverkaRows([], {}, checks).map(r => r.id)).toEqual(SVERKA_CHECKS.map(c => c.id));
  });
});

describe("sverkaPromptBlock", () => {
  it("містить активні пункти з прив'язкою документів і список неактивних", () => {
    const checks = activeSverka(["rcp"], "first");
    const block = sverkaPromptBlock(checks, [{ docType: "rcp", label: "КРЕСЛЕННЯ 1: RCP_final.pdf" }]);
    expect(block).toContain("S10 RCP план → КРЕСЛЕННЯ 1: RCP_final.pdf");
    expect(block).toContain("S2 Студійні стандарти");
    expect(block).toMatch(/no_material.*S1, S3, S5, S6, S7, S8, S9, S12, S13/s);
  });
});

describe("SVERKA_STATUS", () => {
  it("має конфіг для всіх п'яти статусів", () => {
    for (const s of ["ok", "warn", "fail", "no_material", "unchecked"])
      expect(SVERKA_STATUS[s]).toMatchObject({ icon: expect.any(String), color: expect.any(String), label: expect.any(String) });
  });
});
```

(Потрібен також `SVERKA_CHECKS` в імпорті тесту — вже є з Task 1.)

- [ ] **Step 2: Запустити — нові тести падають**

Run: `npx vitest run src/sverka.test.js`
Expected: FAIL — `activeSverka is not a function` (старі тести зелені).

- [ ] **Step 3: Реалізація — дописати в `src/sverka.js`**

```js
export const SVERKA_STATUS = {
  ok:          { icon: "✅", color: "#27ae60", label: "Ок" },
  warn:        { icon: "⚠️", color: "#e67e22", label: "Зауваження" },
  fail:        { icon: "❌", color: "#e74c3c", label: "Не пройдено" },
  no_material: { icon: "⬜", color: "#bbb",    label: "Немає матеріалу" },
  unchecked:   { icon: "·",  color: "#aaa",    label: "Не перевірено" },
};

export function activeSverka(docTypes, mode) {
  const set = new Set((docTypes || []).filter(Boolean));
  return SVERKA_CHECKS.map(c => ({
    ...c,
    active: c.needs.length === 0
      || c.needs.some(n => set.has(n))
      || (c.id === "S13" && mode === "revision"),
  }));
}

export function sverkaRows(aiSverka, overrides, activeChecks) {
  const byId = {};
  (aiSverka || []).forEach(x => { if (x && x.id) byId[x.id] = x; });
  return activeChecks.map(c => {
    const ai = byId[c.id];
    const ov = overrides ? overrides[c.id] : undefined;
    const status = !c.active ? "no_material" : (ov || ai?.status || "unchecked");
    return {
      id: c.id, label: c.label, active: c.active, status,
      note: ai?.note || "", doc_ref: ai?.doc_ref || "", zone: ai?.zone || null,
      overridden: !!ov,
    };
  });
}

export function sverkaPromptBlock(activeChecks, taggedFiles) {
  const files = taggedFiles || [];
  const act = activeChecks.filter(c => c.active);
  const inact = activeChecks.filter(c => !c.active);
  const lines = act.map(c => {
    const docs = files.filter(f => c.needs.includes(f.docType)).map(f => f.label);
    return `${c.id} ${c.label}${docs.length ? ` → ${docs.join(", ")}` : ""}`;
  });
  return `── СВЕРКА (студійний чеклист) ──
Перевір КОЖЕН активний пункт по відповідному документу:
${lines.join("\n")}
${inact.length ? `Неактивні пункти — постав status "no_material": ${inact.map(c => c.id).join(", ")}` : ""}
- Заповни масив "sverka": {"id","status":"ok"|"warn"|"fail"|"no_material","note","doc_ref","zone"}
- note: що звірено і з чим, одне-два речення. doc_ref: назва файлу-джерела.
- zone ОБОВ'ЯЗКОВА для warn/fail — де саме на рендері проблема.`;
}
```

- [ ] **Step 4: Тести зелені**

Run: `npx vitest run src/sverka.test.js`
Expected: PASS (усі).

- [ ] **Step 5: Commit**

```bash
git add src/sverka.js src/sverka.test.js
git commit -m "feat(sverka): activation, row merge with PM overrides, prompt block builder"
```

---

### Task 3: _docType на файлах + селект типу в UI

**Files:**
- Modify: `src/App.jsx` — функція `useFileList`, компоненти `UploadBox` і `DwgSlot`, виклики `useFileList()` в `App`.

**Interfaces:**
- Consumes: `docTypeFromName`, `DOC_TYPES` з `./sverka.js`.
- Produces: файл-об'єкти мають `_docType: string|null`; `useFileList(zoneKey)` повертає додатково `updateDocType(id, type)`; `UploadBox` приймає проп `onDocType`, `DwgSlot` — теж.

- [ ] **Step 1: Імпорт у App.jsx**

Перший рядок імпортів доповнити:

```js
import { SVERKA_CHECKS, DOC_TYPES, SVERKA_STATUS, docTypeFromName, activeSverka, sverkaRows, sverkaPromptBlock } from "./sverka.js";
```

(Імпортуємо все одразу — Task 4–6 використають решту; eslint не лається на unused imports з таким конфігом, але якщо заллється помилка `no-unused-vars` — імпортувати в Task 3 лише `docTypeFromName`, `DOC_TYPES`, а решту додавати в наступних тасках.)

- [ ] **Step 2: `useFileList` — zoneKey, _docType, updateDocType**

Сигнатуру змінити на `function useFileList(zoneKey)`. У `add` при створенні початкового об'єкта і при завершенні обробки додати `_docType`:

```js
const add = useCallback(async (file) => {
    const id = "f" + Date.now() + "_" + Math.random().toString(36).slice(2);
    const ctrl = new AbortController();
    const docType = docTypeFromName(file.name, zoneKey);
    ref.current = [...ref.current, { _id: id, _loading: true, _progress: 0, _ctrl: ctrl, _docType: docType, filename: file.name, preview: null, pages: [], type: null }];
    bump();
    try {
      const buf = await file.arrayBuffer();
      const fileCopy = new File([buf], file.name, { type: file.type });
      const d = await processFile(fileCopy, pct => { ref.current = ref.current.map(x => x._id === id ? { ...x, _progress: pct } : x); bump(); }, ctrl.signal);
      ref.current = ref.current.map(x => x._id === id ? { ...d, _id: id, _docType: docType, _loading: false, _done: true } : x);
    } catch (e) {
      if (e.name === "AbortError") ref.current = ref.current.filter(x => x._id !== id);
      else ref.current = ref.current.map(x => x._id === id ? { ...x, _loading: false, _error: true } : x);
    }
    bump();
  }, [bump, zoneKey]);
```

Поряд з `updateTag` додати:

```js
const updateDocType = useCallback((id, docType) => {
    ref.current = ref.current.map(x => x._id === id ? { ...x, _docType: docType || null } : x);
    bump();
  }, [bump]);
```

І в return: `return { files: ref.current, ref, add, remove, addDone, updateTag, updateDocType };`

- [ ] **Step 3: Виклики в App**

```js
const renders = useFileList("renders"); const briefs = useFileList("briefs"); const refs = useFileList("refs"); const draws = useFileList("draws");
const revBriefs = useFileList("briefs"); const revRefs = useFileList("refs"); const revDraws = useFileList("draws");
```

- [ ] **Step 4: Селект типу в `UploadBox`**

Проп: `function UploadBox({ label, files, onAdd, onAddDone, onRemove, color = "#888", note, onTag, onDocType })`.
Одразу після існуючого блока `{onTag && f._done && !f._loading && (...)}` додати:

```jsx
{onDocType && f._done && !f._loading && (
  <select value={f._docType || ""} onChange={e => onDocType(f._id, e.target.value)} title="Тип документа для чеклиста Сверка"
    style={{ width: 70, fontSize: 8, fontFamily: "monospace", border: `1px solid ${f._docType ? color : "#ddd"}`, borderRadius: 3, padding: "1px 2px", outline: "none", color: f._docType ? "#333" : "#bbb", background: "#fff", boxSizing: "border-box", marginTop: 2 }}>
    <option value="">тип?</option>
    {Object.entries(DOC_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
  </select>
)}
```

- [ ] **Step 5: Селект у `DwgSlot`**

Проп: `function DwgSlot({ files, onAddDwg, onRemove, onConverted, onDocType })`.
У мапі файлів, під `<div ...>{f.filename}</div>` (підпис імені), додати той самий `<select>` що в Step 4 (з `color` = `"#3498db"`).

- [ ] **Step 6: Прокинути пропси у всіх місцях рендеру**

- `UploadBox БРИФИ` (обидва режими first/tz-review): `onDocType={briefs.updateDocType}`; для revision — `onDocType={revBriefs.updateDocType}`.
- `UploadBox РЕФЕРЕНСИ`: `onDocType={refs.updateDocType}` / `revRefs.updateDocType`.
- `DwgSlot` (three місця): `onDocType={draws.updateDocType}` / `revDraws.updateDocType`.
- `UploadBox РЕНДЕРИ` і слоти ДО/ПІСЛЯ — БЕЗ `onDocType` (рендерам тип не потрібен).

- [ ] **Step 7: Верифікація**

Run: `npx vite build && npx vitest run`
Expected: build ✓, тести PASS.
Run: `npx eslint src/App.jsx 2>&1 | grep -c error`
Expected: `4` (тільки pre-existing).

- [ ] **Step 8: Commit**

```bash
git add src/App.jsx
git commit -m "feat(sverka): doc-type auto-tagging on upload with manual select override"
```

---

### Task 4: Промпт, схема, обробка відповіді

**Files:**
- Modify: `src/App.jsx` — константа `JSON_SCHEMA`, функція `normalizeZones`, функція `runAnalysis` (обидві гілки), `retryFailed`, `onReview` в JSX `DetailPage`.

**Interfaces:**
- Consumes: `activeSverka`, `sverkaPromptBlock` з `./sverka.js`.
- Produces: `perData[i].sverka: array` — сирий масив від Claude, нормалізований `normalizeZones`; `perData[i].sverkaOverrides` НЕ чіпається тут (Task 5).

- [ ] **Step 1: Розширити `JSON_SCHEMA`**

У рядку-константі `JSON_SCHEMA` після `"checks":[...]` (перед `"items":`) вставити:

```
"sverka":[{"id":"S10","status":"ok","note":"Світильники по RCP: 6/6 на місцях, розетки по плану","doc_ref":"RCP_final.pdf","zone":{"x":40,"y":8,"w":20,"h":10}},{"id":"S7","status":"no_material","note":"Ландшафтний план не наданий","doc_ref":"","zone":null}],
```

- [ ] **Step 2: `normalizeZones` — нормалізувати і sverka**

```js
function normalizeZones(data) {
  if (!data) return data;
  const fixArr = arr => (arr || []).map(item => item?.zone ? { ...item, zone: normalizeZone(item.zone) } : item);
  return { ...data, items: fixArr(data.items), defects: fixArr(data.defects), corrections: fixArr(data.corrections), sverka: fixArr(data.sverka) };
}
```

- [ ] **Step 3: Гілка first у `runAnalysis` — блок промпта і збір taggedFiles**

Після рядка `const activeChecklist = blocks.join("\n\n");` додати:

```js
      // ── Сверка: активні пункти по типах завантажених документів ─────────────
      const taggedFiles = [];
      const collectTagged = (files, label) => (files || []).forEach((f, fi) => {
        if (f._docType) taggedFiles.push({ docType: f._docType, label: `${label} ${fi + 1}: ${f.filename}` });
      });
      collectTagged(briefsList, "БРИФ"); collectTagged(refsList, "РЕФЕРЕНС"); collectTagged(drawsList, "КРЕСЛЕННЯ");
      const sverkaChecks = activeSverka(taggedFiles.map(t => t.docType), mode);
      const sverkaBlock = sverkaPromptBlock(sverkaChecks, taggedFiles);
```

У шаблоні `cacheParts` (великий промпт) після рядка `── ШАР 3: ТЕХНІЧНІ ДЕФЕКТИ (QA) ──\n${activeChecklist}` додати новий рядок-вставку:

```
── ШАР 4: СВЕРКА (студійний чеклист по документах) ──
${sverkaBlock}
```

- [ ] **Step 4: Результат — записати sverka**

У гілці first, рядок `results[ri] = normalizeZones({ tz_parsed: ..., checks: ..., ... });` доповнити полем `sverka: p.sverka || []`:

```js
results[ri] = normalizeZones({ tz_parsed: p.tz_parsed || [], checks: p.checks || [], items: p.items || [], corrections: p.corrections || [], defects: p.defects || [], materials: p.materials || [], sverka: p.sverka || [], quality: p.quality || null, summary: p.summary || "" });
```

- [ ] **Step 5: Гілка revision — той самий блок**

Перед циклом `for (let ri = 0; ri < vp.length; ri++)` зібрати taggedFiles з `readyFiles(revBriefs)`, `readyFiles(revRefs)`, `readyFiles(revDraws)` (той самий `collectTagged`-патерн, лейбли `БРИФ`/`РЕФЕРЕНС`/`КРЕСЛЕННЯ`) і `const sverkaChecksRev = activeSverka(taggedFilesRev.map(t => t.docType), "revision");`.
У `revBlocks` перед блоком `── РЕГРЕСІЯ ──` додати:

```js
revBlocks.push(sverkaPromptBlock(sverkaChecksRev, taggedFilesRev));
```

У результаті revision-гілки так само додати `sverka: p.sverka || []` всередину `normalizeZones({...})`.

- [ ] **Step 6: `retryFailed` і `onReview` — консистентність**

В обох місцях результат обгорнути в `normalizeZones(...)` (зараз retryFailed/onReview його не викликають — це чинить і давній баг з ненормалізованими зонами) і додати `sverka: p.sverka || []`:

```js
results[ri] = normalizeZones({ tz_parsed: p.tz_parsed || [], checks: p.checks || [], items: p.items || [], corrections: p.corrections || [], defects: p.defects || [], materials: p.materials || [], sverka: p.sverka || [], quality: p.quality || null, summary: p.summary || "" });
```

(в `onReview` — аналогічно для `newData[ri]`, зберігши існуючу структуру).

- [ ] **Step 7: Верифікація**

Run: `npx vite build && npx vitest run`
Expected: build ✓, тести PASS.

- [ ] **Step 8: Commit**

```bash
git add src/App.jsx
git commit -m "feat(sverka): prompt block, response schema, normalized sverka in all analysis paths"
```

---

### Task 5: Вкладка «Сверка» в DetailPage + override ПМ + зони

**Files:**
- Modify: `src/App.jsx` — `DetailPage` (нова вкладка, пропси), `useAnnotatedCanvas` (колір для sverka), виклик `<DetailPage>` в `App` (проп `onSverkaOverride`), `App` (обробник override із збереженням сесії).

**Interfaces:**
- Consumes: `sverkaRows`, `activeSverka`, `SVERKA_STATUS`, `SVERKA_CHECKS` з `./sverka.js`; `perData[i].sverka` з Task 4.
- Produces: `perData[i].sverkaOverrides: {[checkId]: "ok"|"warn"|"fail"}`; проп `DetailPage({ ..., sverkaChecks, onSverkaOverride })`.

- [ ] **Step 1: Обробник override в `App`**

Поряд з `retryFailed` додати:

```js
  function handleSverkaOverride(renderIdx, checkId, status) {
    setPerData(prev => {
      const next = [...prev];
      const cur = next[renderIdx] || {};
      const overrides = { ...(cur.sverkaOverrides || {}) };
      if (status) overrides[checkId] = status; else delete overrides[checkId];
      next[renderIdx] = { ...cur, sverkaOverrides: overrides };
      saveSession({ savedAt: new Date().toISOString(), mode, perData: next, globalSum, consistency, tzCards: tzCards.map(c => ({ ...c, imgPreview: null })), tzAnnotation, tzClientComments });
      return next;
    });
  }
```

- [ ] **Step 2: Обчислити активні пункти в `App` і передати в DetailPage**

Перед `return` в `App` (поряд з `detailProps`):

```js
  const allDocFiles = isRev
    ? [...revBriefs.files, ...revRefs.files, ...revDraws.files]
    : [...briefs.files, ...refs.files, ...draws.files];
  const sverkaChecksUi = activeSverka(allDocFiles.map(f => f._docType), mode);
```

У JSX `<DetailPage ...>` додати пропси:

```jsx
sverkaChecks={sverkaChecksUi}
onSverkaOverride={(checkId, status) => handleSverkaOverride(sel, checkId, status)}
```

- [ ] **Step 3: `DetailPage` — рядки і вкладка**

Сигнатура: додати `sverkaChecks = [], onSverkaOverride` у деструктуризацію пропсів.
Після `const tz_parsed = data?.tz_parsed || [];` додати:

```js
  const svRows = sverkaRows(data?.sverka, data?.sverkaOverrides, sverkaChecks.length ? sverkaChecks : activeSverka([], mode));
  const svChecked = svRows.filter(r => ["ok", "warn", "fail"].includes(r.status)).length;
  const svFail = svRows.filter(r => r.status === "fail").length;
  const svNoMat = svRows.filter(r => r.status === "no_material").length;
```

У `tabs1` першим елементом:

```js
    data?.sverka !== undefined || svChecked > 0 ? { id: "sverka", label: `Сверка (${svChecked}/${svRows.length})` } : { id: "sverka", label: "Сверка" },
```

(простіше: завжди `{ id: "sverka", label: \`Сверка (${svChecked}/${svRows.length})\` }` першим рядком масиву — вкладка є завжди, для старих сесій покаже «не перевірено»).

Дефолт вкладки: `useState(() => checks.length > 0 ? "report" : ...)` НЕ міняти (звіт лишається дефолтом).

- [ ] **Step 4: Контент вкладки**

Поряд з іншими `{tab === "..." && (...)}` блоками додати:

```jsx
{tab === "sverka" && (
  <div style={{ display: "flex", flexDirection: "column" }}>
    <div style={{ padding: "10px 16px", background: "#faf9f7", borderBottom: "1px solid #f0eeea" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontFamily: "monospace", fontWeight: 700, color: "#333" }}>{svChecked}/{svRows.length} перевірено</span>
        {svFail > 0 && <span style={{ fontSize: 9, background: "#e74c3c", color: "#fff", padding: "1px 7px", borderRadius: 8, fontFamily: "monospace" }}>{svFail} ❌</span>}
        {svNoMat > 0 && <span style={{ fontSize: 9, background: "#eee", color: "#888", padding: "1px 7px", borderRadius: 8, fontFamily: "monospace" }}>{svNoMat} без матеріалів</span>}
        <span style={{ fontSize: 9, color: "#bbb", fontFamily: "monospace", marginLeft: "auto" }}>клік по іконці = вердикт ПМ</span>
      </div>
      <div style={{ height: 4, background: "#e8e6e1", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${svRows.length ? Math.round(svChecked / svRows.length * 100) : 0}%`, background: svFail > 0 ? "#e67e22" : "#27ae60", borderRadius: 2, transition: "width 0.4s" }} />
      </div>
    </div>
    {svRows.map(r => {
      const cfg = SVERKA_STATUS[r.status];
      const clickable = r.active && ["ok", "warn", "fail"].includes(r.status);
      const nextStatus = { ok: "warn", warn: "fail", fail: "ok" }[r.status];
      const key = `sverka:${r.id}`;
      return (
        <div key={r.id} onMouseEnter={() => r.zone && setHovId(key)} onMouseLeave={() => setHovId(null)}
          style={{ padding: "10px 16px", borderBottom: "1px solid #f0eeea", display: "flex", gap: 10, alignItems: "flex-start", background: hovId === key ? "#faf9f7" : "#fff", opacity: r.active ? 1 : 0.55 }}>
          <button onClick={clickable && onSverkaOverride ? () => onSverkaOverride(r.id, nextStatus) : undefined}
            title={clickable ? `Змінити на: ${SVERKA_STATUS[nextStatus].label}` : undefined}
            style={{ background: "none", border: "none", fontSize: 15, lineHeight: 1, cursor: clickable ? "pointer" : "default", padding: 0, flexShrink: 0, marginTop: 1 }}>
            {cfg.icon}
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 9, fontFamily: "monospace", fontWeight: 700, color: cfg.color, background: cfg.color + "18", padding: "1px 5px", borderRadius: 3 }}>{r.id}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: r.active ? "#333" : "#aaa" }}>{r.label}</span>
              {r.overridden && <span style={{ fontSize: 8, background: "#1a1a1a", color: "#fff", padding: "1px 5px", borderRadius: 3, fontFamily: "monospace" }}>ПМ</span>}
              {r.doc_ref && <span style={{ fontSize: 8, background: "#f0eeea", color: "#888", padding: "1px 5px", borderRadius: 3, fontFamily: "monospace" }}>📎 {r.doc_ref}</span>}
              {r.zone && <span style={{ fontSize: 8, color: "#3498db", fontFamily: "monospace" }}>📍</span>}
            </div>
            {r.note && <div style={{ fontSize: 11, color: "#777", lineHeight: 1.5, marginTop: 2 }}>{r.note}</div>}
            {r.status === "no_material" && <div style={{ fontSize: 10, color: "#bbb", fontFamily: "monospace", marginTop: 2 }}>додай {r.needs.map(n => DOC_TYPES[n]).join(" / ")} у пакет — пункт увімкнеться</div>}
          </div>
        </div>
      );
    })}
  </div>
)}
```

Примітка: `r.needs` доступний, бо `sverkaRows` мапить з `activeChecks` — додати `needs: c.needs` у результат `sverkaRows` в `src/sverka.js` (і рядок у тест: `expect(rows[0].needs).toEqual(SVERKA_CHECKS[0].needs);`).

- [ ] **Step 5: Зони sverka на рендері**

У `allAnns` (масив у `DetailPage`) додати четвертим джерелом:

```js
    ...svRows.filter(r => r.zone).map((r, i) => ({ ...r, comment: r.label, qa_tag: null, _src: "sverka", _srcIdx: i, _label: r.id.slice(1) })),
```

У `useAnnotatedCanvas` у виборі кольору додати гілку перед material:

```js
      if (ann._src === "sverka") col = (SVERKA_STATUS[ann.status]?.color) || "#888";
      else if (ann._src === "material") col = MAT_STATUS[ann.status]?.color || "#9b59b6";
      else col = ann.qa_tag ? (QC[ann.qa_tag] || "#888") : (STATUS[ann.status]?.color || "#888");
```

- [ ] **Step 6: Верифікація**

Run: `npx vite build && npx vitest run`
Expected: build ✓, PASS. `npx eslint src/App.jsx 2>&1 | grep -c " error"` → `4` (без нових).

- [ ] **Step 7: Commit**

```bash
git add src/App.jsx src/sverka.js src/sverka.test.js
git commit -m "feat(sverka): DetailPage tab with PM overrides, progress header, render zones"
```

---

### Task 6: Секція «Сверка» у PDF-звіті

**Files:**
- Modify: `src/App.jsx` — функція `generateReport`.

**Interfaces:**
- Consumes: `sverkaRows`, `activeSverka`, `SVERKA_STATUS`; `perData[i].sverka`, `perData[i].sverkaOverrides`.

- [ ] **Step 1: HTML-блок**

У `generateReport`, всередині мапи `rendersHtml = perData.map((data, i) => ...)`, після `checksHtml` додати:

```js
      const svRows = sverkaRows(data.sverka, data.sverkaOverrides, activeSverka([], mode)).map(r => {
        // активність у PDF відновлюємо з відповіді AI: no_material лишається як прийшло
        const ai = (data.sverka || []).find(x => x.id === r.id);
        return ai ? { ...r, status: data.sverkaOverrides?.[r.id] || ai.status, active: ai.status !== "no_material" } : r;
      });
      const svHtml = (data.sverka || []).length ? `
        <div class="sub-title">Сверка (${svRows.filter(r => ["ok","warn","fail"].includes(r.status)).length}/${svRows.length})</div>
        <div class="def-list">
          ${svRows.map(r => `<div class="def-row">
            <span class="dot" style="background:${SVERKA_STATUS[r.status]?.color || "#aaa"}"></span>
            <div><b>${e(r.id)} ${e(r.label)}</b>${r.overridden ? ` <span class="tag">ПМ</span>` : ""}${r.doc_ref ? ` <span class="tag">${e(r.doc_ref)}</span>` : ""}${r.note ? `<br><span class="dim">${e(r.note)}</span>` : ""}</div>
          </div>`).join("")}
        </div>` : "";
```

І в шаблоні блока рендера вставити `${svHtml}` після `${checksHtml}`:

```js
        ${checksHtml}${svHtml}${defHtml}${matHtml}
```

- [ ] **Step 2: Верифікація**

Run: `npx vite build && npx vitest run`
Expected: ✓ / PASS.

- [ ] **Step 3: Commit**

```bash
git add src/App.jsx
git commit -m "feat(sverka): sverka section in PDF report with PM override badges"
```

---

### Task 7: Фінальна верифікація

**Files:** нічого нового — прогін.

- [ ] **Step 1: Повний прогін інструментів**

```bash
cd /c/Users/dima/render-qa && npx vitest run && npx vite build && npx eslint . 2>&1 | tail -3
```

Expected: тести PASS, build ✓, eslint — ті самі 4 pre-existing помилки (react-hooks у useFileList/DetailPage), жодної нової.

- [ ] **Step 2: Ручний прогін у браузері** (`npm run dev`)

Чеклист:
1. Завантажити файл `RCP_test.pdf` у КРЕСЛЕННЯ → на чіпі селект показує «RCP» автоматично.
2. Змінити тип селектом на «Елевейшн» → значення тримається.
3. Завантажити рендер + референс + запустити перевірку (потрібен API-ключ) → у DetailPage вкладка «Сверка»: S1/S2/S4/S5 + пункт по типу креслення зі статусами, решта ⬜ з підказкою.
4. Клік по ✅ → ⚠️ з бейджем «ПМ»; F5 → «Відновити» сесію → override зберігся.
5. 📄 PDF → секція «Сверка» присутня, override з бейджем ПМ.
6. Стара сесія (створена до фічі) відновлюється без помилок, вкладка показує «не перевірено».

- [ ] **Step 3: Коміт залишків (якщо були фікси) і підсумок**

```bash
git add -A && git commit -m "test(sverka): final verification fixes" || echo "nothing to fix"
```

---

## Self-Review (виконано)

- **Spec coverage:** реєстр (T1), тегування+UI (T3), промпт/схема/нормалізація всіх шляхів (T4), вкладка+override+зони+сесія (T5), PDF (T6), fallback-и (sverkaRows unchecked-гілка, T2/T5), верифікація (T7). Розбіжностей зі спекою немає.
- **Placeholder scan:** чисто.
- **Type consistency:** `sverkaRows(aiSverka, overrides, activeChecks)` і `activeSverka(docTypes, mode)` вживаються однаково в T2/T5/T6; `_docType` консистентний T3→T4→T5.
