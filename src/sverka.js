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
export function sverkaSinglePrompt(check, docLabel, tzText, zoneRules) {
  const doc = docLabel
    ? `Документ для звірки: ${docLabel} (позначений як "ДОКУМЕНТ" нижче).`
    : `Документ не наданий — оціни пункт лише за рендером; якщо без документа перевірити неможливо, постав status "no_material".`;
  const tz = (tzText || "").trim() ? `\n\nКОНТЕКСТ ТЗ:\n${tzText.trim()}` : "";
  return `Ти — старший QA-спеціаліст 3D-візуалізації. Перевір РІВНО ОДИН пункт студійного чеклиста.

ПУНКТ ${check.id}: ${check.label}
${doc}${tz}

${zoneRules || ""}

Звір рендер із документом саме по цьому пункту. Не оцінюй нічого іншого.

ВІДПОВІДАЙ ТІЛЬКИ ОДНИМ JSON-обʼєктом:
{"id":"${check.id}","status":"ok"|"warn"|"fail"|"no_material","note":"що звірено і з чим, одне-два речення","doc_ref":"назва файлу-джерела або пусто","zone":{"x":0,"y":0,"w":0,"h":0}}

- status: ok = відповідає, warn = дрібне зауваження, fail = не відповідає, no_material = нема чим перевірити.
- zone ОБОВʼЯЗКОВА для warn/fail — де саме на рендері проблема (відсотки 0–100). Для ok/no_material можна null.`;
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
