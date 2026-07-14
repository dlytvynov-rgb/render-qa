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
