# Лабораторія Cross-Check — тест-стенд одного пункту

**Дата:** 2026-07-16
**Статус:** затверджено Димою (один пункт за раз · окремий роут /lab · вердикт + зона + JSON). Макет — `public/lab-mock.html`.

## Проблема

Щоб калібрувати промпти Cross-Check, потрібно ганяти кожну з 13 перевірок ізольовано: один рендер + один документ + один пункт → бачити вердикт, влучання в зону і цілість JSON. У повному флоу це неможливо (усе разом, дорого, не видно, який саме пункт мажет).

## Розташування

- Новий стан у `App`: `view: "app" | "lab"` (окремо від `step`/`mode`).
- Перемикач у хедері — сегментед-контрол `Перевірка · Лабораторія` між брендом і кнопкою ⚙.
- `view === "lab"` рендерить `<LabPage>` замість усього step-1/step-2 блоку. Хедер (лого, перемикач, ⚙-попап ключів) спільний.
- Ключ Anthropic — той самий `anthropicKey` зі стану App, передається пропом.

## Рушій — `sverkaSinglePrompt` у `src/sverka.js`

Нова чиста функція (тестована vitest):

```
sverkaSinglePrompt(check, docLabel, tzText) → string
```

- `check` — елемент `SVERKA_CHECKS` (`{id, label, needs}`).
- `docLabel` — мітка документа (напр. `"RCP · RCP_final.pdf"`) або `""`.
- `tzText` — опційний контекст ТЗ.
- Повертає промпт: роль QA, звірити **тільки** `check.id`/`check.label` проти рендера й документа, повернути один JSON-обʼєкт `{"id","status":"ok|warn|fail|no_material","note","doc_ref","zone"}`. Містить `ZONE_PROMPT`-правила координат (передаються параметром, щоб не тягнути з App — див. план) і вимогу zone для warn/fail.

## Компонент `LabPage`

**Стан (локальний):** `render = useFileList("lab-render")`, `doc = useFileList("lab-doc")`, `checkId` (default `"S1"`), `tzText`, `running`, `result` (`{status,note,zone,doc_ref,_raw,_ms}` | `{error}`), `rawOpen`.

**Ліва колонка:**
- Дропзона рендера (hero-стиль, як на головній; приймає лише зображення/PDF, бере перший).
- Дропзона документа — один файл будь-якого підтримуваного типу; авто-тег `_docType` через `docTypeFromName` показується бейджем; тип можна змінити селектом (перевикористати патерн).
- Дропдаун «Що перевіряємо» — 13 пунктів `SVERKA_CHECKS` (код + label).
- Textarea «ТЗ-контекст (опційно)».
- Кнопка «Перевірити пункт →» (disabled поки немає рендера або йде запит).

**Виклик:**
1. `parts = [{type:text, text: sverkaSinglePrompt(check, docLabel, tzText)}]`
2. `parts.push(...filesToParts([renderFile], "РЕНДЕР"))`
3. `parts.push(...filesToParts([docFile], "ДОКУМЕНТ"))` (якщо є документ)
4. `t0 = performance.now(); p = await callAPI(parts, 1, anthropicKey)`
5. Claude може повернути або обʼєкт, або `{sverka:[...]}` — беремо `p.sverka?.[0] || p`. Прогнати `zone` через `normalizeZone`.
6. `result = {...obj, _ms: Math.round(performance.now()-t0), _raw: p}`.

**Права колонка (коли є result):**
- Вердикт-картка: іконка `SVERKA_STATUS[status]`, `check.id · check.label`, підрядок «звірено з <doc> · N.N c», пігулка статусу. Рамка/фон tint по статусу (fail — червоний).
- Note-блок: `result.note`.
- Рендер із зоною: перевикористати `AnnotatedImage` з одним ann `{...result, _src:"sverka", _srcIdx:0, _label:check.id.slice(1), zone}`; caption із координатами.
- Розгортка «сирий JSON»: `JSON.stringify(result._raw, null, 2)`, заголовок з `_ms`.
- Помилка: якщо `result.error` — червона плашка з текстом (той самий стиль, що apiError).

## Обмеження

- Логіка аналізу основного флоу не змінюється. `filesToParts`, `callAPI`, `normalizeZone`, `AnnotatedImage`, `SVERKA_CHECKS`, `SVERKA_STATUS`, `docTypeFromName`, `DOC_TYPES` — перевикористовуються.
- `ZONE_PROMPT` живе в App.jsx як const; `sverkaSinglePrompt` приймає його текст параметром `zoneRules` (щоб sverka.js лишався без залежності від App і тестувався). App передає `ZONE_PROMPT`.
- Модель/ретраї — ті самі, що в callAPI (Sonnet). Один пункт — retries=1.
- Стиль — Zinc Studio+ (calm), класи з `theme.css` + інлайн-токени.
- `npx vitest run` зелений (нові тести на `sverkaSinglePrompt`), `npx vite build` проходить, eslint без нових помилок.

## Верифікація

- Тести: `sverkaSinglePrompt` містить id/label пункта, doc-мітку, zoneRules, вимогу JSON-обʼєкта; при порожньому docLabel не падає.
- Ручна: перемикач у хедері → Лабораторія; завантажити рендер + RCP, обрати S10, «Перевірити» → зʼявляється вердикт, зона на рендері, JSON. Перемикання назад на «Перевірка» зберігає основний флоу.

## Поза скоупом

- A/B порівняння промптів, збереження історії прогонів, батч по всіх 13 пунктах (можливі ітерації 2+).
- Зміна основного Cross-Check промпту чи схеми.
