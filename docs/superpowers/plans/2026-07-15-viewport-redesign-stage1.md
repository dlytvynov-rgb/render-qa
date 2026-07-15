# Viewport Redesign — Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перевести екран завантаження на темну систему «Viewport» (токени, Archivo + IBM Plex Mono, marching ants, ⚙-попап ключів) і додати типовані слоти за запитом.

**Architecture:** `src/theme.css` — CSS-змінні і базові класи, підключається в `main.jsx`. Механіка слотів — один спільний `useFileList("custom")` + масив доданих типів у localStorage; файли отримують `_docType` слота примусово. Рестайл — точкові заміни інлайн-стилів у межах step-1 компонентів (UploadBox, DwgSlot, step-1 JSX, хедер).

**Tech Stack:** React 19 + Vite (existing), CSS custom properties, Google Fonts (Archivo, IBM Plex Mono) з системним fallback.

**Spec:** `docs/superpowers/specs/2026-07-15-viewport-redesign-design.md`

## Global Constraints

- Токени зі спеки verbatim: `--void #131519`, `--panel #1c1f26`, `--line #2a2e37`, `--text #e8e6e1`, `--dim #8b8f98`, `--amber #e8a84c`, `--ok #55c47c`, `--warn #e67e22`, `--fail #ef5350`, `--info #56a8e8`.
- Логіка аналізу не змінюється; `npx vitest run` зелений БЕЗ правок тестів; `npx vite build` проходить; eslint — без нових помилок (4 pre-existing).
- PDF-функції (`generateReport`, `generateTzReport`) не чіпати.
- DetailPage і Grid у цьому етапі не рестайлити (Етап 2).
- `prefers-reduced-motion: reduce` вимикає анімацію marching ants.

---

### Task 1: theme.css + шрифти + темне тло

**Files:**
- Create: `src/theme.css`
- Modify: `src/main.jsx` (import), `index.html` (fonts + title), `src/App.jsx` (клас `.qa-bg` → токени, прибрати blueprint-SVG)

**Interfaces:**
- Produces: CSS-класи `.vp-dropzone`, `.vp-dropzone--drag`, `.vp-btn`, `.vp-btn--primary`, `.vp-chip`, `.vp-label`, `.vp-input`, змінні токенів; шрифтові стеки `var(--font-ui)`, `var(--font-mono)`.

- [ ] **Step 1: Створити `src/theme.css`**

```css
/* Viewport design system — tokens */
:root {
  --void:  #131519;
  --panel: #1c1f26;
  --line:  #2a2e37;
  --text:  #e8e6e1;
  --dim:   #8b8f98;
  --amber: #e8a84c;
  --ok:    #55c47c;
  --warn:  #e67e22;
  --fail:  #ef5350;
  --info:  #56a8e8;
  --font-ui: "Archivo", "Segoe UI", sans-serif;
  --font-mono: "IBM Plex Mono", Consolas, monospace;
}

body { background: var(--void); color: var(--text); font-family: var(--font-ui); }

/* фокус — видимий, бурштиновий */
:focus-visible { outline: 2px solid var(--amber); outline-offset: 1px; }

/* службова мітка (eyebrow) */
.vp-label {
  font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.14em;
  color: var(--dim); text-transform: uppercase;
}

/* панель/картка */
.vp-panel { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; }

/* кнопки */
.vp-btn {
  font-family: var(--font-mono); font-size: 11px; color: var(--dim);
  background: transparent; border: 1px solid var(--line); border-radius: 6px;
  padding: 6px 12px; cursor: pointer; transition: border-color .15s, color .15s;
}
.vp-btn:hover { border-color: var(--dim); color: var(--text); }
.vp-btn--primary {
  background: var(--amber); border-color: var(--amber); color: #131519; font-weight: 600;
}
.vp-btn--primary:hover { filter: brightness(1.08); color: #131519; }
.vp-btn--primary:disabled { background: var(--line); border-color: var(--line); color: var(--dim); cursor: not-allowed; filter: none; }

/* інпут */
.vp-input {
  background: var(--void); border: 1px solid var(--line); border-radius: 6px;
  color: var(--text); font-family: var(--font-mono); font-size: 11px;
  padding: 7px 10px; outline: none; box-sizing: border-box;
}
.vp-input::placeholder { color: var(--dim); opacity: .6; }

/* дропзона + marching ants */
.vp-dropzone {
  border: 1.5px dashed var(--line); border-radius: 8px; background: var(--panel);
  transition: border-color .15s;
}
.vp-dropzone--drag {
  border-color: transparent;
  background-image: linear-gradient(90deg, var(--amber) 50%, transparent 50%),
                    linear-gradient(90deg, var(--amber) 50%, transparent 50%),
                    linear-gradient(0deg,  var(--amber) 50%, transparent 50%),
                    linear-gradient(0deg,  var(--amber) 50%, transparent 50%);
  background-repeat: repeat-x, repeat-x, repeat-y, repeat-y;
  background-size: 12px 1.5px, 12px 1.5px, 1.5px 12px, 1.5px 12px;
  background-position: 0 0, 0 100%, 0 0, 100% 0;
  animation: vp-ants .5s linear infinite;
}
@keyframes vp-ants {
  to { background-position: 12px 0, -12px 100%, 0 -12px, 100% 12px; }
}
@media (prefers-reduced-motion: reduce) {
  .vp-dropzone--drag { animation: none; }
}

/* чіп файла/тега */
.vp-chip {
  font-family: var(--font-mono); font-size: 9px; color: var(--dim);
  background: var(--void); border: 1px solid var(--line); border-radius: 4px; padding: 2px 6px;
}
```

- [ ] **Step 2: Підключити**

`src/main.jsx` — додати `import "./theme.css";` після `import "./index.css";`.
`index.html` — у `<head>` перед `</head>`:

```html
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet" />
```

і `<title>render-qa</title>` → `<title>Render QA</title>`.

- [ ] **Step 3: Темне тло замість blueprint**

У `App.jsx` в `<style>{...}</style>` внизу компонента `App`: видалити весь блок `.qa-bg { ... }` (з гігантським SVG data-URI) і замінити на:

```css
.qa-bg { background: var(--void); }
```

Кореневий div `App`: `fontFamily: "Georgia, serif"` → `fontFamily: "var(--font-ui)"`.

- [ ] **Step 4: Верифікація + коміт**

Run: `npx vite build && npx vitest run` → build ✓, 32 PASS.
Браузер: сторінка темна, шрифт Archivo.

```bash
git add src/theme.css src/main.jsx index.html src/App.jsx
git commit -m "feat(viewport): design tokens, fonts, dark base"
```

---

### Task 2: Механіка слотів за запитом

**Files:**
- Modify: `src/App.jsx` — `useFileList` (forcedType в `add`), `App` (custom slots state + wiring), новий компонент `CustomSlot`.

**Interfaces:**
- Consumes: `useFileList`, `DOC_TYPES`, `UploadBox`-патерни.
- Produces: `customSlots: string[]` (persisted `rqa_custom_slots`); `customFiles = useFileList("custom")`; `add(file, forcedType)`; компонент `CustomSlot({ type, files, onAdd, onRemove, onRemoveSlot })`; helper `customByCategory(files)` → `{briefLike, refLike, drawLike}`.

- [ ] **Step 1: `useFileList.add` — примусовий тип**

```js
const add = useCallback(async (file, forcedType) => {
    ...
    const docType = forcedType || docTypeFromName(file.name, zoneKey);
    ...
```

(обидва місця, де ставиться `_docType`, без інших змін).

- [ ] **Step 2: Стан слотів у `App`**

```js
  const customFiles = useFileList("custom");
  const [customSlots, setCustomSlots] = useState(() => {
    try { return JSON.parse(localStorage.getItem("rqa_custom_slots")) || []; } catch { return []; }
  });
  const saveCustomSlots = slots => { setCustomSlots(slots); try { localStorage.setItem("rqa_custom_slots", JSON.stringify(slots)); } catch { /* ignore */ } };
  const [slotMenuOpen, setSlotMenuOpen] = useState(false);
```

Helper поряд з `readyFiles`:

```js
  const CUSTOM_CATEGORY = { rcp: "draw", elevation: "draw", landscape: "draw", unfold: "draw", detail: "draw", floorplan: "draw", ffe: "brief", todo: "brief", reference: "ref" };
  const customByCategory = files => {
    const out = { briefLike: [], refLike: [], drawLike: [] };
    (files || []).forEach(f => {
      const cat = CUSTOM_CATEGORY[f._docType] || "brief";
      if (cat === "draw") out.drawLike.push(f); else if (cat === "ref") out.refLike.push(f); else out.briefLike.push(f);
    });
    return out;
  };
```

- [ ] **Step 3: Влити кастомні файли в аналіз**

У `runAnalysis` (гілка first) і в `parseTzCards`, там де формуються списки:

```js
      const custom = customByCategory(readyFiles(customFiles));
      const drawsList = [...readyFiles(draws), ...custom.drawLike];
      const briefsList = [...readyFiles(briefs), ...custom.briefLike];
      const refsList = [...readyFiles(refs), ...custom.refLike];
```

(У `runAnalysis` рядки `const drawsList = readyFiles(draws);` тощо — замінити; у `parseTzCards` — аналогічно. `onReview` в JSX використовує `readyFiles(draws)`/`readyFiles(briefs)`/`readyFiles(refs)` — теж доповнити custom.) `allDocFiles` для `sverkaChecksUi` доповнити `...customFiles.files`.

- [ ] **Step 4: Компонент `CustomSlot`** (поряд з `UploadBox`)

```jsx
function CustomSlot({ type, files, onAdd, onRemoveFile, onRemoveSlot }) {
  const inputRef = useRef(); const [drag, setDrag] = useState(false); const ctr = useRef(0);
  const ico = { pdf: "📄", dwg: "📐", dxf: "📐", excel: "📊", text: "📝", image: "🖼️", other: "📎" };
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
        <span className="vp-label" style={{ color: "var(--amber)" }}>{DOC_TYPES[type]}</span>
        <span className="vp-chip">слот</span>
        <span style={{ flex: 1 }} />
        <button onClick={() => files.length === 0 && onRemoveSlot(type)} title={files.length ? "Спочатку прибери файли" : "Прибрати слот"}
          style={{ background: "none", border: "none", color: files.length ? "var(--line)" : "var(--dim)", cursor: files.length ? "default" : "pointer", fontSize: 11 }}>✕</button>
      </div>
      <div className={`vp-dropzone${drag ? " vp-dropzone--drag" : ""}`}
        onDragEnter={e => { e.preventDefault(); ctr.current++; setDrag(true); }}
        onDragLeave={e => { e.preventDefault(); if (--ctr.current === 0) setDrag(false); }}
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); setDrag(false); ctr.current = 0; Array.from(e.dataTransfer.files).forEach(f => onAdd(f, type)); }}
        style={{ padding: 8, minHeight: 78, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", justifyContent: files.length === 0 ? "center" : "flex-start" }}>
        {files.map((f, i) => {
          const prev = f.preview || f.pages?.[0]?.preview;
          return (
            <div key={f._id || i} style={{ position: "relative", width: 62, height: 62, flexShrink: 0 }}>
              {prev
                ? <img src={prev} style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 5, border: "1px solid var(--line)", filter: f._loading ? "brightness(0.4)" : "none" }} />
                : <div style={{ width: "100%", height: "100%", borderRadius: 5, border: "1px solid var(--line)", background: "var(--void)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2 }}>
                    <div style={{ fontSize: 16 }}>{f._error ? "⚠️" : ico[f.type] || ico.other}</div>
                    <div style={{ fontSize: 7, color: "var(--dim)", fontFamily: "var(--font-mono)" }}>{f._error ? "ERR" : (f.ext || "...")}</div>
                  </div>}
              {f._loading && <div style={{ position: "absolute", inset: 0, borderRadius: 5, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "#fff", fontFamily: "var(--font-mono)" }}>{f._progress || 0}%</div>}
              {!f._loading && <button onClick={() => onRemoveFile(f._id)} style={{ position: "absolute", top: -5, right: -5, width: 15, height: 15, background: "var(--fail)", color: "#fff", border: "none", borderRadius: "50%", cursor: "pointer", fontSize: 9, display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>}
            </div>
          );
        })}
        <div onClick={() => inputRef.current.click()} style={{ width: 62, height: 62, border: "1.5px dashed var(--line)", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "var(--dim)", fontSize: 18, flexShrink: 0 }}>+</div>
      </div>
      <input ref={inputRef} type="file" multiple style={{ display: "none" }} onChange={e => { Array.from(e.target.files).forEach(f => onAdd(f, type)); e.target.value = ""; }} />
    </div>
  );
}
```

- [ ] **Step 5: Рендер слотів + кнопка «+ слот» у step-1 JSX** (режими first і tz-review, після сітки БРИФИ/РЕФЕРЕНСИ/КРЕСЛЕННЯ)

```jsx
{(customSlots.length > 0 || true) && (
  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
    {customSlots.length > 0 && (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 12 }}>
        {customSlots.map(t => (
          <CustomSlot key={t} type={t}
            files={customFiles.files.filter(f => f._docType === t)}
            onAdd={customFiles.add}
            onRemoveFile={id => { const idx = customFiles.files.findIndex(f => f._id === id); if (idx >= 0) customFiles.remove(idx); }}
            onRemoveSlot={type => saveCustomSlots(customSlots.filter(x => x !== type))} />
        ))}
      </div>
    )}
    <div style={{ position: "relative" }}>
      <button className="vp-btn" onClick={() => setSlotMenuOpen(o => !o)}>+ слот під тип документа</button>
      {slotMenuOpen && (
        <div className="vp-panel" style={{ position: "absolute", top: "110%", left: 0, zIndex: 50, padding: 6, display: "flex", flexDirection: "column", gap: 2, minWidth: 160 }}>
          {Object.entries(DOC_TYPES).filter(([k]) => !customSlots.includes(k)).map(([k, v]) => (
            <button key={k} className="vp-btn" style={{ border: "none", textAlign: "left" }}
              onClick={() => { saveCustomSlots([...customSlots, k]); setSlotMenuOpen(false); }}>{v}</button>
          ))}
        </div>
      )}
    </div>
  </div>
)}
```

(вставляється двічі: у блок `mode === "first"` і `mode === "tz-review"`; винести в змінну `slotsJsx` перед `return` App, щоб не дублювати.)

- [ ] **Step 6: `reset()` чистить кастомні файли** — додати `customFiles.ref.current = [];` (самі слоти лишаються — це «настройка робочого місця»).

- [ ] **Step 7: Верифікація + коміт**

Run: `npx vite build && npx vitest run` → ✓ / 32 PASS.
Браузер: «+ слот» → RCP → слот з'явився, файл додається, тип видно; F5 → слот на місці.

```bash
git add src/App.jsx
git commit -m "feat(viewport): on-demand typed document slots with persistence"
```

---

### Task 3: Хедер-тулбар + ⚙-попап ключів

**Files:**
- Modify: `src/App.jsx` — хедер App, стан `settingsOpen`, ARCHIVIZER-панель (прибрати token-інпут — він у попапі).

- [ ] **Step 1: Стан + попап**

У `App`: `const [settingsOpen, setSettingsOpen] = useState(false);`
Хедер: прибрати обидва постійні інпути ключів; замість них:

```jsx
<button className="vp-btn" onClick={() => setSettingsOpen(o => !o)} title="Ключі та налаштування"
  style={{ borderColor: anthropicKey ? "var(--ok)" : "var(--warn)" }}>⚙</button>
```

Попап (одразу після кнопки, `position: relative` контейнер):

```jsx
{settingsOpen && (
  <div className="vp-panel" style={{ position: "absolute", top: "110%", right: 0, zIndex: 200, padding: 14, display: "flex", flexDirection: "column", gap: 10, width: 300 }}>
    <div className="vp-label">Anthropic API key</div>
    <input type="password" className="vp-input" value={anthropicKey} onChange={e => saveAnthropicKey(e.target.value)} placeholder="sk-ant-…" />
    <div className="vp-label">Archivizer token</div>
    <input type="password" className="vp-input" value={archivizerToken} onChange={e => saveArchivizerToken(e.target.value)} placeholder="токен" />
    <div style={{ fontSize: 9, color: "var(--dim)", fontFamily: "var(--font-mono)" }}>Зберігаються локально в браузері</div>
  </div>
)}
```

- [ ] **Step 2: Хедер-стилі** — `background: var(--panel)`, `borderBottom: 1px solid var(--line)`, лого-мітка `.vp-label` + назва `fontFamily: var(--font-ui)`, існуючі кнопки → `className="vp-btn"`.

- [ ] **Step 3: ARCHIVIZER-панель** — прибрати інпут token (лишити URL + кнопку), додати підказку «токен — у ⚙» коли `!archivizerToken`.

- [ ] **Step 4: Верифікація + коміт**

```bash
git add src/App.jsx
git commit -m "feat(viewport): toolbar header with settings popover for API keys"
```

---

### Task 4: Рестайл step-1 (дропзони, картки режимів, кнопки)

**Files:**
- Modify: `src/App.jsx` — `UploadBox`, `DwgSlot`, step-1 JSX (mode cards, QA-теги, стандарти, textarea, CTA, err).

- [ ] **Step 1: `UploadBox` і `DwgSlot` на токени**
  - Зовнішня дропзона обох: замінити інлайн `border/background` на `className={`vp-dropzone${drag ? " vp-dropzone--drag" : ""}`}` (інлайн лишає тільки layout: padding/minHeight/flex).
  - Кольори в чіпах/підписах: `#888`→`var(--dim)`, `#bbb`/`#ccc`→`var(--dim)`, `#ddd`/`#e0ddd8`→`var(--line)`, `#fafafa`/`#f0eeea`→`var(--void)`, текст `#555`/`#333`→`var(--text)`.
  - Селект «тип?» і інпут «пункт ТЗ»: фон `var(--void)`, бордер `var(--line)`, текст `var(--text)`.
  - `fontFamily: "monospace"` в межах цих компонентів → `"var(--font-mono)"`.

- [ ] **Step 2: Step-1 JSX**
  - Mode cards: `background: var(--panel)`, активна — `border: 1.5px solid var(--amber)` + `background: #20242c`, іконка без змін; текст `var(--text)`/`var(--dim)`.
  - QA-теги і стандарти: фон `var(--panel)`, бордер зліва — колір як був (семантика), текст `var(--dim)`.
  - Textarea ТЗ: `className="vp-input"` + `minHeight: 80, fontSize: 13, lineHeight: 1.7`.
  - CTA-кнопки («РОЗІБРАТИ ТЗ →», «АНАЛІЗУВАТИ…», «ПОРІВНЯТИ…»): `className="vp-btn vp-btn--primary"` + існуючий letter-spacing/padding.
  - Плашка err: `background: #2a1215, border: 1px solid var(--fail), color: var(--fail)`.
  - Банер saved session: `vp-panel`, текст токенами.
  - ARCHIVIZER-панель: `vp-panel`, лейбл `var(--info)`.
  - Роздільники `background: #ddd` → `var(--line)`.

- [ ] **Step 3: Повна верифікація Етапу 1**

Run: `npx vite build && npx vitest run && npx eslint src/App.jsx 2>&1 | grep problems`
Expected: ✓ / 32 PASS / `✖ 5 problems (4 errors, 1 warning)`.
Браузер (dev на 5174): темний екран завантаження, marching ants при drag, «+ слот», ⚙-попап, режими перемикаються, TZ-review і revision-екрани не зламані (вони частково світлі — ок до Етапу 2/3).

- [ ] **Step 4: Коміт**

```bash
git add src/App.jsx
git commit -m "feat(viewport): restyle upload screen to dark viewport system"
```

---

## Self-Review (виконано)

- **Spec coverage:** токени/шрифти/фон (T1), слоти за запитом + persistence + вливання в аналіз (T2), хедер/⚙ (T3), дропзони marching ants + рестайл (T4). DetailPage/Grid/TZ — Етапи 2–3 за спекою.
- **Placeholder scan:** чисто; таблиці замін кольорів — конкретні пари.
- **Type consistency:** `add(file, forcedType)` (T2 S1) ↔ `onAdd={customFiles.add}` + виклик `onAdd(f, type)` у CustomSlot (T2 S4); `saveCustomSlots`/`customSlots` консистентні.
