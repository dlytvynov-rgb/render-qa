// Cross-Check — студійний чеклист перевірки аутпута по типах документів.
// Пункт активний, якщо серед файлів є документ з типом із needs;
// порожній needs = активний завжди.
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

// Мержить AI-відповідь з override-ами ПМ у 13 рядків для UI/PDF.
// AI-статус з реальним вердиктом «оживляє» пункт навіть якщо файлів зараз
// немає (відновлена сесія) — активність на момент аналізу вже зафіксована у відповіді.
export function sverkaRows(aiSverka, overrides, activeChecks) {
  const byId = {};
  (aiSverka || []).forEach(x => { if (x && x.id) byId[x.id] = x; });
  return activeChecks.map(c => {
    const ai = byId[c.id];
    const ov = overrides ? overrides[c.id] : undefined;
    const active = c.active || (!!ai && !!ai.status && ai.status !== "no_material");
    const status = !active ? "no_material" : (ov || ai?.status || "unchecked");
    return {
      id: c.id, label: c.label, needs: c.needs, active, status,
      note: ai?.note || "", doc_ref: ai?.doc_ref || "", zone: ai?.zone || null,
      overridden: !!ov,
    };
  });
}

// Фокусний промпт для тест-стенду: звірити ОДИН пункт проти рендера + документа.
// Правило проти галюцинацій і хибного відкидання входів (референси/приклади = еталон, а не «зайве»).
const INPUT_RULE = `ПРАВИЛО ПРО ВХІДНІ ДАНІ (обовʼязкове):
• Усі надані зображення й матеріали стосуються ЦЬОГО завдання. НЕ відкидай нічого як «не пов'язане з картинкою» і не вирішуй сам, що щось тут зайве чи «не про те».
• Якщо зображення виглядає як референс/приклад — це ЕТАЛОН того, що клієнт хоче бачити (напр. приклади наповнення полиць, предметів, стилю, матеріалів). Це ЦІЛЬ для звірки, а не сторонній матеріал.
• Спирайся ТІЛЬКИ на те, що реально видно на наданих матеріалах. НЕ вигадуй, НЕ додумуй і НЕ припускай того, чого немає. Якщо деталь не видно — пиши «не видно / не можу підтвердити», а НЕ «не стосується».`;

// Як читати референси/приклади: це джерело конкретних елементів, а не сцена для повного копіювання.
const REFERENCE_RULE = `ПРАВИЛО ПРО РЕФЕРЕНСИ (приклади від клієнта):
1. Референс = ДЖЕРЕЛО конкретних бажаних елементів, а НЕ сцена для повного копіювання. На референсі майже завжди є зайве/фонове (інші меблі, декор, люди, рушники, стіни, освітлення кімнати) — це НЕ вимога. Не карай рендер за розбіжність із тим, чого клієнт не просив.
2. Визнач, ЩО САМЕ взяти з референсу — зі супровідної вимоги / ту-ду / розмітки клієнта (напр. «умивальник як на референсі», «колір плитки з прикладу»). Порівнюй ТІЛЬКИ цей елемент/атрибут.
3. Осі, по яких елемент береться (перебери всі, щоб нічого не проґавити): об'єкт/меблі (умивальник, змішувач, дзеркало, світильник, декор); матеріал/оздоблення (мармур, дерево, латунь, тканина); колір/палітра; текстура/патерн; форма/силует/пропорції; стиль/настрій; розкладка/наповнення (що саме на полицях); дрібна деталь (ручка, кромка, профіль, фурнітура).
4. Оцінюй по-атрибутно й розрізняй збіг: правильний об'єкт, але інший колір = частково; правильний матеріал, але інша форма = частково.
5. Якщо не ясно, який елемент брати — назви найімовірніші кандидати й познач невизначеність, а НЕ вирішуй що референс «не стосується» і НЕ припускай, що треба скопіювати всю сцену.`;

export function sverkaSinglePrompt(check, docLabel, tzText, zoneRules) {
  const doc = docLabel
    ? `Документ для звірки: ${docLabel} (позначений як "ДОКУМЕНТ" нижче).`
    : `Документ не наданий — оціни пункт лише за рендером; якщо без документа перевірити неможливо, постав status "no_material".`;
  const tz = (tzText || "").trim() ? `\n\nКОНТЕКСТ ТЗ:\n${tzText.trim()}` : "";
  return `Ти — старший QA-спеціаліст 3D-візуалізації. Перевір РІВНО ОДИН пункт студійного чеклиста.

ПУНКТ ${check.id}: ${check.label}
${doc}${tz}

${INPUT_RULE}

${REFERENCE_RULE}

${zoneRules || ""}

Звір рендер із документом саме по цьому пункту. Не оцінюй нічого іншого.

ВІДПОВІДАЙ ТІЛЬКИ ОДНИМ JSON-обʼєктом:
{"id":"${check.id}","status":"ok"|"warn"|"fail"|"no_material","note":"що звірено і з чим, одне-два речення","doc_ref":"назва файлу-джерела або пусто","zone":{"x":0,"y":0,"w":0,"h":0}}

- status: ok = відповідає, warn = дрібне зауваження, fail = не відповідає, no_material = нема чим перевірити.
- zone ОБОВʼЯЗКОВА для warn/fail — де саме на рендері проблема (відсотки 0–100). Для ok/no_material можна null.`;
}

// Пункти, що вимагають порівняння ДО/ПІСЛЯ (два рендери) замість одного.
export const SVERKA_COMPARE_IDS = ["S13"];
export function sverkaIsComparison(checkId) {
  return SVERKA_COMPARE_IDS.includes(checkId);
}

// Фокусний промпт для порівняння ДО/ПІСЛЯ проти списку правок (напр. Ту-ду лист S13).
// changeList — текстовий список; hasVisual — чи додано зображення візуального ту-ду (розмітка клієнта).
export function sverkaSingleComparePrompt(check, changeList, zoneRules, hasVisual) {
  const hasText = (changeList || "").trim();
  const sources = [];
  if (hasVisual) sources.push(`• ВІЗУАЛЬНИЙ ТУ-ДУ (зображення після «РЕНДЕР ПІСЛЯ») — це розмітка клієнта: стрілки, обведення, підписи, коментарі. КОЖНА позначка = окрема вимога-правка. Прочитай їх усі, зокрема дрібний текст.`);
  if (hasText) sources.push(`• СПИСОК ЗМІН (текст):\n${changeList.trim()}`);
  const src = sources.length
    ? `ДЖЕРЕЛА ПРАВОК (об'єднай усі, без дублів):\n${sources.join("\n")}`
    : `Список змін не наданий — порівняй ДО і ПІСЛЯ візуально і знайди всі відмінності.`;
  return `Ти — старший QA-спеціаліст 3D-візуалізації. Перевіряєш пункт ${check.id}: ${check.label} — ПОРІВНЯННЯМ рендерів.

Зображення 1 = РЕНДЕР ДО (до правок).
Зображення 2 = РЕНДЕР ПІСЛЯ (після правок).${hasVisual ? "\nНаступні зображення = ВІЗУАЛЬНИЙ ТУ-ДУ (розмітка/коментарі клієнта)." : ""}

${src}

${INPUT_RULE}

${REFERENCE_RULE}

${zoneRules || ""}

По КОЖНІЙ правці з усіх джерел звір ПІСЛЯ проти ДО і визнач: застосована / застосована частково / не застосована / стало гірше (регресія). Не оцінюй нічого поза цими правками.

ВІДПОВІДАЙ ТІЛЬКИ ОДНИМ JSON-обʼєктом:
{"id":"${check.id}","status":"ok"|"warn"|"fail","note":"стисло по кожній правці — що зроблено/не зроблено","zone":{"x":0,"y":0,"w":0,"h":0},"changes":[{"text":"текст правки","done":"yes"|"partial"|"no"|"regressed","zone":{"x":0,"y":0,"w":0,"h":0},"conf":0}]}

- status: ok = всі правки застосовані; warn = частково; fail = ключові не застосовані або регресія.
- zone (верхнього рівня) — на ПІСЛЯ, де найважливіша проблемна правка (для warn/fail). Для ok можна null.
- У КОЖНІЙ правці: "zone" — де саме на ПІСЛЯ ця правка (відсотки 0–100, якнайточніше — це потрібно для зум-перевірки); "conf" — наскільки впевнений у вердикті done (0–100).`;
}

// Фокусна зум-перевірка ОДНІЄЇ правки на збільшених кропах ДО/ПІСЛЯ
export function sverkaZoomComparePrompt(check, changeText, hasVisual) {
  return `Ти — старший QA-спеціаліст 3D-візуалізації. Це УТОЧНЮВАЛЬНА зум-перевірка ОДНІЄЇ правки пункту ${check.id}.

Тобі дано ЗБІЛЬШЕНІ (кропнуті) ділянки того самого місця:
Зображення 1 = ДО (кроп цієї зони).
Зображення 2 = ПІСЛЯ (кроп цієї зони).${hasVisual ? "\nНаступне зображення = кроп ВІЗУАЛЬНОГО ТУ-ДУ (розмітка клієнта) цієї зони, якщо надано." : ""}

ПРАВКА, яку перевіряємо: «${(changeText || "").trim()}»

Дивись ДУЖЕ уважно на дрібні деталі: шви й затирку плитки (grout), фактуру матеріалів, кольори, металеві вставки, форму, дрібний текст. Це збільшений кроп — ти бачиш те, що на повному кадрі непомітно. Визнач, чи САМЕ ЦЯ правка застосована на ПІСЛЯ порівняно з ДО.

${INPUT_RULE}

${REFERENCE_RULE}

ВІДПОВІДАЙ ТІЛЬКИ ОДНИМ JSON-обʼєктом:
{"done":"yes"|"partial"|"no"|"regressed","conf":0,"note":"що саме бачиш на кропі, одне речення"}`;
}

export function sverkaPromptBlock(activeChecks, taggedFiles) {
  const files = taggedFiles || [];
  const act = activeChecks.filter(c => c.active);
  const inact = activeChecks.filter(c => !c.active);
  const lines = act.map(c => {
    const docs = files.filter(f => c.needs.includes(f.docType)).map(f => f.label);
    return `${c.id} ${c.label}${docs.length ? ` → ${docs.join(", ")}` : ""}`;
  });
  return `── CROSS-CHECK (студійний чеклист) ──
Перевір КОЖЕН активний пункт по відповідному документу:
${lines.join("\n")}
${inact.length ? `Неактивні пункти — постав status "no_material": ${inact.map(c => c.id).join(", ")}` : ""}
- Заповни масив "sverka": {"id","status":"ok"|"warn"|"fail"|"no_material","note","doc_ref","zone"}
- note: що звірено і з чим, одне-два речення. doc_ref: назва файлу-джерела.
- zone ОБОВ'ЯЗКОВА для warn/fail — де саме на рендері проблема.`;
}
