import { describe, it, expect } from "vitest";
import { SVERKA_CHECKS, DOC_TYPES, docTypeFromName, activeSverka, sverkaRows, sverkaPromptBlock, sverkaSinglePrompt, SVERKA_STATUS } from "./sverka.js";

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
    ["landscape plan.pdf", "landscape"],
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
  it("AI-вердикт оживляє пункт без живих файлів (відновлена сесія)", () => {
    const rows = sverkaRows([{ id: "S7", status: "ok", note: "по плану" }], {}, checks);
    expect(rows.find(x => x.id === "S7")).toMatchObject({ status: "ok", active: true });
  });
  it("неактивний пункт з AI no_material лишається no_material", () => {
    const rows = sverkaRows([{ id: "S7", status: "no_material" }], {}, checks);
    expect(rows.find(x => x.id === "S7")).toMatchObject({ status: "no_material", active: false });
  });
  it("активний пункт без відповіді AI → unchecked; без sverka взагалі — теж", () => {
    expect(sverkaRows([], {}, checks).find(x => x.id === "S2").status).toBe("unchecked");
    expect(sverkaRows(undefined, undefined, checks).find(x => x.id === "S10").status).toBe("unchecked");
  });
  it("завжди 13 рядків у порядку реєстру, needs прокидається", () => {
    const rows = sverkaRows([], {}, checks);
    expect(rows.map(r => r.id)).toEqual(SVERKA_CHECKS.map(c => c.id));
    expect(rows[0].needs).toEqual(SVERKA_CHECKS[0].needs);
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

describe("sverkaSinglePrompt", () => {
  const check = SVERKA_CHECKS.find(c => c.id === "S10");
  it("містить id, label пункта, doc-мітку і zone-правила", () => {
    const p = sverkaSinglePrompt(check, "RCP · RCP_final.pdf", "стеля 2 рівні", "ZONE-RULES-HERE");
    expect(p).toContain("S10");
    expect(p).toContain("RCP план");
    expect(p).toContain("RCP · RCP_final.pdf");
    expect(p).toContain("ZONE-RULES-HERE");
    expect(p).toContain("стеля 2 рівні");
  });
  it("вимагає один JSON-обʼєкт зі status і zone", () => {
    const p = sverkaSinglePrompt(check, "", "", "");
    expect(p).toMatch(/"status"\s*:/);
    expect(p).toMatch(/"zone"\s*:/);
  });
  it("без документа і ТЗ не падає", () => {
    expect(() => sverkaSinglePrompt(check, "", "", "")).not.toThrow();
    expect(typeof sverkaSinglePrompt(check, "", "", "")).toBe("string");
  });
});

describe("SVERKA_STATUS", () => {
  it("має конфіг для всіх п'яти статусів", () => {
    for (const s of ["ok", "warn", "fail", "no_material", "unchecked"])
      expect(SVERKA_STATUS[s]).toMatchObject({ icon: expect.any(String), color: expect.any(String), label: expect.any(String) });
  });
});
