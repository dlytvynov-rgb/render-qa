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
