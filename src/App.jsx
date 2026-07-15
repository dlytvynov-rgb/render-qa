import { useState, useRef, useEffect, useCallback } from "react";
import { DOC_TYPES, SVERKA_STATUS, docTypeFromName, activeSverka, sverkaRows, sverkaPromptBlock } from "./sverka.js";

// ─── SheetJS ──────────────────────────────────────────────────────────────────
async function loadXLSX() {
  if (window.XLSX) return window.XLSX;
  await new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    s.onload = res; s.onerror = rej; document.head.appendChild(s);
  });
  return window.XLSX;
}
async function excelToText(file) {
  const XLSX = await loadXLSX();
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
  const lines = [];
  wb.SheetNames.forEach(name => {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { skipHidden: true });
    if (csv.replace(/,/g, "").trim()) { lines.push(`=== ${name} ===`); lines.push(csv.slice(0, 6000)); }
  });
  return lines.join("\n");
}

// ─── PDF.js ───────────────────────────────────────────────────────────────────
async function loadPdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  await new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    s.onload = res; s.onerror = rej; document.head.appendChild(s);
  });
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  return window.pdfjsLib;
}
async function pdfToPages(file, onProg, sig) {
  const lib = await loadPdfJs();
  const buf = await file.arrayBuffer();
  if (sig?.aborted) throw new DOMException("Aborted", "AbortError");
  const pdf = await lib.getDocument({ data: new Uint8Array(buf) }).promise;
  const n = pdf.numPages, mb = file.size / 1048576;
  let sc = 1.2, q = 0.72;
  if (n > 4 || mb > 10) { sc = 1.0; q = 0.62; }
  if (n > 8 || mb > 20) { sc = 0.8; q = 0.55; }
  const pages = [];
  for (let i = 1; i <= n; i++) {
    if (sig?.aborted) throw new DOMException("Aborted", "AbortError");
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: sc });
    const canvas = document.createElement("canvas");
    canvas.width = Math.min(vp.width, 1024); canvas.height = Math.min(vp.height, 1024);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    let b64 = canvas.toDataURL("image/jpeg", q).split(",")[1], qq = q;
    while (b64.length * 0.75 > 3.5e6 && qq > 0.3) { qq -= 0.08; b64 = canvas.toDataURL("image/jpeg", qq).split(",")[1]; }
    // Extract text layer per page — annotations/labels that reference visual elements on this page
    let pageText = null;
    try {
      const tc = await page.getTextContent();
      const raw = tc.items.map(it => it.str || "").join(" ").replace(/\s{3,}/g, "  ").trim();
      if (raw.length > 10) pageText = raw.slice(0, 4000);
    } catch { /* ignore */ }
    pages.push({ b64, preview: canvas.toDataURL("image/jpeg", Math.min(qq, 0.75)), text: pageText });
    onProg?.(Math.round(i / n * 100));
  }
  return { pages, type: "pdf", filename: file.name };
}
async function imageToB64(file, onProg, sig) {
  return new Promise((res, rej) => {
    if (sig?.aborted) { rej(new DOMException("Aborted", "AbortError")); return; }
    sig?.addEventListener("abort", () => rej(new DOMException("Aborted", "AbortError")), { once: true });
    const reader = new FileReader();
    reader.onerror = () => rej(new Error("read"));
    reader.onload = e => {
      const img = new Image();
      img.onerror = () => rej(new Error("decode"));
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          let { width: w, height: h } = img; const max = 1024;
          if (w > max || h > max) { const r = Math.min(max / w, max / h); w = Math.round(w * r); h = Math.round(h * r); }
          canvas.width = w; canvas.height = h;
          canvas.getContext("2d").drawImage(img, 0, 0, w, h);
          let qq = 0.72, b64 = canvas.toDataURL("image/jpeg", qq).split(",")[1];
          while (b64.length * 0.75 > 2.5e6 && qq > 0.3) { qq -= 0.1; b64 = canvas.toDataURL("image/jpeg", qq).split(",")[1]; }
          const preview = canvas.toDataURL("image/jpeg", 0.75);
          onProg?.(100);
          res({ b64, preview, type: "image", filename: file.name, pages: [{ b64, preview }] });
        } catch (err) { rej(err); }
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}
// ─── DWG binary string extractor (no API needed) ─────────────────────────────
async function parseDWGBinary(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);

  // Версія файлу (перші 6 байт — ASCII)
  const version = String.fromCharCode(...bytes.slice(0, 6));
  const versionMap = {
    "AC1006": "R10", "AC1009": "R11/R12", "AC1012": "R13",
    "AC1014": "R14", "AC1015": "2000", "AC1018": "2004",
    "AC1021": "2007", "AC1024": "2010", "AC1027": "2013",
    "AC1032": "2018", "AC1037": "2021", "AC1043": "2025",
  };
  const ver = versionMap[version] || version;

  // Витягуємо ASCII рядки (мін 3 символи, друковані символи)
  const asciiStrings = [];
  let run = "";
  for (let i = 6; i < bytes.length; i++) {
    const c = bytes[i];
    if (c >= 32 && c <= 126) {
      run += String.fromCharCode(c);
    } else {
      if (run.length >= 3) asciiStrings.push(run.trim());
      run = "";
    }
  }
  if (run.length >= 3) asciiStrings.push(run.trim());

  // Витягуємо UTF-16LE рядки (AutoCAD 2007+ зберігає текст як UTF-16)
  const utf16Strings = [];
  for (let i = 0; i < bytes.length - 4; i++) {
    // Шукаємо UTF-16LE послідовності: буква\0 буква\0 ...
    if (bytes[i] >= 32 && bytes[i] <= 126 && bytes[i+1] === 0 &&
        bytes[i+2] >= 32 && bytes[i+2] <= 126 && bytes[i+3] === 0) {
      let s = "";
      let j = i;
      while (j < bytes.length - 1 && bytes[j+1] === 0 && bytes[j] >= 32 && bytes[j] <= 126) {
        s += String.fromCharCode(bytes[j]);
        j += 2;
      }
      if (s.length >= 3) { utf16Strings.push(s.trim()); i = j - 1; }
    }
  }

  // Фільтруємо корисні рядки
  const allStrings = [...new Set([...asciiStrings, ...utf16Strings])];

  // Видаляємо технічний сміт — залишаємо тільки осмислені рядки
  const isUseful = s => {
    if (s.length < 2) return false;
    // Фільтр: тільки рядки з літерами (не просто цифри/символи)
    if (!/[a-zA-Zа-яА-ЯіІїЇєЄ]/.test(s) && !/^\d+([.,]\d+)?$/.test(s)) return false;
    // Видаляємо типові бінарні артефакти
    if (/^[A-F0-9]{8,}$/.test(s)) return false; // hex dump
    if (s.split("").every(c => c === s[0])) return false; // повтор одного символу
    return true;
  };

  const useful = allStrings.filter(isUseful);

  // Класифікація рядків
  const layers = useful.filter(s =>
    /^[A-Z0-9_-]+$/.test(s) && s.length <= 30 && !s.includes(" ")
  ).slice(0, 40);

  const dims = useful.filter(s =>
    /^\d{2,5}([.,]\d{1,3})?$/.test(s) && parseFloat(s) > 10 && parseFloat(s) < 99999
  ).slice(0, 50);

  const texts = useful.filter(s =>
    s.length >= 3 && s.length <= 200 &&
    !layers.includes(s) && !dims.includes(s) &&
    /[a-zA-Zа-яА-ЯіІїЇєЄ]/.test(s)
  ).slice(0, 100);

  // Формуємо звіт
  let out = `=== DWG ФАЙЛ: ${file.name} ===\n`;
  out += `Версія AutoCAD: ${ver}\n`;
  out += `Розмір файлу: ${(file.size / 1024).toFixed(0)} KB\n`;
  out += `Знайдено рядків: ${useful.length}\n\n`;

  if (layers.length) out += `ШАРИ/БЛОКИ (${layers.length}):\n${layers.map(l => "  • " + l).join("\n")}\n\n`;
  if (dims.length) out += `РОЗМІРИ (мм/одиниці, ${dims.length}):\n  ${dims.join(", ")}\n\n`;
  if (texts.length) out += `ТЕКСТОВІ ПІДПИСИ (${texts.length}):\n${texts.map(t => "  • " + t).join("\n")}\n`;

  if (useful.length < 5) {
    out += "\n⚠️ Мало тексту витягнуто. Можливо зашифрований або пошкоджений файл.\n";
    out += "Рекомендація: збережіть як DXF з AutoCAD для кращого читання.\n";
  }

  return out;
}
function parseDXF(text) {
  const lines = text.split(/\r?\n/);
  const sections = { texts: [], dimensions: [], layers: new Set(), entities: [] };
  let i = 0;
  while (i < lines.length - 1) {
    const code = parseInt((lines[i] || "").trim(), 10);
    const val = (lines[i + 1] || "").trim();
    i += 2;
    if (isNaN(code)) continue;
    if (code === 8) sections.layers.add(val);
    if (code === 1 && val && !val.startsWith("{") && val.length > 1) sections.texts.push(val);
    if (code === 3 && val && val.length > 2) sections.texts.push(val);
    if (code === 42 && parseFloat(val) > 0) sections.dimensions.push(parseFloat(val).toFixed(0));
    if (code === 0 && ["LINE","ARC","CIRCLE","LWPOLYLINE","POLYLINE","SPLINE","INSERT","DIMENSION","TEXT","MTEXT","HATCH"].includes(val)) {
      sections.entities.push(val);
    }
  }
  const entityCounts = {};
  sections.entities.forEach(e => { entityCounts[e] = (entityCounts[e] || 0) + 1; });
  const uniqueTexts = [...new Set(sections.texts)].filter(t => t.trim().length > 0).slice(0, 120);
  const uniqueDims = [...new Set(sections.dimensions)].slice(0, 60);
  const layers = [...sections.layers].filter(l => l && l !== "0").slice(0, 40);
  let out = "=== DXF КРЕСЛЕННЯ ===\n";
  if (layers.length) out += "ШАРИ (" + layers.length + "): " + layers.join(", ") + "\n";
  if (Object.keys(entityCounts).length) out += "ЕЛЕМЕНТИ: " + Object.entries(entityCounts).map(function(e) { return e[0] + "x" + e[1]; }).join(", ") + "\n";
  if (uniqueDims.length) out += "РОЗМІРИ (мм): " + uniqueDims.join(", ") + "\n";
  if (uniqueTexts.length) out += "ПІДПИСИ:\n" + uniqueTexts.map(function(t) { return "  • " + t; }).join("\n") + "\n";
  return out || "[DXF порожній]";
}

async function processFile(file, onProg, sig) {
  if (!file) return null;
  const nm = file.name.toLowerCase();
  if (nm.endsWith(".dxf")) {
    onProg?.(30);
    try {
      const text = await file.text();
      onProg?.(80);
      const parsed = parseDXF(text);
      onProg?.(100);
      return { pages: [], type: "dxf", filename: file.name, ext: "DXF", textContent: parsed };
    } catch { onProg?.(100); return { pages: [], type: "dxf", filename: file.name, ext: "DXF", textContent: "[помилка читання DXF]" }; }
  }
  if (nm.endsWith(".dwg")) {
    onProg?.(20);
    try {
      const parsed = await parseDWGBinary(file);
      onProg?.(100);
      return { pages: [], type: "dwg", filename: file.name, ext: "DWG", textContent: parsed, _file: file };
    } catch {
      onProg?.(100);
      return { pages: [], type: "dwg", filename: file.name, ext: "DWG", textContent: "[помилка читання DWG]", _file: file };
    }
  }
  if (nm.endsWith(".xlsx") || nm.endsWith(".xls") || nm.endsWith(".csv")) {
    onProg?.(30);
    try {
      const text = nm.endsWith(".csv") ? await file.text() : await excelToText(file);
      onProg?.(100);
      return { pages: [], type: "excel", filename: file.name, ext: nm.endsWith(".csv") ? "CSV" : "XLSX", textContent: text.slice(0, 12000) };
    } catch { onProg?.(100); return { pages: [], type: "excel", filename: file.name, ext: "XLSX", textContent: "[помилка читання]" }; }
  }
  // RTF — strip control codes before passing to Claude
  if (nm.endsWith(".rtf")) {
    onProg?.(30);
    try {
      const raw = await file.text();
      const text = raw
        .replace(/\{\*\\[^{}]*\}/g, "")          // remove extended control groups {\* ...}
        .replace(/\\bin\d+ ?/g, "")               // remove binary blobs
        .replace(/\\'[0-9a-fA-F]{2}/g, "")        // remove hex-encoded chars
        .replace(/\\[a-z]+[-]?\d* ?/g, "")        // remove control words like \rtf1 \ansi \pard
        .replace(/[{}\\]/g, "")                    // remove remaining braces and backslashes
        .replace(/\r?\n{3,}/g, "\n\n")             // collapse excessive blank lines
        .trim();
      onProg?.(100);
      return { pages: [], type: "text", filename: file.name, ext: "RTF", textContent: (text || "[RTF порожній або не читається]").slice(0, 12000) };
    } catch { onProg?.(100); return { pages: [], type: "text", filename: file.name, ext: "RTF", textContent: "[помилка читання RTF]" }; }
  }
  // TXT/MD/text reading
  if (nm.endsWith(".txt") || nm.endsWith(".md")) {
    onProg?.(30);
    try {
      const text = await file.text();
      onProg?.(100);
      return { pages: [], type: "text", filename: file.name, ext: nm.split(".").pop().toUpperCase(), textContent: text.slice(0, 12000) };
    } catch { onProg?.(100); return { pages: [], type: "text", filename: file.name, ext: "TXT", textContent: "[помилка читання]" }; }
  }
  // DOCX via mammoth
  if (nm.endsWith(".docx") || nm.endsWith(".doc")) {
    onProg?.(20);
    try {
      if (!window.mammoth) {
        await new Promise((res, rej) => {
          const s = document.createElement("script");
          s.src = "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js";
          s.onload = res; s.onerror = rej; document.head.appendChild(s);
        });
      }
      onProg?.(50);
      const buf = await file.arrayBuffer();
      const result = await window.mammoth.extractRawText({ arrayBuffer: buf });
      onProg?.(100);
      return { pages: [], type: "text", filename: file.name, ext: "DOCX", textContent: result.value.slice(0, 12000) };
    } catch { onProg?.(100); return { pages: [], type: "other", filename: file.name, ext: "DOCX", textContent: "[не вдалось прочитати DOCX]" }; }
  }
  if (nm.endsWith(".pdf")) return pdfToPages(file, onProg, sig);
  if (file.type.startsWith("image/")) return imageToB64(file, onProg, sig);
  onProg?.(100);
  return { pages: [], type: "other", filename: file.name, ext: file.name.split(".").pop().toUpperCase() };
}

// ─── File list hook ───────────────────────────────────────────────────────────
function useFileList(zoneKey) {
  const ref = useRef([]);
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick(t => t + 1), []);
  const add = useCallback(async (file) => {
    const id = "f" + Date.now() + "_" + Math.random().toString(36).slice(2);
    const ctrl = new AbortController();
    const docType = docTypeFromName(file.name, zoneKey);
    ref.current = [...ref.current, { _id: id, _loading: true, _progress: 0, _ctrl: ctrl, _docType: docType, filename: file.name, preview: null, pages: [], type: null }];
    bump();
    try {
      // Copy file data into memory immediately to release the OS file handle on Windows
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
  const remove = useCallback((idx) => { ref.current = ref.current.filter((_, i) => i !== idx); bump(); }, [bump]);
  const addDone = useCallback((fileObj) => {
    const id = "f" + Date.now() + "_" + Math.random().toString(36).slice(2);
    ref.current = [...ref.current, { ...fileObj, _id: id }];
    bump();
  }, [bump]);
  const updateTag = useCallback((id, tag) => {
    ref.current = ref.current.map(x => x._id === id ? { ...x, _tag: tag } : x);
    bump();
  }, [bump]);
  const updateDocType = useCallback((id, docType) => {
    ref.current = ref.current.map(x => x._id === id ? { ...x, _docType: docType || null } : x);
    bump();
  }, [bump]);
  return { files: ref.current, ref, add, remove, addDone, updateTag, updateDocType };
}

let _dragging = null; // { file: processedFileObj, remove: fn }

// ─── API ──────────────────────────────────────────────────────────────────────
function filesToParts(files, label) {
  const parts = [];
  (files || []).forEach((f, fi) => {
    const tagNote = f._tag ? ` [Референс до пункту ТЗ: "${f._tag}"]` : "";
    if ((f.type === "excel" || f.type === "dxf" || f.type === "dwg" || f.type === "text") && f.textContent) {
      parts.push({ type: "text", text: `${label} ${fi + 1}${tagNote} [${f.ext || "TEXT"}: ${f.filename}]:\n${f.textContent}` });
    } else {
      // For each page: send text annotations first (if any), then the image.
      // This lets Claude correlate "ця текстура на підлогу →" with the adjacent visual.
      (f.pages || []).filter(p => p.b64).forEach((pg, pi) => {
        const pageLabel = `${label} ${fi + 1}${pi > 0 ? ` стор.${pi + 1}` : ""}${pi === 0 ? tagNote : ""}`;
        if (pg.text) {
          parts.push({ type: "text", text: `${pageLabel} — підписи та анотації на сторінці:\n${pg.text}` });
        }
        parts.push({ type: "text", text: `${pageLabel}:` });
        parts.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: pg.b64 } });
      });
    }
  });
  return parts;
}
function normalizeZone(z) {
  if (!z || typeof z !== "object") return z;
  const fix = v => {
    const n = parseFloat(v);
    if (isNaN(n)) return 0;
    // якщо значення > 100 — скоріш за все пікселі, але без розміру зображення
    // ділимо на 10 як евристика (типовий рендер ~1000px)
    const pct = n > 100 ? n / 10 : n;
    return Math.min(100, Math.max(0, Math.round(pct * 10) / 10));
  };
  return { x: fix(z.x), y: fix(z.y), w: fix(z.w), h: fix(z.h) };
}
function normalizeZones(data) {
  if (!data) return data;
  const fixArr = arr => (arr || []).map(item => item?.zone ? { ...item, zone: normalizeZone(item.zone) } : item);
  return { ...data, items: fixArr(data.items), defects: fixArr(data.defects), corrections: fixArr(data.corrections), sverka: fixArr(data.sverka) };
}
async function callAPI(parts, retries = 2, apiKey = "") {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", "anthropic-beta": "prompt-caching-2024-07-31", "anthropic-dangerous-direct-browser-access": "true", "x-api-key": apiKey },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 8000, messages: [{ role: "user", content: parts }] })
      });
      let data; try { data = await resp.json(); } catch { throw new Error(`HTTP ${resp.status}`); }
      if (!resp.ok) {
        if ((resp.status === 502 || resp.status === 503 || resp.status === 529) && attempt < retries) {
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue;
        }
        throw new Error(`API ${resp.status}: ${data?.error?.message || ""}`);
      }
      const raw = (data.content || []).map(b => b.text || "").join("");
      if (!raw.trim()) throw new Error("Порожня відповідь");
      const m = raw.match(/```json\s*([\s\S]*?)```/) || raw.match(/```\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/);
      if (!m) throw new Error("JSON не знайдено");
      try { return JSON.parse(m[1]); } catch (parseErr) {
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        throw new Error(`JSON parse failed: ${parseErr.message}`);
      }
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────
const QA_CHECKS = [
  { id: "Q1.1", label: "Левітація",     color: "#e74c3c" },
  { id: "Q1.2", label: "Перетин",       color: "#e67e22" },
  { id: "Q1.3", label: "Текстури",      color: "#9b59b6" },
  { id: "Q1.4", label: "Зубчатість",    color: "#3498db" },
  { id: "Q1.5", label: "Артефакти",     color: "#1abc9c" },
  { id: "Q1.6", label: "Відбиття",      color: "#f39c12" },
  { id: "Q2.1", label: "Креслення",     color: "#2980b9" },
  { id: "Q2.2", label: "Мудборд/Бриф",  color: "#8e44ad" },
  { id: "Q2.3", label: "Моделі",        color: "#16a085" },
  { id: "Q3.1", label: "Геосеттинг",    color: "#c0392b" },
  { id: "Q3.2", label: "Написи/Лого",   color: "#d35400" },
  { id: "Q4.1", label: "Client Req",    color: "#27ae60" },
];
const QC = Object.fromEntries(QA_CHECKS.map(q => [q.id, q.color]));
const STANDARDS = {
  NON: { color: "#e74c3c", bg: "#fff5f5", desc: "Низький рівень" },
  MLR: { color: "#e67e22", bg: "#fff9f0", desc: "Середній рівень" },
  SDC: { color: "#27ae60", bg: "#f0faf4", desc: "Високий стандарт" },
};
const STATUS = {
  fixed:     { label: "Відповідає",    icon: "✅", color: "#27ae60", bg: "#f0faf4" },
  not_fixed: { label: "Не відповідає", icon: "❌", color: "#e74c3c", bg: "#fff5f5" },
  partial:   { label: "Частково",      icon: "⚠️", color: "#e67e22", bg: "#fff9f0" },
};
const MAT_STATUS = {
  match:    { label: "Відповідає",      icon: "✅", color: "#27ae60", bg: "#f0faf4" },
  mismatch: { label: "Невідповідність", icon: "❌", color: "#e74c3c", bg: "#fff5f5" },
  missing:  { label: "Відсутній",       icon: "🔍", color: "#9b59b6", bg: "#faf5ff" },
  unknown:  { label: "Не перевірено",   icon: "❓", color: "#aaa",    bg: "#f5f5f5" },
};

const QUAL_C = `NON (0-54%): плоске освітлення без тіней, геометричні помилки, тайлінг, шум, відсутність глибини, грубі порушення брифу
MLR (55-79%): фізично коректні матеріали, природне освітлення, чистий рендер, відповідність основним вимогам ТЗ
SDC (80-100%): кінематографічна композиція, бездоганна якість, всі деталі геосеттингу на місці, повна відповідність брифу і кресленням`;

const ZONE_PROMPT = `═══ ТОЧНЕ ВИЗНАЧЕННЯ ЗОН — КРИТИЧНО ДЛЯ ЯКОСТІ ПЕРЕВІРКИ ═══
Система координат: x=0 ліво, y=0 верх, одиниці = ВІДСОТКИ (0.0–100.0) від розміру зображення.
ЗАБОРОНЕНО пікселі (x:450, y:320) — тільки відсотки. Всі значення ОБОВ'ЯЗКОВО в діапазоні 0–100.

КРОК 1 — Ідентифікація: назви КОНКРЕТНИЙ об'єкт ("ліва передня ніжка дивану", "шов між плиткою та плінтусом праворуч")
КРОК 2 — Локалізація: визнач де він на зображенні (ліво/право/центр, верх/низ/середина)
КРОК 3 — Координати: переведи позицію у x,y,w,h відсотки

РОЗМІРИ ЗОН (строго дотримуйся):
• Точковий дефект (ніжка, стик, піксель): w=3-6, h=3-8
• Невеликий об'єкт (стілець, ваза, подушка): w=6-14, h=8-18
• Поверхня/матеріал (ділянка підлоги, стіни): w=12-25, h=10-20
• Зона освітлення (вікно, пляма світла): w=15-30, h=15-30
• МАКСИМУМ: w=35, h=35 — тільки якщо дефект охоплює чверть зображення

ПРИКЛАДИ ПРАВИЛЬНИХ ЗОН:
✅ Левітація ніжки дивана зліва внизу: {"x":8,"y":74,"w":5,"h":7}
✅ Тайлінг паркету по центру підлоги: {"x":32,"y":62,"w":20,"h":14}
✅ Firefly у верхньому правому куті стелі: {"x":78,"y":6,"w":4,"h":4}
✅ Неправильне відбиття у дзеркалі зліва: {"x":4,"y":28,"w":12,"h":22}
✅ Перетин штори з підлогою: {"x":88,"y":72,"w":8,"h":16}

ЗАБОРОНЕНО (завжди неправильно):
❌ {"x":0,"y":0,"w":100,"h":100} — вся картинка
❌ {"x":0,"y":0,"w":50,"h":100} — пів картинки
❌ Зони без прив'язки до конкретного об'єкту

Пам'ятай: зона має бути такою маленькою, щоб хтось міг одразу знайти проблему поглядом.`;

const BLUEPRINT_COMPARE_PROMPT = `═══ ПОРІВНЯННЯ З КРЕСЛЕННЯМ (Q2.1) ═══
Якщо надані креслення — обов'язково перевір:
Elevations (фасади/висоти), Floorplan (розташування меблів/стін), Lighting plan (розташування світильників/розеток), лейаут меблів, вікна/двері/ручки/плінтуси/карнизи, напрямок текстур/матеріалів, розкладка плитки/підлог, вентканали, водостоки (Gutter), гребінь/коник даху, цегла/сайдинг, відповідність ландшафтному плану.
Для кожної невідповідності — вкажи точну зону на рендері.`;

const JSON_SCHEMA = `{"tz_parsed":[{"category":"Матеріали","items":["Диван — червоний велюр","Підлога — паркет дуб 180×1200мм","Стіни — штукатурка теплий беж"]},{"category":"Сезон / атмосфера","items":["Літо, яскраве денне освітлення"]},{"category":"Меблі та моделі","items":["Стілець Eames білий","Стіл скляний 120×80см"]},{"category":"Креслення","items":["Планування 4×6м, вікно зліва, вхід справа"]},{"category":"Логотип / написи","items":["Логотип XYZ на стіні праворуч"]},{"category":"Вимоги клієнта","items":["Формат TIFF 300dpi"]}],"sverka":[{"id":"S10","status":"ok","note":"Світильники по RCP: 6/6 на місцях, розетки по плану","doc_ref":"RCP_final.pdf","zone":{"x":40,"y":8,"w":20,"h":10}},{"id":"S7","status":"no_material","note":"Ландшафтний план не наданий","doc_ref":"","zone":null}],"checks":[{"id":"Q1.1","status":"ok","group":"technical","note":"Всі меблі стоять на поверхні, контактні тіні присутні"},{"id":"Q1.2","status":"fail","group":"technical","note":"Диван перетинає ліву стіну в нижній частині"},{"id":"Q1.3","status":"ok","group":"technical","note":"Тайлінг не виявлено, масштаб текстур коректний"},{"id":"Q1.4","status":"ok","group":"technical","note":"Краї рівні, аліасинг відсутній"},{"id":"Q1.5","status":"warn","group":"technical","note":"Незначні fireflies у верхньому правому куті стелі"},{"id":"Q1.6","status":"ok","group":"technical","note":"IOR матеріалів коректний, roughness відповідає"},{"id":"Q2.1","status":"skipped","group":"tz","note":"Креслення не надані"},{"id":"Q2.2","status":"fail","group":"tz","note":"Колір дивану: має бути червоний велюр — присутній синій"},{"id":"Q2.2b","status":"warn","group":"materials","note":"Відтінок беж стіни недостатньо теплий порівняно з референсом"},{"id":"Q2.3","status":"ok","group":"tz","note":"Модель стільця відповідає запиту клієнта"},{"id":"Q3.1","status":"warn","group":"geosetting","note":"Відсутні розетки на стінах — геосеттинг неповний"},{"id":"Q3.2","status":"ok","group":"geosetting","note":"Написи та логотипи коректні"},{"id":"Q4.1","status":"skipped","group":"client","note":"Специфічних технічних вимог клієнта не зазначено"}],"items":[{"id":"tz1","comment":"Текстура підлоги — паркет дуб","status":"not_fixed","note":"Видно тайлінг патерну","zone":{"x":20,"y":60,"w":18,"h":14}},{"id":"tz2","comment":"Пора року — літо","status":"fixed","note":"Зелена рослинність відповідає","zone":{"x":35,"y":15,"w":22,"h":18}}],"corrections":[{"id":"c1","title":"Виправити тіні під диваном","description":"Відсутні контактні тіні","priority":"high","zone":{"x":18,"y":68,"w":24,"h":8}}],"defects":[{"id":"d1","title":"Левітація ніжки стільця","description":"Передня ліва ніжка не торкається підлоги","severity":"high","qa_tag":"Q1.1","zone":{"x":44,"y":71,"w":4,"h":6}},{"id":"d2","title":"Неправильний напис на банері","description":"Lorem Ipsum замість реального тексту","severity":"medium","qa_tag":"Q3.2","zone":{"x":60,"y":20,"w":18,"h":8}},{"id":"d3","title":"Відсутні розетки","description":"На стінах немає розеток — геосеттинг","severity":"low","qa_tag":"Q3.1","zone":{"x":10,"y":55,"w":5,"h":6}},{"id":"d4","title":"Меблі не на місці по плану","description":"Диван зміщений відносно floorplan","severity":"high","qa_tag":"Q2.1","zone":{"x":25,"y":50,"w":30,"h":25}}],"materials":[{"id":"m1","name":"Паркет дуб натуральний","group":"Підлога","spec":"180×1200мм","status":"match","note":"Відповідає ТЗ","expected":"180x1200 натуральний дуб","zone":{"x":15,"y":65,"w":22,"h":18}}],"quality":{"standard":"MLR","score":65,"tz_score":80,"tz_done":12,"tz_total":15,"summary":"Рендер загалом якісний, але є проблеми з геосеттингом та написами","criteria":[{"name":"Геометрія та фізика","score":55},{"name":"Матеріали та текстури","score":60},{"name":"Геосеттинг та деталі","score":50},{"name":"Художня якість","score":72}],"upgradeTips":["Додати розетки на стінах","Виправити написи на банерах"]},"summary":"MLR рівень, основні проблеми: геосеттинг та написи","globalSummary":""}`;

// ─── Canvas annotations ───────────────────────────────────────────────────────
function useAnnotatedCanvas(imgRef, anns, visibleIds, hovId) {
  const canvasRef = useRef();
  const draw = useCallback(() => {
    const canvas = canvasRef.current, img = imgRef.current;
    if (!canvas || !img) return;
    const rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    canvas.width = rect.width; canvas.height = rect.height;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    (anns || []).forEach(ann => {
      if (!ann.zone) return;
      const key = `${ann._src}:${ann._srcIdx}`;
      if (visibleIds && !visibleIds.has(key)) return;
      const { x, y, w, h } = ann.zone;
      const isHov = hovId === key;
      let col;
      if (ann._src === "sverka") col = SVERKA_STATUS[ann.status]?.color || "#888";
      else if (ann._src === "material") col = MAT_STATUS[ann.status]?.color || "#9b59b6";
      else col = ann.qa_tag ? (QC[ann.qa_tag] || "#888") : (STATUS[ann.status]?.color || "#888");
      const cx = x / 100 * canvas.width, cy = y / 100 * canvas.height;
      const cw = Math.max(w / 100 * canvas.width, 24), ch = Math.max(h / 100 * canvas.height, 18);
      ctx.save();
      ctx.fillStyle = col + (isHov ? "28" : "14");
      ctx.fillRect(cx, cy, cw, ch);
      ctx.strokeStyle = col; ctx.lineWidth = isHov ? 2.5 : 1.5;
      ctx.setLineDash(isHov ? [] : [4, 3]);
      const r2 = 3;
      ctx.beginPath();
      ctx.moveTo(cx + r2, cy); ctx.lineTo(cx + cw - r2, cy);
      ctx.quadraticCurveTo(cx + cw, cy, cx + cw, cy + r2);
      ctx.lineTo(cx + cw, cy + ch - r2);
      ctx.quadraticCurveTo(cx + cw, cy + ch, cx + cw - r2, cy + ch);
      ctx.lineTo(cx + r2, cy + ch);
      ctx.quadraticCurveTo(cx, cy + ch, cx, cy + ch - r2);
      ctx.lineTo(cx, cy + r2);
      ctx.quadraticCurveTo(cx, cy, cx + r2, cy);
      ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
      const br = 9, bx = cx + br + 1, by = cy + br + 1;
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fill();
      if (isHov) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(bx, by, br + 2, 0, Math.PI * 2); ctx.stroke(); }
      ctx.fillStyle = "#fff"; ctx.font = "bold 9px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(ann._label ?? "-", bx, by);
      ctx.restore();
    });
  }, [anns, visibleIds, hovId]);
  useEffect(() => {
    const img = imgRef.current; if (!img) return;
    const ro = new ResizeObserver(draw); ro.observe(img);
    return () => ro.disconnect();
  }, [imgRef, draw]);
  useEffect(() => { draw(); }, [draw]);
  return canvasRef;
}

function AnnotatedImage({ src, anns, visibleIds, hovId }) {
  const imgRef = useRef();
  const canvasRef = useAnnotatedCanvas(imgRef, anns, visibleIds, hovId);
  return (
    <div style={{ position: "relative", lineHeight: 0 }}>
      <img ref={imgRef} src={src} alt="" style={{ width: "100%", height: "auto", borderRadius: 8, display: "block", border: "1px solid #2a2a2a" }} />
      <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", borderRadius: 8 }} />
    </div>
  );
}

function BlueprintImg({ src, anns, visibleIds, hovId }) {
  const imgRef = useRef();
  const canvasRef = useAnnotatedCanvas(imgRef, anns, visibleIds, hovId);
  return (
    <div style={{ position: "relative", lineHeight: 0 }}>
      <img ref={imgRef} src={src} alt="" style={{ width: "100%", height: "auto", borderRadius: 6, display: "block", border: "1px solid #444" }} />
      <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", borderRadius: 6 }} />
    </div>
  );
}

// ─── CloudConvert DWG→DXF ─────────────────────────────────────────────────────
async function convertDwgToDxf(dwgFile, apiKey, onProgress) {
  onProgress("Створення завдання…", 10);
  // 1. Створюємо job: upload → convert → export
  const jobResp = await fetch("https://api.cloudconvert.com/v2/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      tasks: {
        "upload-dwg": { operation: "import/upload" },
        "convert-to-dxf": { operation: "convert", input: "upload-dwg", input_format: "dwg", output_format: "dxf" },
        "export-dxf": { operation: "export/url", input: "convert-to-dxf" }
      }
    })
  });
  if (!jobResp.ok) {
    const err = await jobResp.json().catch(() => ({}));
    throw new Error(`CloudConvert: ${err?.message || jobResp.status}`);
  }
  const job = await jobResp.json();
  const uploadTask = job.data.tasks.find(t => t.name === "upload-dwg");
  if (!uploadTask?.result?.form) throw new Error("Не знайдено форму для завантаження");

  // 2. Завантажуємо DWG файл
  onProgress("Завантаження файлу…", 30);
  const form = uploadTask.result.form;
  const fd = new FormData();
  Object.entries(form.parameters || {}).forEach(([k, v]) => fd.append(k, v));
  fd.append("file", dwgFile);
  const uploadResp = await fetch(form.url, { method: "POST", body: fd });
  if (!uploadResp.ok) throw new Error(`Помилка завантаження: ${uploadResp.status}`);

  // 3. Чекаємо завершення конвертації
  onProgress("Конвертація DWG→DXF…", 50);
  const jobId = job.data.id;
  let doneJob = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(r => setTimeout(r, 2000));
    const statusResp = await fetch(`https://api.cloudconvert.com/v2/jobs/${jobId}`, {
      headers: { "Authorization": `Bearer ${apiKey}` }
    });
    const statusData = await statusResp.json();
    if (statusData.data.status === "finished") { doneJob = statusData.data; break; }
    if (statusData.data.status === "error") throw new Error("CloudConvert: помилка конвертації");
    onProgress(`Конвертація… (${attempt + 1}/30)`, 50 + attempt);
  }
  if (!doneJob) throw new Error("Timeout: конвертація зайняла більше 60 секунд");

  // 4. Скачуємо DXF
  onProgress("Завантаження результату…", 85);
  const exportTask = doneJob.tasks.find(t => t.name === "export-dxf");
  const dxfUrl = exportTask?.result?.files?.[0]?.url;
  if (!dxfUrl) throw new Error("Не знайдено URL результату");

  const dxfResp = await fetch(dxfUrl);
  if (!dxfResp.ok) throw new Error(`Помилка скачування DXF: ${dxfResp.status}`);
  const dxfText = await dxfResp.text();

  onProgress("Читання DXF…", 95);
  const parsed = parseDXF(dxfText);
  onProgress("Готово!", 100);
  return { textContent: parsed, rawDxf: dxfText };
}

// ─── DWG Upload + Convert Slot ────────────────────────────────────────────────
function DwgSlot({ files, onAddDwg, onRemove, onConverted, onDocType }) {
  const inputRef = useRef();
  const [apiKey, setApiKey] = useState(() => { try { return localStorage.getItem("cc_api_key") || ""; } catch { return ""; } });
  const [showKey, setShowKey] = useState(false);
  const [showConverter, setShowConverter] = useState(false);
  const [drag, setDrag] = useState(false);
  const ctr = useRef(0);
  const [converting, setConverting] = useState({});
  const [ccResults, setCcResults] = useState({});
  const [errors, setErrors] = useState({});

  const saveKey = k => { setApiKey(k); try { localStorage.setItem("cc_api_key", k); } catch { /* ignore */ } };

  const handleFiles = fs => Array.from(fs).forEach(f => {
    const nm = f.name.toLowerCase();
    if (nm.endsWith(".dwg") || nm.endsWith(".dxf") || nm.endsWith(".pdf") ||
        f.type.startsWith("image/")) onAddDwg(f);
  });

  // CloudConvert — тепер опціональне покращення
  const convertWithCC = async (f) => {
    if (!apiKey.trim()) return;
    const id = f._id;
    setConverting(p => ({ ...p, [id]: { msg: "Починаємо…", pct: 0 } }));
    setErrors(p => ({ ...p, [id]: null }));
    try {
      const result = await convertDwgToDxf(f._file || f, apiKey.trim(), (msg, pct) => {
        setConverting(p => ({ ...p, [id]: { msg, pct } }));
      });
      setConverting(p => ({ ...p, [id]: null }));
      setCcResults(p => ({ ...p, [id]: true }));
      onConverted(f, result.textContent); // замінює DWG→DXF для кращих даних
    } catch (e) {
      setConverting(p => ({ ...p, [id]: null }));
      setErrors(p => ({ ...p, [id]: e.message }));
    }
  };

  const dwgFiles = files.filter(f => f.type === "dwg" && !f._loading && !f._error);
  const hasDwg = dwgFiles.length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <div style={{ fontSize: 10, letterSpacing: "0.14em", color: "#888", marginBottom: 2, fontFamily: "monospace" }}>КРЕСЛЕННЯ</div>
      <div style={{ fontSize: 9, color: "#bbb", fontFamily: "monospace", marginBottom: 5 }}>PDF · DXF · <span style={{ color: "#3498db" }}>DWG</span> · JPG/PNG</div>

      {/* Зона завантаження */}
      <div
        onDragEnter={e => { e.preventDefault(); ctr.current++; setDrag(true); }}
        onDragLeave={e => { e.preventDefault(); if (--ctr.current === 0) setDrag(false); }}
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); setDrag(false); ctr.current = 0; handleFiles(e.dataTransfer.files); }}
        style={{ border: `2px dashed ${drag ? "#3498db" : "#ddd"}`, borderRadius: hasDwg ? "10px 10px 0 0" : 10, padding: 8, background: drag ? "#3498db11" : "#fafafa", minHeight: 90, display: "flex", flexDirection: "column", justifyContent: files.length === 0 ? "center" : "flex-start" }}
      >
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", justifyContent: files.length === 0 ? "center" : "flex-start" }}>
          {files.map((f, i) => {
            const id = f._id;
            const conv = converting[id];
            const isDwg = f.type === "dwg";
            const isDone = ccResults[id];
            const hasText = f.textContent && !f.textContent.includes("помилка");
            return (
              <div key={id} style={{ position: "relative", flexShrink: 0 }}>
                <div style={{
                  width: 70, height: 70, borderRadius: 5,
                  border: `2px solid ${isDone ? "#27ae60" : conv ? "#e67e22" : isDwg && hasText ? "#3498db" : "#ddd"}`,
                  background: isDwg ? (isDone ? "#0a1f0a" : "#0a1929") : "#f0eeea",
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2
                }}>
                  {conv ? (
                    <>
                      <div style={{ width: 20, height: 20, border: "2px solid #e67e22", borderTop: "2px solid transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                      <div style={{ fontSize: 7, color: "#e67e22", fontFamily: "monospace" }}>{conv.pct}%</div>
                    </>
                  ) : isDone ? (
                    <>
                      <div style={{ fontSize: 16 }}>✅</div>
                      <div style={{ fontSize: 7, color: "#27ae60", fontFamily: "monospace" }}>DXF точний</div>
                    </>
                  ) : isDwg && hasText ? (
                    <>
                      <div style={{ fontSize: 16 }}>📐</div>
                      <div style={{ fontSize: 7, color: "#3498db", fontFamily: "monospace" }}>DWG ✓</div>
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: 16 }}>{ {pdf:"📄", dxf:"📐", image:"🖼️"}[f.type] || "📎" }</div>
                      <div style={{ fontSize: 7, color: "#888", fontFamily: "monospace" }}>{f.ext || f.type?.toUpperCase()}</div>
                    </>
                  )}
                  {conv && (
                    <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 3, background: "#111", borderRadius: "0 0 5px 5px", overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${conv.pct}%`, background: "#e67e22", transition: "width 0.3s" }} />
                    </div>
                  )}
                </div>
                {!conv && <button onClick={() => onRemove(i)} style={{ position: "absolute", top: -5, right: -5, width: 16, height: 16, background: "#e74c3c", color: "#fff", border: "none", borderRadius: "50%", cursor: "pointer", fontSize: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>}
                <div style={{ fontSize: 7, color: "#888", fontFamily: "monospace", textAlign: "center", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 70 }}>{f.filename}</div>
                {onDocType && !f._loading && !f._error && (
                  <select value={f._docType || ""} onChange={e => onDocType(f._id, e.target.value)} title="Тип документа для Cross-Check"
                    style={{ width: 70, fontSize: 8, fontFamily: "monospace", border: `1px solid ${f._docType ? "#3498db" : "#ddd"}`, borderRadius: 3, padding: "1px 2px", outline: "none", color: f._docType ? "#333" : "#bbb", background: "#fff", boxSizing: "border-box", marginTop: 2 }}>
                    <option value="">тип?</option>
                    {Object.entries(DOC_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                )}
              </div>
            );
          })}
          <div onClick={() => inputRef.current.click()} style={{ width: 70, height: 70, border: "2px dashed #3498db", borderRadius: 8, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}>
            <div style={{ fontSize: 20, color: "#3498db" }}>+</div>
            <div style={{ fontSize: 7, color: "#bbb", fontFamily: "monospace", textAlign: "center" }}>DWG/DXF<br/>PDF/зображ.</div>
          </div>
        </div>
        {!drag && <div style={{ fontSize: 8, color: "#ccc", fontFamily: "monospace", textAlign: "center", marginTop: 4 }}>↑ або перетягніть</div>}
      </div>

      {/* Превью прочитаних DWG — показується відразу без API */}
      {dwgFiles.filter(f => f.textContent && !f.textContent.includes("помилка")).map(f => {
        const lines = f.textContent.split("\n").filter(l => l.trim()).slice(0, 6);
        const conv = converting[f._id];
        return (
          <div key={f._id} style={{ background: "#0a1520", border: "1px solid #3498db33", borderTop: "none", padding: "8px 12px" }}>
            <div style={{ fontSize: 8, color: "#3498db", fontFamily: "monospace", marginBottom: 4 }}>
              📐 {f.filename} — прочитано (без API):
            </div>
            {lines.map((l, i) => <div key={i} style={{ fontSize: 8, color: "#556", fontFamily: "monospace", lineHeight: 1.5 }}>{l}</div>)}
            {!ccResults[f._id] && !conv && (
              <button onClick={() => setShowConverter(s => !s)} style={{ marginTop: 6, background: "transparent", border: "1px solid #3498db44", color: "#3498db", borderRadius: 4, padding: "3px 8px", cursor: "pointer", fontSize: 8, fontFamily: "monospace" }}>
                {showConverter ? "▲ сховати" : "⚡ покращити точність через CloudConvert DXF →"}
              </button>
            )}
            {ccResults[f._id] && <div style={{ fontSize: 8, color: "#27ae60", fontFamily: "monospace", marginTop: 4 }}>✅ Замінено точним DXF</div>}
          </div>
        );
      })}

      {/* CloudConvert — опціональне покращення */}
      {hasDwg && showConverter && (
        <div style={{ background: "#0f1923", border: "1px solid #e67e2233", borderTop: "none", borderRadius: "0 0 8px 8px", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 7 }}>
          <div style={{ fontSize: 9, color: "#e67e22", fontFamily: "monospace", fontWeight: 700 }}>⚡ CloudConvert — точніший DXF (опціонально)</div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={e => saveKey(e.target.value)}
              placeholder="API ключ з cloudconvert.com"
              style={{ flex: 1, background: "#1a2332", border: "1px solid #334", borderRadius: 5, padding: "5px 8px", color: "#ddd", fontFamily: "monospace", fontSize: 10, outline: "none" }}
            />
            <button onClick={() => setShowKey(s => !s)} style={{ background: "#1a2332", border: "1px solid #334", color: "#666", borderRadius: 4, padding: "5px 7px", cursor: "pointer", fontSize: 9 }}>
              {showKey ? "🙈" : "👁"}
            </button>
          </div>
          <div style={{ fontSize: 8, color: "#555", fontFamily: "monospace", lineHeight: 1.6 }}>
            <a href="https://cloudconvert.com/register" target="_blank" style={{ color: "#3498db" }}>cloudconvert.com</a> → API Keys → Create (tasks.read + tasks.write) — 25 безкоштовних/день
          </div>
          {dwgFiles.map(f => (
            <div key={f._id} style={{ display: "flex", alignItems: "center", gap: 8, background: "#1a2332", borderRadius: 5, padding: "6px 10px" }}>
              <span style={{ flex: 1, fontSize: 9, color: "#aaa", fontFamily: "monospace" }}>{f.filename}</span>
              {ccResults[f._id]
                ? <span style={{ fontSize: 9, color: "#27ae60", fontFamily: "monospace" }}>✅ готово</span>
                : converting[f._id]
                  ? <span style={{ fontSize: 8, color: "#e67e22", fontFamily: "monospace" }}>{converting[f._id]?.msg} {converting[f._id]?.pct}%</span>
                  : <button onClick={() => convertWithCC(f)} disabled={!apiKey.trim()} style={{ background: apiKey.trim() ? "#e67e22" : "#333", border: "none", color: "#fff", borderRadius: 4, padding: "4px 10px", cursor: apiKey.trim() ? "pointer" : "not-allowed", fontSize: 9, fontFamily: "monospace" }}>
                      Конвертувати →
                    </button>
              }
              {errors[f._id] && <span style={{ fontSize: 8, color: "#e74c3c", fontFamily: "monospace" }}>{errors[f._id]}</span>}
            </div>
          ))}
        </div>
      )}

      <input ref={inputRef} type="file" accept=".dwg,.dxf,.pdf,.png,.jpg,.jpeg,.webp" multiple style={{ display: "none" }} onChange={e => { handleFiles(e.target.files); e.target.value = ""; }} />
    </div>
  );
}


function BlueprintPanel({ drawings, anns, visibleIds, hovId }) {
  const [di, setDi] = useState(0);
  const [pi, setPi] = useState(0);
  const ready = (drawings || []).filter(d => !d._loading && !d._error && d.type !== "excel" && d.type !== "dwg" && d.type !== "dxf" && (d.pages || []).some(p => p.preview));
  const dwgOnly = (drawings || []).filter(d => !d._loading && !d._error && d.type === "dwg");
  const dxfOnly = (drawings || []).filter(d => !d._loading && !d._error && d.type === "dxf");
  if (!ready.length && !dwgOnly.length && !dxfOnly.length) return <div style={{ height: 80, display: "flex", alignItems: "center", justifyContent: "center", background: "#0d1117", borderRadius: 8, color: "#555", fontFamily: "monospace", fontSize: 10 }}>Креслення не завантажені</div>;
  if (!ready.length) return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {dxfOnly.length > 0 && (
        <div style={{ background: "#0d2b0d", border: "1px solid #27ae6033", borderRadius: 8, padding: "10px 14px" }}>
          <div style={{ fontSize: 10, color: "#27ae60", fontFamily: "monospace", marginBottom: 4 }}>📐 DXF зчитано — дані передані до Claude:</div>
          {dxfOnly.map((d, i) => <div key={i} style={{ fontSize: 9, color: "#888", fontFamily: "monospace" }}>✓ {d.filename}</div>)}
        </div>
      )}
      {dwgOnly.length > 0 && (
        <div style={{ background: "#1a1208", border: "1px solid #e67e2233", borderRadius: 8, padding: "10px 14px" }}>
          <div style={{ fontSize: 10, color: "#e67e22", fontFamily: "monospace", marginBottom: 6 }}>⚠️ DWG — бінарний формат, не читається напряму</div>
          <div style={{ fontSize: 9, color: "#888", fontFamily: "monospace", lineHeight: 1.6 }}>
            Варіанти конвертації у DXF або PDF:<br/>
            • <a href="https://www.zamzar.com/convert/dwg-to-pdf/" target="_blank" style={{ color: "#3498db" }}>zamzar.com</a> — DWG→PDF безкоштовно<br/>
            • <a href="https://cloudconvert.com/dwg-to-dxf" target="_blank" style={{ color: "#3498db" }}>cloudconvert.com</a> — DWG→DXF (текст читається)<br/>
            • AutoCAD: File → Export → PDF або Save As DXF
          </div>
        </div>
      )}
    </div>
  );
  const cur = ready[di]; const dPages = cur?.pages || []; const dPrev = dPages[pi]?.preview;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {dxfOnly.length > 0 && <div style={{ fontSize: 9, color: "#27ae60", fontFamily: "monospace", background: "#0d2b0d", padding: "4px 8px", borderRadius: 4 }}>📐 DXF дані також передані Claude: {dxfOnly.map(d => d.filename).join(", ")}</div>}
      {ready.length > 1 && <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>{ready.map((d, i) => <button key={i} onClick={() => { setDi(i); setPi(0); }} style={{ fontSize: 9, fontFamily: "monospace", padding: "3px 9px", borderRadius: 4, border: "none", cursor: "pointer", background: di === i ? "#fff" : "#333", color: di === i ? "#111" : "#aaa" }}>{d.filename || `Крес.${i + 1}`}</button>)}</div>}
      {dPages.length > 1 && <div style={{ display: "flex", gap: 4 }}>{dPages.map((_, i) => <button key={i} onClick={() => setPi(i)} style={{ fontSize: 9, fontFamily: "monospace", padding: "2px 7px", borderRadius: 4, border: "none", cursor: "pointer", background: pi === i ? "#fff" : "#333", color: pi === i ? "#111" : "#aaa" }}>Стор.{i + 1}</button>)}</div>}
      {dPrev
        ? <BlueprintImg src={dPrev} anns={anns} visibleIds={visibleIds} hovId={hovId} />
        : <div style={{ height: 100, background: "#1a1a1a", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", color: "#555", fontFamily: "monospace", fontSize: 10 }}>немає превью</div>
      }
    </div>
  );
}

// ─── Verdict banner (горизонтальна смуга над зображенням) ─────────────────────
function VerdictBanner({ quality, summary }) {
  if (!quality) return null;
  const key = quality.standard && quality.standard.startsWith("SDC") ? "SDC"
    : quality.standard && quality.standard.startsWith("MLR") ? "MLR" : "NON";
  const cfg = STANDARDS[key];
  const score = quality.score || 0;
  const sc = score >= 80 ? "#27ae60" : score >= 55 ? "#e67e22" : "#e74c3c";
  const nextKey = key === "NON" ? "MLR" : key === "MLR" ? "SDC" : null;
  const tips = (quality.upgradeTips || []).filter(t => t);
  return (
    <div style={{ background: "#fff", border: `1.5px solid ${cfg.color}55`, borderRadius: 10, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "stretch" }}>
        <div style={{ background: cfg.color, padding: "12px 20px", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", minWidth: 90, flexShrink: 0 }}>
          <div style={{ fontSize: 8, color: "rgba(255,255,255,0.65)", fontFamily: "monospace", letterSpacing: "0.12em", marginBottom: 2 }}>ВИСНОВОК QA</div>
          <div style={{ fontSize: 26, fontWeight: 700, color: "#fff", fontFamily: "monospace", lineHeight: 1 }}>{quality.standard || key}</div>
          <div style={{ fontSize: 9, color: "rgba(255,255,255,0.75)", fontFamily: "monospace", marginTop: 2 }}>{cfg.desc}</div>
        </div>
        <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", borderRight: "1px solid #f0eeea", minWidth: 80, flexShrink: 0 }}>
          <div style={{ fontSize: 32, fontWeight: 700, color: sc, lineHeight: 1, fontFamily: "monospace" }}>{score}%</div>
          <div style={{ fontSize: 8, color: "#aaa", fontFamily: "monospace", marginTop: 2 }}>ГОТОВНІСТЬ</div>
          <div style={{ width: 60, height: 5, background: "#e0ddd8", borderRadius: 3, overflow: "hidden", marginTop: 6 }}>
            <div style={{ height: "100%", width: `${score}%`, background: sc, borderRadius: 3, transition: "width 0.8s" }} />
          </div>
        </div>
        <div style={{ flex: 1, padding: "12px 14px", display: "flex", flexDirection: "column", justifyContent: "center", gap: 5, borderRight: (nextKey && tips.length > 0) ? "1px solid #f0eeea" : "none" }}>
          {(quality.criteria || []).map((c, i) => {
            const csc = c.score >= 80 ? "#27ae60" : c.score >= 55 ? "#e67e22" : "#e74c3c";
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ fontSize: 9, fontFamily: "monospace", color: "#666", width: 110, flexShrink: 0 }}>{c.name}</div>
                <div style={{ flex: 1, height: 4, background: "#e8e6e1", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${c.score}%`, background: csc, borderRadius: 2 }} />
                </div>
                <div style={{ fontSize: 9, fontFamily: "monospace", color: "#888", width: 26, textAlign: "right" }}>{c.score}%</div>
              </div>
            );
          })}
        </div>
        {nextKey && tips.length > 0 && (
          <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", justifyContent: "center", minWidth: 180, maxWidth: 260, background: STANDARDS[nextKey].bg }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: STANDARDS[nextKey].color, fontFamily: "monospace", marginBottom: 5 }}>ДО {nextKey} ↑</div>
            {tips.map((t, i) => (
              <div key={i} style={{ fontSize: 9, color: "#555", fontFamily: "monospace", lineHeight: 1.55 }}>· {t}</div>
            ))}
          </div>
        )}
      </div>
      {summary && (
        <div style={{ borderTop: `1px solid ${cfg.color}22`, background: cfg.bg, padding: "9px 18px", fontSize: 11, color: "#444", fontFamily: "monospace", lineHeight: 1.65 }}>
          {summary}
        </div>
      )}
    </div>
  );
}

// ─── Verdict (права панель — скорочена версія) ────────────────────────────────
function Verdict({ quality }) {
  if (!quality) return <div style={{ textAlign: "center", padding: 20, color: "#bbb", fontFamily: "monospace", fontSize: 11 }}>Висновок відсутній</div>;
  const key = quality.standard && quality.standard.startsWith("SDC") ? "SDC"
    : quality.standard && quality.standard.startsWith("MLR") ? "MLR" : "NON";
  const cfg = STANDARDS[key];
  const score = quality.score || 0;
  const sc = score >= 80 ? "#27ae60" : score >= 55 ? "#e67e22" : "#e74c3c";
  const nextKey = key === "NON" ? "MLR" : key === "MLR" ? "SDC" : null;
  return (
    <div style={{ background: cfg.bg, border: `2px solid ${cfg.color}44`, borderRadius: 12, overflow: "hidden" }}>
      <div style={{ background: cfg.color, padding: "10px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 9, color: "rgba(255,255,255,0.7)", fontFamily: "monospace", letterSpacing: "0.1em" }}>ВИСНОВОК QA</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "#fff", fontFamily: "monospace" }}>{quality.standard || key}</div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.8)", fontFamily: "monospace" }}>{cfg.desc}</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 36, fontWeight: 700, color: "#fff", lineHeight: 1 }}>{score}%</div>
          <div style={{ fontSize: 9, color: "rgba(255,255,255,0.7)", fontFamily: "monospace" }}>ГОТОВНІСТЬ</div>
        </div>
      </div>
      <div style={{ padding: "12px 16px" }}>
        <div style={{ height: 7, background: "#e0ddd8", borderRadius: 4, overflow: "hidden", marginBottom: 10 }}>
          <div style={{ height: "100%", width: `${score}%`, background: sc, borderRadius: 4, transition: "width 0.8s" }} />
        </div>
        {(quality.criteria || []).map((c, i) => {
          const csc = c.score >= 80 ? "#27ae60" : c.score >= 55 ? "#e67e22" : "#e74c3c";
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
              <div style={{ fontSize: 10, fontFamily: "monospace", color: "#555", width: 130, flexShrink: 0 }}>{c.name}</div>
              <div style={{ flex: 1, height: 4, background: "#e0ddd8", borderRadius: 2, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${c.score}%`, background: csc, borderRadius: 2 }} />
              </div>
              <div style={{ fontSize: 10, fontFamily: "monospace", color: "#666", width: 28, textAlign: "right" }}>{c.score}%</div>
            </div>
          );
        })}
        {quality.summary && <div style={{ fontSize: 11, color: "#444", lineHeight: 1.65, fontFamily: "monospace", background: "rgba(255,255,255,0.6)", borderRadius: 6, padding: "8px 10px", marginTop: 8 }}>{quality.summary}</div>}
        {nextKey && (quality.upgradeTips || []).length > 0 && (
          <div style={{ marginTop: 10, background: STANDARDS[nextKey].bg, borderLeft: `4px solid ${STANDARDS[nextKey].color}`, padding: "8px 12px", borderRadius: "0 6px 6px 0" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: STANDARDS[nextKey].color, fontFamily: "monospace", marginBottom: 4 }}>ДО {nextKey} ↑</div>
            {quality.upgradeTips.map((t, i) => <div key={i} style={{ fontSize: 11, color: "#444", fontFamily: "monospace", marginBottom: 2 }}>· {t}</div>)}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Tab bar component ────────────────────────────────────────────────────────
function TabBar({ tabs, active, onSelect }) {
  return (
    <div style={{ borderBottom: "1px solid #e8e6e1", padding: "0 14px", display: "flex", flexWrap: "wrap", gap: 0, alignItems: "flex-end", background: "#fff" }}>
      {tabs.map(t => (
        <button key={t.id} onClick={() => onSelect(t.id)} style={{
          background: "none", border: "none", padding: "10px 12px 9px",
          fontSize: 13, fontFamily: "Georgia, serif", cursor: "pointer",
          color: active === t.id ? "#1a1a1a" : "#aaa",
          fontWeight: active === t.id ? 600 : 400,
          borderBottom: active === t.id ? "2px solid #1a1a1a" : "2px solid transparent",
          marginBottom: -1, whiteSpace: "nowrap",
        }}>{t.label}</button>
      ))}
    </div>
  );
}

// ─── Detail page ──────────────────────────────────────────────────────────────
function DetailPage({ renderFiles, beforeFiles, data, drawings, num, total, status, apiError, onBack, mode, onReview, tzCards = [], tzAnnotation = "", tzClientComments = [], sverkaChecks = [], onSverkaOverride }) {
  const [selR, setSelR] = useState(0);
  const [hovId, setHovId] = useState(null);
  const [visibleIds, setVisibleIds] = useState(null);
  const [irrelevant, setIrrelevant] = useState(new Set()); // "item:0", "corr:1", "defect:2"
  const [reviewing, setReviewing] = useState(false);
  const [showTz, setShowTz] = useState(false);

  const items = data?.items || [];
  const corr = data?.corrections || [];
  const defects = data?.defects || [];
  const materials = data?.materials || [];
  const checks = data?.checks || [];
  const tz_parsed = data?.tz_parsed || [];
  const svRows = sverkaRows(data?.sverka, data?.sverkaOverrides, sverkaChecks.length ? sverkaChecks : activeSverka([], mode));
  const svChecked = svRows.filter(r => ["ok", "warn", "fail"].includes(r.status)).length;
  const svFail = svRows.filter(r => r.status === "fail").length;
  const svNoMat = svRows.filter(r => r.status === "no_material").length;
  const quality = data?.quality;
  const isRev = mode === "revision";

  const [tab, setTab] = useState(() => checks.length > 0 ? "report" : items.length > 0 ? "tz" : "overview");

  const toggleIrrelevant = (key) => {
    setIrrelevant(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const handleReview = async () => {
    if (!onReview || irrelevant.size === 0) return;
    setReviewing(true);
    const excluded = [];
    irrelevant.forEach(key => {
      const [src, idx] = key.split(":");
      const i = parseInt(idx);
      if (src === "item") excluded.push({ type: "ТЗ", text: items[i]?.comment });
      if (src === "corr") excluded.push({ type: "Правка", text: corr[i]?.title });
      if (src === "defect") excluded.push({ type: "Дефект", text: defects[i]?.title });
    });
    await onReview(excluded);
    setIrrelevant(new Set());
    setReviewing(false);
  };

  const allAnns = [
    ...items.map((x, i) => ({ ...x, _src: "item", _srcIdx: i, _label: i + 1 })),
    ...corr.map((x, i) => ({ ...x, comment: x.title, status: "partial", _src: "corr", _srcIdx: i, _label: i + 1 })),
    ...defects.map((x, i) => ({ ...x, comment: x.title, status: x.severity === "high" ? "not_fixed" : "partial", _src: "defect", _srcIdx: i, _label: i + 1 })),
    ...materials.filter(m => m.zone).map((m, i) => ({ ...m, comment: m.name, _src: "material", _srcIdx: i, _label: i + 1 })),
    ...svRows.filter(r => r.zone).map((r, i) => ({ ...r, comment: r.label, qa_tag: null, _src: "sverka", _srcIdx: i, _label: r.id.slice(1) })),
  ];

  useEffect(() => {
    if (!data) return;
    setVisibleIds(new Set(allAnns.map(a => `${a._src}:${a._srcIdx}`)));
  }, [data]); // eslint-disable-line

  const effVisible = visibleIds || new Set(allAnns.map(a => `${a._src}:${a._srcIdx}`));

  const handleToggle = (keyOrAll, vis) => {
    setVisibleIds(prev => {
      const s = new Set(prev || allAnns.map(a => `${a._src}:${a._srcIdx}`));
      if (keyOrAll === "all") {
        if (vis) allAnns.forEach(a => s.add(`${a._src}:${a._srcIdx}`));
        else allAnns.forEach(a => s.delete(`${a._src}:${a._srcIdx}`));
      } else {
        if (vis) s.add(keyOrAll); else s.delete(keyOrAll);
      }
      return s;
    });
  };
  const activeR = renderFiles?.[selR];
  const activePrev = activeR?.preview || activeR?.pages?.[0]?.preview;
  const beforePrev = beforeFiles?.[0]?.preview || beforeFiles?.[0]?.pages?.[0]?.preview;
  const stdKey = quality?.standard?.startsWith("SDC") ? "SDC" : quality?.standard?.startsWith("MLR") ? "MLR" : "NON";
  const stdCfg = STANDARDS[stdKey];
  const readyDrawings = (drawings || []).filter(d => !d._loading && !d._error && d.type !== "excel");
  const mismatches = materials.filter(m => m.status === "mismatch" || m.status === "missing").length;
  const tzOk = items.filter(x => x.status === "fixed").length;
  const tzFail = items.filter(x => x.status === "not_fixed").length;
  const critCount = defects.filter(d => d.severity === "high").length;

  const tabs1 = [
    { id: "sverka", label: `Cross-Check (${svChecked}/${svRows.length})` },
    checks.length > 0 && { id: "report", label: "Звіт" },
    tz_parsed.length > 0 && { id: "tz_parsed", label: "ТЗ розбір" },
    { id: "overview", label: "Заключення" },
    items.length > 0 && { id: "tz", label: `ТЗ (${items.length})` },
    corr.length > 0 && { id: "corr", label: `Правки (${corr.length})` },
    defects.length > 0 && { id: "defects", label: `Дефекти (${defects.length})` },
    materials.length > 0 && { id: "materials", label: `Матеріали (${materials.length})` },
  ].filter(Boolean);
  const drawingCount = readyDrawings.length + (drawings || []).filter(d => d.type === "dxf" || d.type === "dwg").length;
  const hasDrawTab = drawingCount > 0;


  return (
    <div style={{ minHeight: "100vh", background: "#f2f0ec" }}>
      <div style={{ background: "#111", color: "#f2f0ec", padding: "10px 18px", display: "flex", alignItems: "center", gap: 12, position: "sticky", top: 0, zIndex: 40, borderBottom: "1px solid #222" }}>
        <button onClick={onBack} style={{ background: "transparent", border: "1px solid #444", color: "#aaa", padding: "4px 11px", cursor: "pointer", fontSize: 11, fontFamily: "monospace", borderRadius: 4 }}>← {isRev ? "Раунди" : "Ракурси"}</button>
        <span style={{ fontSize: 11, fontFamily: "monospace", color: "#666" }}>{isRev ? "РАУНД" : "РАКУРС"} {num}{total > 1 ? ` / ${total}` : ""}</span>
        {tzCards.length > 0 && (
          <button onClick={() => setShowTz(v => !v)} style={{ background: showTz ? "#27ae60" : "transparent", border: "1px solid #27ae60", color: showTz ? "#fff" : "#27ae60", padding: "4px 11px", cursor: "pointer", fontSize: 11, fontFamily: "monospace", borderRadius: 4 }}>
            📋 ТЗ ({tzCards.length})
          </button>
        )}
        <span style={{ flex: 1 }} />
        {data && !status && (
          <span style={{ display: "flex", gap: 6 }}>
            {tzFail > 0 && <span style={{ fontSize: 10, background: "#e74c3c", color: "#fff", padding: "3px 9px", borderRadius: 10, fontFamily: "monospace" }}>❌ {tzFail} ТЗ</span>}
            {critCount > 0 && <span style={{ fontSize: 10, background: "#e67e22", color: "#fff", padding: "3px 9px", borderRadius: 10, fontFamily: "monospace" }}>🔴 {critCount} крит</span>}
            {mismatches > 0 && <span style={{ fontSize: 10, background: "#9b59b6", color: "#fff", padding: "3px 9px", borderRadius: 10, fontFamily: "monospace" }}>🎨 {mismatches} мат</span>}
          </span>
        )}
        {quality && !status && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: stdCfg.color, background: stdCfg.color + "22", border: `1px solid ${stdCfg.color}44`, padding: "3px 12px", borderRadius: 6, fontFamily: "monospace" }}>{quality.standard}</span>
            <span style={{ fontSize: 13, color: quality.score >= 80 ? "#27ae60" : quality.score >= 55 ? "#e67e22" : "#e74c3c", fontFamily: "monospace", fontWeight: 700 }}>{quality.score}%</span>
          </div>
        )}
        {status && <div style={{ display: "flex", alignItems: "center", gap: 6 }}><div style={{ width: 10, height: 10, border: "1.5px solid #555", borderTop: "1.5px solid #fff", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} /><span style={{ fontSize: 10, color: "#aaa", fontFamily: "monospace" }}>{status}</span></div>}
      </div>

      <div style={{ maxWidth: 1500, margin: "0 auto", padding: "12px" }}>
        {apiError && (
          <div style={{ background: "#fff5f5", border: "2px solid #e74c3c", borderRadius: 10, padding: 14, marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#e74c3c", fontFamily: "monospace" }}>❌ ПОМИЛКА API</div>
            <div style={{ fontSize: 11, color: "#555", fontFamily: "monospace", marginTop: 4, wordBreak: "break-all" }}>{apiError}</div>
          </div>
        )}
        {status && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "80px 0" }}>
            <div style={{ width: 28, height: 28, border: "2px solid #eee", borderTop: "2px solid #1a1a1a", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
            <span style={{ fontSize: 12, color: "#888", fontFamily: "monospace" }}>Аналізую {isRev ? "раунд" : "ракурс"} {num}…</span>
          </div>
        )}

        {!status && data && !apiError && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <VerdictBanner quality={quality} summary={data.summary} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: 12, alignItems: "start" }}>
              {/* LEFT: render image */}
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {(renderFiles || []).length > 1 && (
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {renderFiles.map((f, i) => {
                      const p = f.preview || f.pages?.[0]?.preview;
                      return (
                        <div key={i} onClick={() => setSelR(i)} style={{ width: 52, height: 36, borderRadius: 4, overflow: "hidden", cursor: "pointer", border: `2px solid ${selR === i ? "#27ae60" : "#333"}`, flexShrink: 0 }}>
                          {p && <img src={p} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                        </div>
                      );
                    })}
                  </div>
                )}
                <div style={{ background: "#111", borderRadius: 10, padding: 8 }}>
                  <div style={{ fontSize: 9, color: "#27ae60", fontFamily: "monospace", marginBottom: 6, letterSpacing: "0.1em" }}>
                    РАКУРС {num}{total > 1 ? ` з ${total}` : ""} — {allAnns.filter(a => a.zone && effVisible.has(`${a._src}:${a._srcIdx}`)).length} відміток
                  </div>
                  {activePrev
                    ? <AnnotatedImage src={activePrev} anns={allAnns} visibleIds={effVisible} hovId={hovId} />
                    : <div style={{ height: 260, display: "flex", alignItems: "center", justifyContent: "center", color: "#555", fontFamily: "monospace" }}>немає превью</div>
                  }
                </div>
                {isRev && beforePrev && (
                  <div style={{ background: "#111", borderRadius: 10, padding: 8 }}>
                    <div style={{ fontSize: 9, color: "#888", fontFamily: "monospace", marginBottom: 6, letterSpacing: "0.1em" }}>ВЕРСІЯ ДО</div>
                    <img src={beforePrev} style={{ width: "100%", borderRadius: 6, border: "1px solid #444", opacity: 0.85 }} />
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", paddingLeft: 2 }}>
                  {Object.entries(STATUS).map(([k, v]) => (
                    <div key={k} style={{ display: "flex", alignItems: "center", gap: 3 }}>
                      <div style={{ width: 6, height: 6, background: v.color, borderRadius: "50%" }} />
                      <span style={{ fontSize: 9, color: "#888", fontFamily: "monospace" }}>{v.label}</span>
                    </div>
                  ))}
                  <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                    <div style={{ width: 6, height: 6, background: "#9b59b6", borderRadius: "50%" }} />
                    <span style={{ fontSize: 9, color: "#888", fontFamily: "monospace" }}>Матеріал</span>
                  </div>
                </div>
              </div>

              {/* RIGHT: new tabs panel */}
              <div style={{ background: "#fff", borderRadius: 10, overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,0.07)" }}>
                {/* Row 1 tabs */}
                <TabBar tabs={tabs1} active={tab} onSelect={t => setTab(t)} />
                {/* Row 2: Креслення tab if drawings exist */}
                {hasDrawTab && (
                  <div style={{ borderBottom: "1px solid #f0eeea", padding: "0 14px", background: "#fafaf9", display: "flex", alignItems: "flex-end" }}>
                    <button onClick={() => setTab("drawings")} style={{
                      background: "none", border: "none", padding: "7px 12px 6px",
                      fontSize: 13, fontFamily: "Georgia, serif", cursor: "pointer",
                      color: tab === "drawings" ? "#1a1a1a" : "#aaa",
                      fontWeight: tab === "drawings" ? 600 : 400,
                      borderBottom: tab === "drawings" ? "2px solid #1a1a1a" : "2px solid transparent",
                      marginBottom: -1, display: "flex", alignItems: "center", gap: 6,
                    }}>
                      Креслення
                      <span style={{ background: "#e67e22", color: "#fff", borderRadius: "50%", width: 16, height: 16, fontSize: 9, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "monospace", fontWeight: 700 }}>{drawingCount}</span>
                    </button>
                  </div>
                )}

                {/* Tab content */}
                <div style={{ overflowY: "auto", maxHeight: "calc(100vh - 200px)" }}>

                  {/* CROSS-CHECK */}
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
                        const clickable = r.active && ["ok", "warn", "fail"].includes(r.status) && !!onSverkaOverride;
                        const nextStatus = { ok: "warn", warn: "fail", fail: "ok" }[r.status];
                        const key = `sverka:${r.id}`;
                        return (
                          <div key={r.id} onMouseEnter={() => r.zone && setHovId(key)} onMouseLeave={() => setHovId(null)}
                            style={{ padding: "10px 16px", borderBottom: "1px solid #f0eeea", display: "flex", gap: 10, alignItems: "flex-start", background: hovId === key ? "#faf9f7" : "#fff", opacity: r.active ? 1 : 0.55 }}>
                            <button onClick={clickable ? () => onSverkaOverride(r.id, nextStatus) : undefined}
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

                  {/* ТЗ РОЗБІР */}
                  {tab === "tz_parsed" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                      <div style={{ padding: "10px 16px", background: "#faf9f7", borderBottom: "1px solid #f0eeea" }}>
                        <div style={{ fontSize: 10, color: "#aaa", fontFamily: "monospace" }}>Що Claude зрозуміла з ТЗ / брифу / референсів / креслень</div>
                      </div>
                      {tz_parsed.map((grp, gi) => (
                        <div key={gi} style={{ borderBottom: "1px solid #f0eeea" }}>
                          <div style={{ padding: "8px 16px", background: "#f5f4f1" }}>
                            <span style={{ fontSize: 11, fontWeight: 700, color: "#555", fontFamily: "monospace" }}>{grp.category}</span>
                          </div>
                          {(grp.items || []).map((item, ii) => (
                            <div key={ii} style={{ padding: "7px 16px 7px 28px", borderBottom: "1px solid #faf8f6", display: "flex", alignItems: "flex-start", gap: 8 }}>
                              <span style={{ color: "#27ae60", fontSize: 10, marginTop: 2, flexShrink: 0 }}>•</span>
                              <span style={{ fontSize: 11, color: "#444", lineHeight: 1.5 }}>{item}</span>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* ЗВІТ */}
                  {tab === "report" && (() => {
                    const ALL_CHECKS = [
                      { id: "Q1.1", group: "technical" }, { id: "Q1.2", group: "technical" },
                      { id: "Q1.3", group: "technical" }, { id: "Q1.4", group: "technical" },
                      { id: "Q1.5", group: "technical" }, { id: "Q1.6", group: "technical" },
                      { id: "Q2.1", group: "tz" }, { id: "Q2.2", group: "tz" },
                      { id: "Q2.3", group: "tz" },
                      { id: "Q3.1", group: "geosetting" }, { id: "Q3.2", group: "geosetting" },
                      { id: "Q4.1", group: "client" },
                    ];
                    // Мёрджим то что вернула Claude с дефолтными значениями
                    const checksMap = {};
                    checks.forEach(c => { checksMap[c.id] = c; });
                    const fullChecks = ALL_CHECKS.map(def => checksMap[def.id] || { ...def, status: "skipped", note: "Не перевірено" });
                    // Добавляем Q2.2b если есть
                    if (checksMap["Q2.2b"]) fullChecks.splice(fullChecks.findIndex(c => c.id === "Q2.2") + 1, 0, checksMap["Q2.2b"]);
                    const REPORT_GROUPS = [
                      { id: "technical", label: "Технічні дефекти", icon: "🔧", ids: ["Q1.1","Q1.2","Q1.3","Q1.4","Q1.5","Q1.6"] },
                      { id: "tz",        label: "Відповідність ТЗ", icon: "📋", ids: [] },
                      { id: "materials", label: "Матеріали та світло", icon: "🎨", ids: [] },
                      { id: "geosetting",label: "Геосеттинг",        icon: "🏙️", ids: ["Q3.1","Q3.2"] },
                      { id: "client",    label: "Вимоги клієнта",    icon: "✅", ids: ["Q4.1"] },
                    ];
                    const ST = {
                      ok:      { icon: "✅", color: "#27ae60", bg: "#f0faf5" },
                      warn:    { icon: "⚠️", color: "#e67e22", bg: "#fff8f0" },
                      fail:    { icon: "❌", color: "#e74c3c", bg: "#fff5f5" },
                      skipped: { icon: "—",  color: "#bbb",    bg: "#fafafa" },
                    };
                    const grouped = {};
                    fullChecks.forEach(c => {
                      const g = c.group || "technical";
                      if (!grouped[g]) grouped[g] = [];
                      grouped[g].push(c);
                    });
                    return (
                      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                        {REPORT_GROUPS.map(grp => {
                          const items2 = grouped[grp.id] || [];
                          if (!items2.length) return null;
                          const failCnt = items2.filter(c => c.status === "fail").length;
                          const warnCnt = items2.filter(c => c.status === "warn").length;
                          return (
                            <div key={grp.id} style={{ borderBottom: "2px solid #f0eeea" }}>
                              <div style={{ padding: "9px 16px", background: "#faf9f7", display: "flex", alignItems: "center", gap: 8 }}>
                                <span style={{ fontSize: 13 }}>{grp.icon}</span>
                                <span style={{ fontSize: 12, fontWeight: 700, color: "#333", fontFamily: "monospace", flex: 1 }}>{grp.label}</span>
                                {failCnt > 0 && <span style={{ fontSize: 9, background: "#e74c3c", color: "#fff", padding: "1px 6px", borderRadius: 8, fontFamily: "monospace" }}>{failCnt} ❌</span>}
                                {warnCnt > 0 && <span style={{ fontSize: 9, background: "#e67e22", color: "#fff", padding: "1px 6px", borderRadius: 8, fontFamily: "monospace" }}>{warnCnt} ⚠️</span>}
                              </div>
                              {items2.map((c, i) => {
                                const st = ST[c.status] || ST.skipped;
                                const qcfg = QA_CHECKS.find(q => q.id === c.id.replace(/[ab]$/, ""));
                                return (
                                  <div key={i} style={{ padding: "9px 16px", borderBottom: "1px solid #f5f3ef", background: st.bg, display: "flex", gap: 10, alignItems: "flex-start" }}>
                                    <span style={{ fontSize: 14, lineHeight: 1, marginTop: 1, flexShrink: 0 }}>{st.icon}</span>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                      <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 3, flexWrap: "wrap" }}>
                                        <span style={{ fontSize: 9, fontFamily: "monospace", fontWeight: 700, color: qcfg?.color || st.color, background: (qcfg?.color || st.color) + "18", padding: "1px 5px", borderRadius: 3 }}>{c.id}</span>
                                        {qcfg && <span style={{ fontSize: 11, fontWeight: 600, color: "#444" }}>{qcfg.label}</span>}
                                      </div>
                                      <div style={{ fontSize: 11, color: c.status === "skipped" ? "#bbb" : "#555", lineHeight: 1.5 }}>{c.note}</div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}

                  {/* ЗАКЛЮЧЕННЯ */}
                  {tab === "overview" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 14 }}>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7 }}>
                        {[
                          { label: "ТЗ виконано", val: `${tzOk}/${items.length}`, col: "#27ae60" },
                          { label: "Не виконано", val: tzFail, col: "#e74c3c" },
                          { label: "Крит. дефектів", val: critCount, col: "#e67e22" },
                          { label: "Матер. невідпов.", val: mismatches, col: "#9b59b6" },
                        ].map((s, i) => (
                          <div key={i} style={{ background: "#faf9f7", border: `1px solid ${s.col}22`, borderLeft: `3px solid ${s.col}`, borderRadius: "0 6px 6px 0", padding: "7px 10px" }}>
                            <div style={{ fontSize: 9, color: "#aaa", fontFamily: "monospace" }}>{s.label}</div>
                            <div style={{ fontSize: 18, fontWeight: 700, color: s.col, fontFamily: "monospace", lineHeight: 1.2 }}>{s.val}</div>
                          </div>
                        ))}
                      </div>
                      <Verdict quality={quality} />
                    </div>
                  )}

                  {/* ТЗ */}
                  {tab === "tz" && (
                    <div style={{ display: "flex", flexDirection: "column" }}>
                      {items.map((item, i) => {
                        const st = STATUS[item.status] || STATUS.partial;
                        const key = `item:${i}`;
                        const vis = effVisible.has(key);
                        const isIrrel = irrelevant.has(key);
                        return (
                          <div key={i} onMouseEnter={() => setHovId(key)} onMouseLeave={() => setHovId(null)}
                            style={{ padding: "11px 16px", borderBottom: "1px solid #f0eeea", background: isIrrel ? "#f5f4f1" : hovId === key ? "#faf9f7" : "#fff", display: "flex", gap: 10, alignItems: "flex-start", opacity: isIrrel ? 0.55 : 1, transition: "opacity 0.15s" }}>
                            <div onClick={() => handleToggle(key, !vis)} style={{ cursor: "pointer", width: 22, height: 22, borderRadius: "50%", background: isIrrel ? "#ccc" : st.color, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, fontFamily: "monospace", flexShrink: 0, marginTop: 1 }}>{i + 1}</div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: isIrrel ? "#aaa" : st.color, fontFamily: "monospace", lineHeight: 1.4, marginBottom: 2, textDecoration: isIrrel ? "line-through" : "none" }}>{item.comment}</div>
                              {item.note && !isIrrel && <div style={{ fontSize: 11, color: "#999", lineHeight: 1.5 }}>{item.note}</div>}
                            </div>
                            <button onClick={() => toggleIrrelevant(key)} title="Відмітити як нерелевантне" style={{ background: isIrrel ? "#e8e4de" : "transparent", border: `1px solid ${isIrrel ? "#bbb" : "#e0ddd8"}`, color: isIrrel ? "#888" : "#ccc", borderRadius: 5, padding: "3px 7px", cursor: "pointer", fontSize: 10, fontFamily: "monospace", flexShrink: 0, transition: "all 0.15s" }}>
                              {isIrrel ? "✕" : "⊘"}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* ПРАВКИ */}
                  {tab === "corr" && (
                    <div style={{ display: "flex", flexDirection: "column" }}>
                      {corr.map((c, i) => {
                        const key = `corr:${i}`;
                        const vis = effVisible.has(key);
                        const isIrrel = irrelevant.has(key);
                        const priCol = c.priority === "high" ? "#e74c3c" : c.priority === "medium" ? "#e67e22" : "#3498db";
                        return (
                          <div key={i} onMouseEnter={() => setHovId(key)} onMouseLeave={() => setHovId(null)}
                            style={{ padding: "11px 16px", borderBottom: "1px solid #f0eeea", background: isIrrel ? "#f5f4f1" : hovId === key ? "#faf9f7" : "#fff", display: "flex", gap: 10, alignItems: "flex-start", opacity: isIrrel ? 0.55 : 1, transition: "opacity 0.15s" }}>
                            <div onClick={() => handleToggle(key, !vis)} style={{ cursor: "pointer", width: 22, height: 22, borderRadius: "50%", background: isIrrel ? "#ccc" : priCol, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, fontFamily: "monospace", flexShrink: 0, marginTop: 1 }}>{i + 1}</div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: isIrrel ? "#aaa" : "#333", lineHeight: 1.4, marginBottom: 2, textDecoration: isIrrel ? "line-through" : "none" }}>{c.title}</div>
                              {c.description && !isIrrel && <div style={{ fontSize: 11, color: "#999", lineHeight: 1.5 }}>{c.description}</div>}
                            </div>
                            <button onClick={() => toggleIrrelevant(key)} title="Відмітити як нерелевантне" style={{ background: isIrrel ? "#e8e4de" : "transparent", border: `1px solid ${isIrrel ? "#bbb" : "#e0ddd8"}`, color: isIrrel ? "#888" : "#ccc", borderRadius: 5, padding: "3px 7px", cursor: "pointer", fontSize: 10, fontFamily: "monospace", flexShrink: 0, transition: "all 0.15s" }}>
                              {isIrrel ? "✕" : "⊘"}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* ДЕФЕКТИ */}
                  {tab === "defects" && (
                    <div style={{ display: "flex", flexDirection: "column" }}>
                      {defects.map((d, i) => {
                        const key = `defect:${i}`;
                        const vis = effVisible.has(key);
                        const isIrrel = irrelevant.has(key);
                        const sevCol = d.severity === "high" ? "#e74c3c" : d.severity === "medium" ? "#e67e22" : "#3498db";
                        const qCol = d.qa_tag ? QC[d.qa_tag] || "#888" : "#888";
                        return (
                          <div key={i} onMouseEnter={() => setHovId(key)} onMouseLeave={() => setHovId(null)}
                            style={{ padding: "11px 16px", borderBottom: "1px solid #f0eeea", background: isIrrel ? "#f5f4f1" : hovId === key ? "#faf9f7" : "#fff", display: "flex", gap: 10, alignItems: "flex-start", opacity: isIrrel ? 0.55 : 1, transition: "opacity 0.15s" }}>
                            <div onClick={() => handleToggle(key, !vis)} style={{ cursor: "pointer", width: 22, height: 22, borderRadius: "50%", background: isIrrel ? "#ccc" : sevCol, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, fontFamily: "monospace", flexShrink: 0, marginTop: 1 }}>{i + 1}</div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: "flex", gap: 5, alignItems: "center", marginBottom: 2, flexWrap: "wrap" }}>
                                <span style={{ fontSize: 12, fontWeight: 600, color: isIrrel ? "#aaa" : "#333", lineHeight: 1.4, textDecoration: isIrrel ? "line-through" : "none" }}>{d.title}</span>
                                {d.qa_tag && !isIrrel && <span style={{ fontSize: 9, color: qCol, background: qCol + "18", padding: "1px 5px", borderRadius: 3, fontFamily: "monospace", fontWeight: 700 }}>{d.qa_tag}</span>}
                              </div>
                              {d.description && !isIrrel && <div style={{ fontSize: 11, color: "#999", lineHeight: 1.5 }}>{d.description}</div>}
                            </div>
                            <button onClick={() => toggleIrrelevant(key)} title="Відмітити як нерелевантне" style={{ background: isIrrel ? "#e8e4de" : "transparent", border: `1px solid ${isIrrel ? "#bbb" : "#e0ddd8"}`, color: isIrrel ? "#888" : "#ccc", borderRadius: 5, padding: "3px 7px", cursor: "pointer", fontSize: 10, fontFamily: "monospace", flexShrink: 0, transition: "all 0.15s" }}>
                              {isIrrel ? "✕" : "⊘"}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* МАТЕРІАЛИ */}
                  {tab === "materials" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "10px 14px", borderBottom: "1px solid #f0eeea" }}>
                        {Object.entries(MAT_STATUS).map(([k, v]) => {
                          const cnt = materials.filter(m => m.status === k).length;
                          if (!cnt) return null;
                          return (
                            <div key={k} style={{ background: v.bg, border: `1px solid ${v.color}33`, borderRadius: 6, padding: "3px 8px", display: "flex", gap: 4, alignItems: "center" }}>
                              <span style={{ fontSize: 10 }}>{v.icon}</span>
                              <span style={{ fontSize: 11, fontFamily: "monospace", color: v.color, fontWeight: 700 }}>{cnt}</span>
                              <span style={{ fontSize: 9, fontFamily: "monospace", color: "#888" }}>{v.label}</span>
                            </div>
                          );
                        })}
                      </div>
                      {materials.map((m, i) => {
                        const cfg = MAT_STATUS[m.status] || MAT_STATUS.unknown;
                        const key = `material:${i}`;
                        return (
                          <div key={i} onMouseEnter={() => setHovId(key)} onMouseLeave={() => setHovId(null)}
                            style={{ padding: "11px 16px", borderBottom: "1px solid #f0eeea", cursor: "default", background: hovId === key ? "#faf9f7" : "#fff" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 3 }}>
                              <span style={{ fontSize: 12, fontWeight: 600, color: "#333", fontFamily: "monospace" }}>{m.name}</span>
                              {m.group && <span style={{ fontSize: 9, background: "#f0eeea", color: "#888", padding: "1px 5px", borderRadius: 3, fontFamily: "monospace" }}>{m.group}</span>}
                              {m.spec && <span style={{ fontSize: 9, background: "#e8f4fb", color: "#2980b9", padding: "1px 5px", borderRadius: 3, fontFamily: "monospace" }}>{m.spec}</span>}
                              <span style={{ fontSize: 9, background: cfg.bg, color: cfg.color, padding: "1px 5px", borderRadius: 3, fontFamily: "monospace", fontWeight: 700, marginLeft: "auto" }}>{cfg.icon} {cfg.label}</span>
                            </div>
                            {m.note && <div style={{ fontSize: 10, color: "#777", fontFamily: "monospace" }}>{m.note}</div>}
                            {m.expected && m.status !== "match" && <div style={{ fontSize: 10, color: "#aaa", fontFamily: "monospace", marginTop: 2 }}>Очікувалось: {m.expected}</div>}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* КРЕСЛЕННЯ */}
                  {tab === "drawings" && (
                    <div style={{ padding: 14 }}>
                      <BlueprintPanel drawings={drawings} anns={allAnns} visibleIds={effVisible} hovId={hovId} />
                    </div>
                  )}

                </div>

                {/* FLOATING BAR — з'являється коли є нерелевантні */}
                {irrelevant.size > 0 && (
                  <div style={{ borderTop: "2px solid #e8e4de", background: "#faf8f5", padding: "10px 16px", display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ flex: 1 }}>
                      <span style={{ fontSize: 11, color: "#888", fontFamily: "monospace" }}>
                        Відмічено як нерелевантне: <strong style={{ color: "#555" }}>{irrelevant.size}</strong>
                      </span>
                      <button onClick={() => setIrrelevant(new Set())} style={{ background: "none", border: "none", color: "#bbb", cursor: "pointer", fontSize: 10, fontFamily: "monospace", marginLeft: 8 }}>скинути</button>
                    </div>
                    <button onClick={handleReview} disabled={reviewing || !onReview} style={{ background: reviewing ? "#ccc" : "#1a1a1a", border: "none", color: "#fff", borderRadius: 7, padding: "8px 16px", cursor: reviewing ? "default" : "pointer", fontSize: 11, fontFamily: "monospace", fontWeight: 600, whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 6 }}>
                      {reviewing
                        ? <><div style={{ width: 10, height: 10, border: "1.5px solid #fff", borderTop: "1.5px solid transparent", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} /> Аналізую…</>
                        : "↺ Переглянути рендер"
                      }
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── TZ Drawer ──────────────────────────────────────────────────────── */}
      {showTz && (
        <div onClick={() => setShowTz(false)} style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,0.45)" }}>
          <div onClick={e => e.stopPropagation()} style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: 400, background: "#fff", overflowY: "auto", boxShadow: "-4px 0 32px rgba(0,0,0,0.18)", display: "flex", flexDirection: "column" }}>
            {/* Header */}
            <div style={{ padding: "11px 16px", background: "#1a1a1a", display: "flex", alignItems: "center", gap: 10, position: "sticky", top: 0, zIndex: 1, flexShrink: 0 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#f2f0ec", fontFamily: "monospace", flex: 1 }}>📋 ТЗ — {tzCards.length} пунктів</span>
              <button onClick={() => setShowTz(false)} style={{ background: "none", border: "1px solid #555", color: "#aaa", borderRadius: 4, padding: "3px 9px", cursor: "pointer", fontSize: 10, fontFamily: "monospace" }}>✕</button>
            </div>

            {/* Project annotation */}
            {tzAnnotation && (
              <div style={{ padding: "10px 14px", borderBottom: "1px solid #f0eeea", background: "#faf9f7", flexShrink: 0 }}>
                <div style={{ fontSize: 9, color: "#aaa", fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: 5 }}>ОПИС ПРОЕКТУ</div>
                <div style={{ fontSize: 11, color: "#444", lineHeight: 1.65, fontFamily: "monospace" }}>{tzAnnotation}</div>
              </div>
            )}

            {/* TZ cards grouped */}
            {Object.entries(tzCards.reduce((acc, c) => { if (!acc[c.category]) acc[c.category] = []; acc[c.category].push(c); return acc; }, {})).map(([cat, items]) => (
              <div key={cat} style={{ borderBottom: "1px solid #f0eeea", flexShrink: 0 }}>
                <div style={{ padding: "7px 14px", background: "#f5f4f1", display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: "#555", fontFamily: "monospace", flex: 1 }}>{cat.toUpperCase()}</span>
                  <span style={{ fontSize: 9, color: "#ccc", fontFamily: "monospace" }}>{items.length}</span>
                </div>
                {items.map((item, i) => (
                  <div key={i} style={{ padding: "8px 14px 8px 20px", borderBottom: "1px solid #faf8f6", display: "flex", alignItems: "flex-start", gap: 7 }}>
                    <span style={{ color: "#27ae60", fontSize: 10, marginTop: 3, flexShrink: 0 }}>•</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 11, color: "#333", lineHeight: 1.55 }}>{item.text}</div>
                      {item.source && <div style={{ fontSize: 9, color: "#ccc", fontFamily: "monospace", marginTop: 1 }}>[{item.source}]</div>}
                    </div>
                  </div>
                ))}
              </div>
            ))}

            {/* Client comments */}
            {tzClientComments.length > 0 && (
              <div style={{ flexShrink: 0 }}>
                <div style={{ padding: "7px 14px", background: "#f5f4f1", borderBottom: "1px solid #f0eeea" }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: "#555", fontFamily: "monospace" }}>💬 КОМЕНТАРІ КЛІЄНТА</span>
                </div>
                {Object.entries(tzClientComments.reduce((acc, item) => { (acc[item.page] = acc[item.page] || []).push(item.text); return acc; }, {})).map(([page, texts], gi) => {
                  const lines = texts.flatMap(t => t.split(/\n/).map(l => l.replace(/^[•\-–—]\s*/, "").trim()).filter(l => l.length > 0));
                  return (
                    <div key={gi} style={{ padding: "9px 14px", borderBottom: "1px solid #f5f3ef" }}>
                      <div style={{ fontSize: 9, color: "#aaa", fontFamily: "monospace", letterSpacing: "0.08em", marginBottom: 5 }}>{page}</div>
                      {lines.map((line, li) => (
                        <div key={li} style={{ display: "flex", gap: 7, alignItems: "flex-start", marginBottom: 3 }}>
                          <span style={{ color: "#bbb", fontSize: 11, flexShrink: 0, marginTop: 2 }}>—</span>
                          <span style={{ fontSize: 11, color: "#333", lineHeight: 1.55, fontFamily: "monospace" }}>{line}</span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── TZ Review Step ───────────────────────────────────────────────────────────
const CATEGORY_ICONS = {
  "Матеріали та текстури": "🎨", "Меблі та моделі": "🛋️", "Сезон / атмосфера": "🌿",
  "Тип освітлення": "💡", "Креслення та планування": "📐", "Логотип / написи": "🔤",
  "Вимоги клієнта": "📋", "Специфічні запити": "⭐",
};
function TzReviewStep({ cards, onRemove, onEdit, onBack, onProceed, hasRenders, annotation, clientComments, onSavePdf, onUseInCheck }) {
  const grouped = {};
  cards.forEach(c => { if (!grouped[c.category]) grouped[c.category] = []; grouped[c.category].push(c); });
  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "22px 24px", display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <div style={{ fontSize: 10, letterSpacing: "0.14em", color: "#888", fontFamily: "monospace", marginBottom: 4 }}>КРОК 2 — ПІДТВЕРДЖЕННЯ ТЗ</div>
        <div style={{ fontSize: 16, fontWeight: 400, letterSpacing: "0.05em", color: "#1a1a1a", marginBottom: 4 }}>Перевір пункти ТЗ</div>
        <div style={{ fontSize: 11, color: "#888", fontFamily: "monospace" }}>
          Claude розпізнала <strong style={{ color: "#333" }}>{cards.length}</strong> пунктів ТЗ. Редагуй або видаляй — решта стануть чеклистом для перевірки рендеру.
        </div>
      </div>
      {annotation && (
        <div style={{ background: "#f8f7f4", border: "1px solid #e8e6e1", borderRadius: 10, padding: "12px 16px" }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: "#aaa", fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: 6 }}>ОПИС ПРОЕКТУ</div>
          <div style={{ fontSize: 12, color: "#444", lineHeight: 1.65 }}>{annotation}</div>
        </div>
      )}
      {clientComments?.length > 0 && (
        <div style={{ background: "#fff", border: "1px solid #e8e6e1", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: "8px 14px", background: "#faf9f7", borderBottom: "1px solid #f0eeea", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13 }}>💬</span>
            <span style={{ fontSize: 10, fontWeight: 700, color: "#555", fontFamily: "monospace", letterSpacing: "0.1em" }}>КОМЕНТАРІ КЛІЄНТА</span>
            <span style={{ fontSize: 9, color: "#ccc", fontFamily: "monospace", marginLeft: "auto" }}>{clientComments.length}</span>
          </div>
          <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
            {Object.entries(clientComments.reduce((acc, item) => { (acc[item.page] = acc[item.page] || []).push(item.text); return acc; }, {})).map(([page, texts], gi) => {
              const lines = texts.flatMap(t => t.split(/\n/).map(l => l.replace(/^[•\-–—]\s*/, "").trim()).filter(l => l.length > 0));
              return (
                <div key={gi} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ fontSize: 9, color: "#aaa", fontFamily: "monospace", letterSpacing: "0.08em", borderBottom: "1px solid #f0eeea", paddingBottom: 4 }}>{page}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    {lines.map((line, li) => (
                      <div key={li} style={{ display: "flex", gap: 7, alignItems: "flex-start" }}>
                        <span style={{ color: "#bbb", fontSize: 11, flexShrink: 0, marginTop: 2 }}>—</span>
                        <span style={{ fontSize: 12, fontFamily: "monospace", color: "#333", lineHeight: 1.6 }}>{line}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {cards.length === 0 && (
        <div style={{ background: "#fff9f0", border: "1px solid #e67e2244", borderRadius: 8, padding: "12px 16px", fontSize: 12, color: "#e67e22", fontFamily: "monospace" }}>
          ⚠️ Пункти ТЗ не розпізнані — бриф порожній або не завантажений. Claude перевірить рендер самостійно.
        </div>
      )}
      {Object.entries(grouped).map(([category, items]) => (
        <div key={category} style={{ background: "#fff", border: "1px solid #e8e6e1", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: "8px 14px", background: "#faf9f7", borderBottom: "1px solid #f0eeea", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 14 }}>{CATEGORY_ICONS[category] || "📌"}</span>
            <span style={{ fontSize: 10, fontWeight: 700, color: "#555", fontFamily: "monospace", letterSpacing: "0.1em", flex: 1 }}>{category.toUpperCase()}</span>
            <span style={{ fontSize: 9, color: "#ccc", fontFamily: "monospace" }}>{items.length}</span>
          </div>
          {items.map(item => (
            <div key={item.id} style={{ padding: "8px 14px", borderBottom: "1px solid #faf8f6", display: "flex", alignItems: "flex-start", gap: 10 }}>
              {item.imgPreview && (
                <img
                  src={item.imgPreview}
                  title={item.source}
                  style={{ width: 72, height: 52, objectFit: "cover", borderRadius: 5, border: "1px solid #e0ddd8", flexShrink: 0, marginTop: 2, cursor: "pointer" }}
                  onClick={() => window.open(item.imgPreview, "_blank")}
                />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <textarea
                  value={item.text}
                  onChange={e => onEdit(item.id, e.target.value)}
                  rows={Math.max(2, Math.ceil(item.text.length / 60))}
                  style={{ width: "100%", border: "none", background: "transparent", fontSize: 12, color: "#333", lineHeight: 1.55, fontFamily: "inherit", resize: "vertical", outline: "none", padding: 0, cursor: "text" }}
                />
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
                  {item.source && <div style={{ fontSize: 9, color: "#ccc", fontFamily: "monospace" }}>[{item.source}]</div>}
                  {item.link && <a href={item.link} target="_blank" rel="noreferrer" style={{ fontSize: 9, color: "#3498db", fontFamily: "monospace", textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 180 }} title={item.link}>🔗 {item.link.replace(/^https?:\/\//, "")}</a>}
                </div>
              </div>
              <button onClick={() => onRemove(item.id)} style={{ background: "none", border: "1px solid #e0ddd8", color: "#ccc", borderRadius: 4, padding: "2px 8px", cursor: "pointer", fontSize: 10, fontFamily: "monospace", flexShrink: 0, lineHeight: 1.4, marginTop: 2 }}>✕</button>
            </div>
          ))}
        </div>
      ))}
{!onUseInCheck && !hasRenders && (
        <div style={{ background: "#fff5f5", border: "1px solid #e74c3c44", borderRadius: 8, padding: "10px 14px", fontSize: 11, color: "#e74c3c", fontFamily: "monospace" }}>
          ⚠️ Рендери не завантажені. Поверніться назад та додайте рендери для аналізу.
        </div>
      )}
      <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
        <button onClick={onBack} style={{ background: "transparent", border: "1px solid #ddd", color: "#888", padding: "12px 20px", cursor: "pointer", fontSize: 11, fontFamily: "monospace", borderRadius: 8 }}>← Назад</button>
        <button onClick={onSavePdf} style={{ background: "transparent", border: "1px solid #27ae60", color: "#27ae60", padding: "12px 16px", cursor: "pointer", fontSize: 11, fontFamily: "monospace", borderRadius: 8 }}>📄 PDF</button>
        {onUseInCheck
          ? <button onClick={onUseInCheck} style={{ flex: 1, background: "#1a1a1a", color: "#f2f0ec", border: "none", padding: "14px", fontSize: 12, letterSpacing: "0.14em", fontFamily: "monospace", cursor: "pointer", borderRadius: 8 }}>
              {cards.length > 0 ? `ВИКОРИСТАТИ ПРИ ПЕРЕВІРЦІ (${cards.length} пунктів) →` : "ВИКОРИСТАТИ ПРИ ПЕРЕВІРЦІ →"}
            </button>
          : <button onClick={onProceed} disabled={!hasRenders} style={{ flex: 1, background: hasRenders ? "#1a1a1a" : "#ccc", color: "#f2f0ec", border: "none", padding: "14px", fontSize: 12, letterSpacing: "0.14em", fontFamily: "monospace", cursor: hasRenders ? "pointer" : "not-allowed", borderRadius: 8 }}>
              {cards.length > 0 ? `АНАЛІЗУВАТИ РЕНДЕРИ (${cards.length} пунктів ТЗ) →` : "АНАЛІЗУВАТИ РЕНДЕРИ →"}
            </button>
        }
      </div>
    </div>
  );
}

// ─── Grid card ────────────────────────────────────────────────────────────────
function GridCard({ item, data, status, idx, isRev, onSelect }) {
  const q = data?.quality;
  const key = q?.standard?.startsWith("SDC") ? "SDC" : q?.standard?.startsWith("MLR") ? "MLR" : "NON";
  const qcfg = q ? STANDARDS[key] : null;
  const critC = (data?.defects || []).filter(d => d.severity === "high").length;
  const notFixC = (data?.items || []).filter(x => x.status === "not_fixed").length;
  const matC = (data?.materials || []).filter(m => m.status === "mismatch" || m.status === "missing").length;
  const renderFiles = isRev ? (item.afters || []).filter(f => !f._loading && !f._error) : [item];
  const beforeFiles = isRev ? (item.befores || []).filter(f => !f._loading && !f._error) : [];
  const thumbBefore = beforeFiles[0]?.preview || beforeFiles[0]?.pages?.[0]?.preview;
  const thumbAfter = renderFiles[0]?.preview || renderFiles[0]?.pages?.[0]?.preview;
  const thumbSingle = item?.preview || item?.pages?.[0]?.preview;
  const scoreColor = q ? (q.score >= 80 ? "#27ae60" : q.score >= 55 ? "#e67e22" : "#e74c3c") : "#aaa";

  return (
    <div onClick={status ? undefined : onSelect}
      style={{ background: "#fff", border: "1px solid #e8e6e1", borderRadius: 12, overflow: "hidden", cursor: status ? "default" : "pointer", transition: "all 0.18s", boxShadow: "0 2px 8px rgba(0,0,0,0.05)", opacity: status ? 0.85 : 1 }}
      onMouseEnter={e => { if (status) return; e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 8px 24px rgba(0,0,0,0.1)"; }}
      onMouseLeave={e => { e.currentTarget.style.transform = ""; e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,0,0,0.05)"; }}>
      {isRev ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", background: "#111", minHeight: 90, gap: 1, position: "relative" }}>
          <div style={{ position: "relative" }}>
            <div style={{ fontSize: 8, color: "#888", fontFamily: "monospace", padding: "2px 4px", background: "rgba(0,0,0,0.5)", position: "absolute", top: 0, left: 0, zIndex: 1 }}>ДО</div>
            {thumbBefore ? <img src={thumbBefore} style={{ width: "100%", height: 90, objectFit: "cover" }} /> : <div style={{ height: 90, background: "#222" }} />}
          </div>
          <div style={{ position: "relative" }}>
            <div style={{ fontSize: 8, color: "#27ae60", fontFamily: "monospace", padding: "2px 4px", background: "rgba(0,0,0,0.5)", position: "absolute", top: 0, left: 0, zIndex: 1 }}>ПІСЛЯ</div>
            {thumbAfter ? <img src={thumbAfter} style={{ width: "100%", height: 90, objectFit: "cover" }} /> : <div style={{ height: 90, background: "#222" }} />}
          </div>
          {status && (
            <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6 }}>
              <div style={{ width: 20, height: 20, border: "2px solid #fff", borderTop: "2px solid transparent", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
              <span style={{ fontSize: 10, color: "#fff", fontFamily: "monospace" }}>{status}</span>
            </div>
          )}
          {q && !status && <div style={{ position: "absolute", top: 4, right: 4, background: qcfg.color, color: "#fff", padding: "2px 7px", borderRadius: 4, fontSize: 11, fontWeight: 700, fontFamily: "monospace" }}>{q.standard}</div>}
        </div>
      ) : (
        <div style={{ position: "relative", background: "#111", aspectRatio: "16/10", overflow: "hidden" }}>
          {thumbSingle
            ? <img src={thumbSingle} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            : <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#444", fontFamily: "monospace", fontSize: 11 }}>немає превью</div>
          }
          {status && (
            <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6 }}>
              <div style={{ width: 20, height: 20, border: "2px solid #fff", borderTop: "2px solid transparent", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
              <span style={{ fontSize: 10, color: "#fff", fontFamily: "monospace" }}>{status}</span>
            </div>
          )}
          {q && !status && <div style={{ position: "absolute", top: 8, right: 8, background: qcfg.color, color: "#fff", padding: "3px 10px", borderRadius: 6, fontSize: 12, fontWeight: 700, fontFamily: "monospace" }}>{q.standard}</div>}
        </div>
      )}
      <div style={{ padding: "10px 12px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <span style={{ fontSize: 11, fontFamily: "monospace", color: "#555", fontWeight: 600 }}>{isRev ? "Раунд" : "Ракурс"} {idx + 1}</span>
          {q && !status && <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: scoreColor, fontFamily: "monospace" }}>{q.score}%</span>
            {q.tz_score != null && <span style={{ fontSize: 10, fontWeight: 600, color: q.tz_score >= 80 ? "#27ae60" : q.tz_score >= 55 ? "#e67e22" : "#e74c3c", fontFamily: "monospace", background: "#f5f4f1", padding: "1px 5px", borderRadius: 3 }}>ТЗ {q.tz_score}%</span>}
          </div>}
        </div>
        {q && !status && <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 7 }}>
          <div style={{ height: 3, background: "#eee", borderRadius: 2, overflow: "hidden" }}><div style={{ height: "100%", width: `${q.score}%`, background: scoreColor, borderRadius: 2 }} /></div>
          {q.tz_score != null && <div style={{ height: 2, background: "#eee", borderRadius: 2, overflow: "hidden" }}><div style={{ height: "100%", width: `${q.tz_score}%`, background: q.tz_score >= 80 ? "#27ae60" : q.tz_score >= 55 ? "#e67e22" : "#e74c3c", borderRadius: 2 }} /></div>}
        </div>}
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {notFixC > 0 && <span style={{ fontSize: 9, background: "#e74c3c", color: "#fff", padding: "1px 6px", borderRadius: 3, fontFamily: "monospace" }}>❌ {notFixC}</span>}
          {critC > 0 && <span style={{ fontSize: 9, background: "#e67e22", color: "#fff", padding: "1px 6px", borderRadius: 3, fontFamily: "monospace" }}>🔴 {critC}</span>}
          {matC > 0 && <span style={{ fontSize: 9, background: "#9b59b6", color: "#fff", padding: "1px 6px", borderRadius: 3, fontFamily: "monospace" }}>🎨 {matC}</span>}
        </div>
        <div style={{ marginTop: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          {data?.error && !status
            ? <span style={{ fontSize: 10, color: "#e74c3c", fontFamily: "monospace" }}>Натисніть для деталей</span>
            : <span />
          }
          <span style={{ fontSize: 10, color: "#3498db", fontFamily: "monospace" }}>Відкрити →</span>
        </div>
      </div>
    </div>
  );
}

function Grid({ items, perData, statuses, globalSummary, onSelect, onRetry, mode }) {
  const isRev = mode === "revision";
  const errorCount = (perData || []).filter(d => d?.error).length;
  return (
    <div style={{ maxWidth: 1300, margin: "0 auto", padding: "20px 16px" }}>
      {globalSummary && (
        <div style={{ background: "#fff", border: "1px solid #e8e6e1", borderRadius: 10, padding: "12px 18px", marginBottom: 20, fontSize: 12, color: "#555", fontFamily: "monospace", lineHeight: 1.6 }}>
          <span style={{ fontSize: 10, color: "#aaa", marginRight: 8 }}>ЗАГАЛЬНА ОЦІНКА</span>{globalSummary}
        </div>
      )}
      {errorCount > 0 && onRetry && (
        <div style={{ background: "#fff5f5", border: "1px solid #e74c3c44", borderRadius: 8, padding: "10px 16px", marginBottom: 14, display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 11, color: "#e74c3c", fontFamily: "monospace" }}>❌ {errorCount} {isRev ? "раундів" : "ракурсів"} не вдалось проаналізувати</span>
          <button onClick={onRetry} style={{ background: "#e74c3c", border: "none", color: "#fff", borderRadius: 6, padding: "5px 14px", cursor: "pointer", fontSize: 11, fontFamily: "monospace" }}>
            ↺ Повторити
          </button>
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(240px,1fr))", gap: 14 }}>
        {items.map((item, i) => (
          <GridCard key={i} item={item} data={perData[i]} status={statuses[i]} idx={i} isRev={isRev} onSelect={() => onSelect(i)} />
        ))}
      </div>
    </div>
  );
}

// ─── Upload box ───────────────────────────────────────────────────────────────
function UploadBox({ label, files, onAdd, onAddDone, onRemove, color = "#888", note, onTag, onDocType }) {
  const inputRef = useRef(); const [drag, setDrag] = useState(false); const ctr = useRef(0);
  const onDrop = e => {
    e.preventDefault(); setDrag(false); ctr.current = 0;
    if (_dragging) {
      onAddDone?.(_dragging.file);
      _dragging.remove();
      _dragging = null;
    } else {
      Array.from(e.dataTransfer.files).forEach(onAdd);
    }
  };
  const ico = { pdf: "📄", dwg: "⚠️", dxf: "📐", excel: "📊", text: "📝", image: "🖼️", other: "📎" };
  return (
    <div>
      {label && <div style={{ fontSize: 10, letterSpacing: "0.14em", color: "#888", marginBottom: note ? 2 : 5, fontFamily: "monospace" }}>{label}</div>}
      {note && <div style={{ fontSize: 9, color: "#bbb", fontFamily: "monospace", marginBottom: 5 }}>{note}</div>}
      <div onDragEnter={e => { e.preventDefault(); ctr.current++; setDrag(true); }} onDragLeave={e => { e.preventDefault(); if (--ctr.current === 0) setDrag(false); }} onDragOver={e => e.preventDefault()} onDrop={onDrop}
        style={{ border: `2px dashed ${drag ? color : "#ddd"}`, borderRadius: 10, padding: 8, background: drag ? color + "11" : "#fafafa", minHeight: 90, display: "flex", flexDirection: "column", justifyContent: files.length === 0 ? "center" : "flex-start" }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", justifyContent: files.length === 0 ? "center" : "flex-start" }}>
          {files.map((f, i) => {
            const prev = f.preview || f.pages?.[0]?.preview;
            return (
              <div key={f._id || i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, flexShrink: 0 }}>
            <div draggable={!f._loading && f._done} onDragStart={() => { _dragging = { file: f, remove: () => onRemove(i) }; }} onDragEnd={() => { _dragging = null; }} style={{ position: "relative", width: 70, height: 70, cursor: (!f._loading && f._done) ? "grab" : "default" }}>
                {prev && f.type !== "excel"
                  ? <img src={prev} style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 5, border: `1px solid ${f._error ? "#e74c3c" : f._done ? color : "#ddd"}`, filter: f._loading ? "brightness(0.4)" : "none" }} />
                  : <div style={{ width: "100%", height: "100%", borderRadius: 5, border: `1px solid ${f._error ? "#e74c3c" : f._done ? color : "#ddd"}`, background: f._error ? "#3a1a1a" : f.type === "dwg" ? "#0a1929" : f.type === "excel" ? "#0d2b0d" : "#f0eeea", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2 }}>
                    <div style={{ fontSize: 18 }}>{f._error ? "⚠️" : ico[f.type] || ico.other}</div>
                    <div style={{ fontSize: 7, color: f._error ? "#ff8888" : "#888", fontFamily: "monospace", textAlign: "center", padding: "0 3px", wordBreak: "break-all", lineHeight: 1.2 }}>{f._error ? "ERR" : (f.ext || f.type?.toUpperCase() || "...")}</div>
                  </div>}
                {f._loading && (
                  <div style={{ position: "absolute", inset: 0, borderRadius: 5, background: "rgba(0,0,0,0.7)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                    <svg width="30" height="30" style={{ transform: "rotate(-90deg)" }}>
                      <circle cx="15" cy="15" r="11" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="2.5" />
                      <circle cx="15" cy="15" r="11" fill="none" stroke="#fff" strokeWidth="2.5" strokeDasharray={`${2 * Math.PI * 11}`} strokeDashoffset={`${2 * Math.PI * 11 * (1 - (f._progress || 0) / 100)}`} strokeLinecap="round" />
                    </svg>
                    <div style={{ fontSize: 8, color: "#fff", fontFamily: "monospace" }}>{f._progress || 0}%</div>
                    <button onPointerDown={e => { e.stopPropagation(); f._ctrl?.abort(); }} style={{ marginTop: 2, background: "#e74c3c", border: "none", borderRadius: 3, color: "#fff", fontSize: 8, padding: "2px 5px", cursor: "pointer" }}>✕</button>
                  </div>
                )}
                {!f._loading && f._done && <div style={{ position: "absolute", top: -5, left: -5, width: 15, height: 15, background: color, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, color: "#fff" }}>✓</div>}
                {!f._loading && f.type === "pdf" && f.pages?.length > 1 && <div style={{ position: "absolute", bottom: 2, left: 2, background: "#333", color: "#fff", fontSize: 7, fontFamily: "monospace", padding: "1px 3px", borderRadius: 2 }}>{f.pages.length}с</div>}
                {!f._loading && f.type === "excel" && <div style={{ position: "absolute", bottom: 2, left: 2, background: "#27ae60", color: "#fff", fontSize: 7, fontFamily: "monospace", padding: "1px 3px", borderRadius: 2 }}>XLS</div>}
                {!f._loading && <button onClick={() => onRemove(i)} style={{ position: "absolute", top: -5, right: -5, width: 16, height: 16, background: "#e74c3c", color: "#fff", border: "none", borderRadius: "50%", cursor: "pointer", fontSize: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>}
              </div>
              {onTag && f._done && !f._loading && (
                <input value={f._tag || ""} onChange={e => onTag(f._id, e.target.value)} placeholder="пункт ТЗ" title="Прив'язати до пункту ТЗ" style={{ width: 70, fontSize: 8, fontFamily: "monospace", border: "1px solid #ddd", borderRadius: 3, padding: "2px 4px", outline: "none", color: "#555", boxSizing: "border-box", textAlign: "center" }} />
              )}
              {onDocType && f._done && !f._loading && (
                <select value={f._docType || ""} onChange={e => onDocType(f._id, e.target.value)} title="Тип документа для Cross-Check"
                  style={{ width: 70, fontSize: 8, fontFamily: "monospace", border: `1px solid ${f._docType ? color : "#ddd"}`, borderRadius: 3, padding: "1px 2px", outline: "none", color: f._docType ? "#333" : "#bbb", background: "#fff", boxSizing: "border-box", marginTop: 2 }}>
                  <option value="">тип?</option>
                  {Object.entries(DOC_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              )}
            </div>
            );
          })}
          <div onClick={() => inputRef.current.click()} style={{ width: 70, height: 70, border: `2px dashed ${color}`, borderRadius: 8, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}>
            <div style={{ fontSize: 20, color }}>+</div>
            <div style={{ fontSize: 8, color: "#bbb", fontFamily: "monospace" }}>додати</div>
          </div>
        </div>
        {!drag && <div style={{ fontSize: 8, color: "#ccc", fontFamily: "monospace", textAlign: "center", marginTop: 4 }}>↑ або перетягніть</div>}
      </div>
      <input ref={inputRef} type="file" accept="*/*" multiple style={{ display: "none" }} onChange={e => { Array.from(e.target.files).forEach(onAdd); e.target.value = ""; }} />
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
const SESSION_KEY = "rqa_session";
function saveSession(data) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(data)); } catch { /* ignore */ } }
function loadSession() { try { const s = localStorage.getItem(SESSION_KEY); return s ? JSON.parse(s) : null; } catch { return null; } }
function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ } }

export default function App() {
  const [mode, setMode] = useState("first");
  const [step, setStep] = useState(1);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState(null);
  const [savedSession, setSavedSession] = useState(() => loadSession());
  const [briefText, setBriefText] = useState("");
  const [perData, setPerData] = useState([]);
  const [statuses, setStatuses] = useState([]);
  const [globalSum, setGlobalSum] = useState("");
  const [consistency, setConsistency] = useState(null); // cross-render consistency check
  const [consistencyLoading, setConsistencyLoading] = useState(false);
  const [anthropicKey, setAnthropicKey] = useState(() => { try { return localStorage.getItem("anthropic_api_key") || ""; } catch { return ""; } });
  const saveAnthropicKey = k => { setAnthropicKey(k); try { localStorage.setItem("anthropic_api_key", k); } catch { /* ignore */ } };
  const [archivizerToken, setArchivizerToken] = useState(() => { try { return localStorage.getItem("archivizer_token") || ""; } catch { return ""; } });
  const saveArchivizerToken = k => { setArchivizerToken(k); try { localStorage.setItem("archivizer_token", k); } catch { /* ignore */ } };
  const [archivizerUrl, setArchivizerUrl] = useState("");
  const [archivizerStatus, setArchivizerStatus] = useState(null);
  const [tzCards, setTzCards] = useState([]); // [{id, category, text, source, imgPreview}]
  const [tzAnnotation, setTzAnnotation] = useState("");
  const [tzClientComments, setTzClientComments] = useState([]); // [{page, text}] // розгорнутий опис проекту
  const [tzReview, setTzReview] = useState(false);
  const [tzParsing, setTzParsing] = useState(false);
  const cachedPartsRef = useRef(null); // зберігає cacheParts після runAnalysis для retry
  const analysisRunningRef = useRef(false);
  const renders = useFileList("renders"); const briefs = useFileList("briefs"); const refs = useFileList("refs"); const draws = useFileList("draws");
  const revBriefs = useFileList("briefs"); const revRefs = useFileList("refs"); const revDraws = useFileList("draws");

  // Після конвертації DWG→DXF оновлюємо файл у списку
  const handleDwgConverted = useCallback((fileList, dwgFile, dxfText) => {
    fileList.ref.current = fileList.ref.current.map(f =>
      f._id === dwgFile._id
        ? { ...f, type: "dxf", ext: "DXF", textContent: dxfText, _done: true }
        : f
    );
    // форсуємо ре-рендер
    fileList.ref.current = [...fileList.ref.current];
  }, []);

  const [pairs, setPairs] = useState([{ id: 1, comment: "" }]);
  const pairBefores = useRef({}); const pairAfters = useRef({});
  const [, setPairTick] = useState(0);
  const bumpPairs = () => setPairTick(t => t + 1);

  const getPF = (id, side) => { const s = side === "before" ? pairBefores : pairAfters; if (!s.current[id]) s.current[id] = []; return s.current[id]; };
  const addPF = (id, side, file) => {
    const s = side === "before" ? pairBefores : pairAfters;
    if (!s.current[id]) s.current[id] = [];
    const fid = "f" + Date.now() + "_" + Math.random().toString(36).slice(2);
    const ctrl = new AbortController();
    s.current[id] = [...s.current[id], { _id: fid, _loading: true, _progress: 0, _ctrl: ctrl, filename: file.name, preview: null, pages: [], type: null }];
    bumpPairs();
    processFile(file, pct => { s.current[id] = s.current[id].map(x => x._id === fid ? { ...x, _progress: pct } : x); bumpPairs(); }, ctrl.signal)
      .then(d => { s.current[id] = s.current[id].map(x => x._id === fid ? { ...d, _id: fid, _loading: false, _done: true } : x); bumpPairs(); })
      .catch(e => { if (e.name === "AbortError") s.current[id] = s.current[id].filter(x => x._id !== fid); else s.current[id] = s.current[id].map(x => x._id === fid ? { ...x, _loading: false, _error: true } : x); bumpPairs(); });
  };
  const removePF = (id, side, idx) => { const s = side === "before" ? pairBefores : pairAfters; s.current[id] = (s.current[id] || []).filter((_, i) => i !== idx); bumpPairs(); };

  const readyFiles = fl => (fl.files || []).filter(f => !f._loading && !f._error && f._done && (
    f.pages?.some(p => p.b64) || f.textContent || f.type === "dwg"
  ));
  const matNote = files => {
    const ex = (files || []).filter(f => f.type === "excel" && f.textContent);
    const dxf = (files || []).filter(f => f.type === "dxf" && f.textContent);
    const dwg = (files || []).filter(f => f.type === "dwg" && f.textContent && !f.textContent.includes("помилка"));
    const txt = (files || []).filter(f => f.type === "text" && f.textContent);
    let out = "";
    if (ex.length) out += `\n\nСПЕЦИФІКАЦІЯ МАТЕРІАЛІВ (Excel):\n${ex.map(e => `[${e.filename}]:\n${e.textContent.slice(0, 4000)}`).join("\n---\n")}`;
    if (dxf.length) out += `\n\nDXF КРЕСЛЕННЯ:\n${dxf.map(d => `[${d.filename}]:\n${d.textContent.slice(0, 5000)}`).join("\n---\n")}`;
    if (dwg.length) out += `\n\nDWG КРЕСЛЕННЯ (витягнуто з бінарного файлу):\n${dwg.map(d => `[${d.filename}]:\n${d.textContent.slice(0, 5000)}`).join("\n---\n")}`;
    if (txt.length) out += `\n\nДОКУМЕНТИ ТЗ:\n${txt.map(t => `[${t.filename}]:\n${t.textContent.slice(0, 5000)}`).join("\n---\n")}`;
    return out;
  };

  async function runAnalysis() {
    if (analysisRunningRef.current) return;
    analysisRunningRef.current = true;
    const isRev = mode === "revision";
    if (isRev) {
      const vp = pairs.filter(p => {
        const b = getPF(p.id, "before").filter(f => !f._loading && !f._error && (f.pages?.some(pg => pg.b64) || f.type === "excel"));
        const a = getPF(p.id, "after").filter(f => !f._loading && !f._error && (f.pages?.some(pg => pg.b64) || f.type === "excel"));
        return b.length > 0 && a.length > 0;
      });
      if (!vp.length) { setErr("Завантажте хоча б одну пару ДО/ПІСЛЯ."); analysisRunningRef.current = false; return; }
      setErr(""); setStep(2); setSel(null);
      const results = vp.map(() => null); setPerData([...results]);
      setStatuses(vp.map((_, i) => i === 0 ? "Аналізую…" : "У черзі…"));
      const taggedFilesRev = [];
      const collectTaggedRev = (files, label) => (files || []).forEach((f, fi) => {
        if (f._docType) taggedFilesRev.push({ docType: f._docType, label: `${label} ${fi + 1}: ${f.filename}` });
      });
      collectTaggedRev(readyFiles(revBriefs), "БРИФ"); collectTaggedRev(readyFiles(revRefs), "РЕФЕРЕНС"); collectTaggedRev(readyFiles(revDraws), "КРЕСЛЕННЯ");
      const sverkaChecksRev = activeSverka(taggedFilesRev.map(t => t.docType), "revision");
      for (let ri = 0; ri < vp.length; ri++) {
        setStatuses(prev => prev.map((s, i) => i === ri ? "Аналізую…" : i > ri ? "У черзі…" : null));
        const pair = vp[ri];
        const bFiles = getPF(pair.id, "before").filter(f => !f._loading && !f._error);
        const aFiles = getPF(pair.id, "after").filter(f => !f._loading && !f._error);
        const mn = matNote([...readyFiles(revBriefs), ...readyFiles(revDraws)]);
        const isLast = ri === vp.length - 1;
        const revTzLower = (pair.comment || "").toLowerCase();
        const revHasDrawings = readyFiles(revDraws).filter(d => d.pages?.some(p => p.b64) || d.textContent).length > 0;

        // Визначаємо що саме перевіряти в цьому раунді
        const revBlocks = [`── ПОРІВНЯННЯ ДО/ПІСЛЯ ──
Для кожної правки з переліку:
• fixed = повністю усунуто
• partial = покращено але є залишки або нові проблеми в зоні
• not_fixed = не змінилось або стало гірше`];

        revBlocks.push(`── НОВІ ДЕФЕКТИ (Q1.1-Q1.6) ──
Чи з'явились нові технічні проблеми яких не було на ДО?
Левітація, перетин, тайлінг, артефакти, аліасинг, матеріали.`);

        if (revHasDrawings) revBlocks.push(`── ВІДПОВІДНІСТЬ КРЕСЛЕННЯМ (Q2.1) ──\n${BLUEPRINT_COMPARE_PROMPT}`);

        if (/лого|logo|напис|sign|banner/.test(revTzLower)) {
          revBlocks.push(`── НАПИСИ / ЛОГО (Q3.2) ──\nПравильність написів, відсутність placeholder тексту.`);
        }

        revBlocks.push(`── РЕОСЕТТИНГ (Q3.1) ──
Чи виправлено проблеми геосеттингу якщо вони були в правках?
Розетки, номери, написи на техніці, штори, рослинність.`);

        revBlocks.push(sverkaPromptBlock(sverkaChecksRev, taggedFilesRev));

        revBlocks.push(`── РЕГРЕСІЯ ──
Чи не погіршились інші місця при виправленні? Зона що не входила в правки але змінилась.`);

        const parts = [{ type: "text", text: `Ти — старший QA-спеціаліст 3D-візуалізації. Раунд правок ${ri + 1} з ${vp.length}.

ПРАВКИ ЦЬОГО РАУНДУ:
${pair.comment?.trim() || "(порівняй ДО і ПІСЛЯ візуально — знайди всі зміни)"}
${mn}

${ZONE_PROMPT}

${revBlocks.join("\n\n")}

СТАНДАРТИ ЯКОСТІ: ${QUAL_C}

ПРАВИЛА:
- Перевіряй ТІЛЬКИ те що релевантне до цього раунду правок
- zone завжди на зображенні ПІСЛЯ (не ДО)
- Кожна проблема ОБОВ'ЯЗКОВО має zone
- Заповни "tz_parsed" — вимоги з ТЗ/брифу що стосуються цього раунду правок (згрупуй по категоріях)
- Заповни "checks" — по кожному Q-пункту що перевірявся в цьому раунді:
  • status: "ok", "warn", "fail", "skipped"
  • group: "technical" (Q1.x), "tz" (невідповідність типу по ТЗ/кресленнях), "materials" (нюанс кольору/відтінку), "geosetting" (Q3.x), "client" (Q4.x)
  • note у форматі: "Еталон ([джерело]): [що має бути] → Знайдено: [що є] → [висновок]" або "Перевірено — зауважень немає"
${isLast ? "- Заповни globalSummary — підсумок всіх раундів." : '- globalSummary: ""'}
- Заповни "materials" — КОЖЕН матеріал згаданий в ТЗ/брифі/кресленнях:
  • name, group, spec (якщо є), expected (по ТЗ), note (що видно на ПІСЛЯ-зображенні)
  • status: "match" | "mismatch" | "missing" | "unknown"
  • zone: ОБОВ'ЯЗКОВО — де матеріал видно на зображенні ПІСЛЯ

ВІДПОВІДАЙ ТІЛЬКИ JSON:
${JSON_SCHEMA}` }];
        parts.push(...filesToParts(bFiles, "ДО"));
        parts.push(...filesToParts(aFiles, "ПІСЛЯ"));
        parts.push(...filesToParts(readyFiles(revBriefs), "БРИФ"));
        parts.push(...filesToParts(readyFiles(revRefs), "РЕФЕРЕНС"));
        parts.push(...filesToParts(readyFiles(revDraws), "КРЕСЛЕННЯ"));
        try {
          const p = await callAPI(parts, 2, anthropicKey);
          results[ri] = normalizeZones({ tz_parsed: p.tz_parsed || [], checks: p.checks || [], items: p.items || [], corrections: p.corrections || [], defects: p.defects || [], materials: p.materials || [], sverka: p.sverka || [], quality: p.quality || null, summary: p.summary || "" });
          if (p.globalSummary) setGlobalSum(p.globalSummary);
        } catch (e) { results[ri] = { items: [], corrections: [], defects: [], materials: [], quality: null, error: e.message }; }
        setPerData([...results]);
        setStatuses(prev => prev.map((s, i) => i === ri ? null : s));
      }
    } else {
      const rImages = readyFiles(renders).filter(f => f.pages?.some(p => p.b64));
      if (!rImages.length) { setErr("Завантажте хоча б один рендер."); analysisRunningRef.current = false; return; }
      setErr(""); setStep(2); setSel(null);
      const results = rImages.map(() => null); setPerData([...results]);
      setStatuses(rImages.map((_, i) => i === 0 ? "Аналізую…" : "У черзі…"));
      const drawsList = readyFiles(draws);
      const briefsList = readyFiles(briefs);
      const refsList = readyFiles(refs);
      const mn = matNote([...briefsList, ...drawsList]);
      const drawCount = drawsList.filter(d => d.pages?.some(p => p.b64)).length;
      const hasDwgText = drawsList.filter(d => (d.type === "dxf" || d.type === "dwg") && d.textContent).length > 0;
      const hasBrief = briefText.trim() || briefsList.length > 0;
      const hasRefs = refsList.length > 0;
      // ── Структуровані вимоги ТЗ ──────────────────────────────────────────────
      const tzSection = tzCards.length > 0
        ? `ПІДТВЕРДЖЕНІ ВИМОГИ ТЗ (${tzCards.length} пунктів — перевір КОЖЕН):\n${tzCards.map(c => `[${c.id}] ${c.category}: ${c.text}${c.source ? ` (${c.source})` : ""}`).join("\n")}\n${mn}`
        : `ТЗ КЛІЄНТА:\n${briefText.trim() || "(дивись прикріплені матеріали)"}\n${mn}`;
      const tzParsedInstruction = tzCards.length > 0
        ? `- "tz_parsed": [] (вимоги вже підтверджені, не повторюй)
- "items" — ВІЗУАЛЬНІ МАРКЕРИ на рендері, по кожній підтвердженій вимозі (${tzCards.length} пунктів).
  РІЗНИЦЯ між items і checks: items = де саме на зображенні, checks = загальна оцінка по Q-коду.
  Заповни ОБОВ'ЯЗКОВО всі ${tzCards.length} пунктів:
  • id: відповідний id (${tzCards.slice(0, 5).map(c => c.id).join(", ")}${tzCards.length > 5 ? "..." : ""})
  • comment: текст вимоги з ТЗ (коротко)
  • status: "fixed" (виконано) | "not_fixed" (не виконано) | "partial" (частково)
  • note: що конкретно знайдено на рендері — одне речення
  • zone: ОБОВ'ЯЗКОВО — координати елемента на рендері навіть якщо виконано (щоб показати маркер)`
        : `- Заповни "tz_parsed" — що ти зрозумів з ТЗ/брифу/референсів/креслень:
  • Згрупуй по категоріях: "Матеріали", "Меблі та моделі", "Сезон / атмосфера", "Креслення", "Логотип / написи", "Вимоги клієнта" та інші що є
  • Кожен пункт — конкретна вимога: "Диван — червоний велюр (бриф)", "Вікно зліва (креслення)"
  • Якщо категорія не має матеріалів — не включай
- "items" — ВІЗУАЛЬНІ МАРКЕРИ: по кожній вимозі з tz_parsed постав маркер на рендері.
  РІЗНИЦЯ: items = де на зображенні, checks = оцінка по Q-коду. Це різні масиви, не дублюй.
  • id, comment, status (fixed/not_fixed/partial), note, zone (ОБОВ'ЯЗКОВО)`;

      // Визначаємо тип проекту з тексту ТЗ
      const tzLower = briefText.toLowerCase();
      const isExterior = /екстер|exterior|фасад|facade|будинок|house|office|building|landscape|ландшафт/.test(tzLower);
      const isInterior = !isExterior || /інтер|interior|кімнат|room|kitchen|living/.test(tzLower);
      const hasLogoMention = /лого|logo|brand|вивіск|sign|banner|neon/.test(tzLower);
      const isMiddleEast = /middle east|arab|dubai|uae|qatar|saudi|халяль/.test(tzLower);
      const hasLandscape = /ландшафт|landscape|garden|сад|озеленен/.test(tzLower);

      // ── Формуємо кешовані частини ОДИН РАЗ для всіх рендерів ──────────────────
      const blocks = [];
      blocks.push(`── БЛОК 1: ТЕХНІЧНІ ДЕФЕКТИ (завжди перевіряй) ──
Q1.1 ЛЕВІТАЦІЯ: Всі предмети стоять на поверхні? Ніжки меблів, декор, килими. Немає тіні = левітація.
Q1.2 ПЕРЕТИН: Об'єкти крізь стіни/підлогу/стелю/одне одного? Будь-який кліппінг = баг.
Q1.3 ТЕКСТУРИ: Тайлінг видно? Стрейчінг? Неправильний масштаб? Шви між поверхнями?
Q1.4 ЗУБЧАТІСТЬ: Зубчасті краї на кривих лініях, поручнях, тонких об'єктах?
Q1.5 АРТЕФАКТИ: Fireflies, noise, blotchy shadows, темні плями на стелі/кутах?
Q1.6 МАТЕРІАЛИ: IOR коректний? Roughness відповідає? Пластиковий вигляд у металів?`);
      if (drawCount > 0 || hasDwgText) {
        blocks.push(`── БЛОК 2: ВІДПОВІДНІСТЬ КРЕСЛЕННЯМ (надані — перевіряй суворо) ──
${BLUEPRINT_COMPARE_PROMPT}
${isExterior ? "• Фасади (Elevations): пропорції, висоти, деталі?\n• Гребінь/коник даху: правильна форма?\n• Цегла/сайдинг: відповідає кресленню?\n• Водостоки (Gutter): наявні та правильно розміщені?\n• Вентканали: присутні згідно плану?" : ""}
${isInterior ? "• Floorplan: меблі на своїх місцях?\n• Вікна/двері/ручки/плінтуси/карнизи: всі деталі присутні?\n• Розкладка плитки/підлог: патерн та напрямок відповідає?\n• Освітлення/розетки по electrical plan?" : ""}
${hasLandscape || isExterior ? "• Ландшафтний план: озеленення, доріжки, зони відповідають?" : ""}`);
      }
      if (hasBrief || hasRefs) {
        blocks.push(`── БЛОК 3: ВІДПОВІДНІСТЬ БРИФУ / МУДБОРДУ ──
• Побажання клієнта з ТЗ: кожен пункт виконано?
• Пора року: рослинність і атмосфера відповідають (якщо вказано)?
• День/ніч: тип освітлення, небо, світло у вікнах відповідає?
• Кольори/матеріали/стиль: відповідають мудборду?
${hasRefs ? "• Відповідність референсам: настрій і атмосфера схожі?" : ""}
• Тип освітлення: природне/штучне/змішане — відповідає запиту?`);
      }
      if (hasBrief && /меблі|мебель|furniture|росли|plant|декор|decor|модел/.test(tzLower)) {
        blocks.push(`── БЛОК 4: СПЕЦИФІЧНІ МОДЕЛІ ПО ЗАПИТУ ──
• Конкретні меблі/бренди з ТЗ: присутні?
• Конкретні рослини/види: присутні?
• Предмети декору по запиту: присутні?
Перевіряй ТІЛЬКИ те що явно запитано в ТЗ — не вигадуй.`);
      }
      const reosettingItems = [
        isInterior && "• Розетки: наявні на стінах в логічних місцях?",
        isExterior && "• Номери машин: не безглузді символи?",
        "• Рослинність: виглядає природно, не copy-paste клони?",
        isExterior && "• Дороги/знаки/розмітка/зливи: відповідають країні проекту?",
        "• Формат часу на техніці/вивісках: коректний (не 88:88)?",
        isInterior && "• Сантехніка: деталі виглядають реалістично?",
        "• Штори/жалюзі: природно звисають, складки реалістичні?",
        isMiddleEast && "• Одяг на людях: відповідний дрес-код (Middle East)?",
        "• BEK/фон: оточення логічне та доречне?",
      ].filter(Boolean).join("\n");
      blocks.push(`── БЛОК 5: РЕОСЕТТИНГ (деталі реалізму) ──\n${reosettingItems}`);
      if (hasLogoMention || isExterior || /комерц|commercial|shop|office|retail/.test(tzLower)) {
        blocks.push(`── БЛОК 6: НАПИСИ / ЛОГО / НЕЙМИНГ ──
• Логотипи: правильно відображені, не спотворені?
• Написи на вивісках/банерах: осмислені, не Lorem Ipsum?
• Написи англійською: граматично правильні?
• Шрифти: відповідають брендбуку або запиту?`);
      }
      if (/dpi|resolution|розрішен|формат|tif|psd|маск|mask|ratio|actq/.test(tzLower)) {
        blocks.push(`── БЛОК 7: CLIENT CRITICAL REQUIREMENTS ──
• Перевір з ТЗ: розрішення/DPI, нейминг файлів, співвідношення сторін, формат (TIFF/PSD/маски), Studio standards ACTQ.`);
      }
      const activeChecklist = blocks.join("\n\n");

      // ── Cross-Check: активні пункти по типах завантажених документів ─────────
      const taggedFiles = [];
      const collectTagged = (files, label) => (files || []).forEach((f, fi) => {
        if (f._docType) taggedFiles.push({ docType: f._docType, label: `${label} ${fi + 1}: ${f.filename}` });
      });
      collectTagged(briefsList, "БРИФ"); collectTagged(refsList, "РЕФЕРЕНС"); collectTagged(drawsList, "КРЕСЛЕННЯ");
      const sverkaChecks = activeSverka(taggedFiles.map(t => t.docType), mode);
      const sverkaBlock = sverkaPromptBlock(sverkaChecks, taggedFiles);

      // Будуємо кешовані частини: інструкції + всі матеріали (бриф, референси, креслення)
      const cacheParts = [{ type: "text", text: `Ти — PM та Art Director студії 3D-візуалізації. Перевіряєш проект з ${rImages.length} ракурс(ів).

Твоя роль — двошарова перевірка кожного рендеру:
▸ PM: відповідність ТЗ — кожен пункт або виконано, або ні. Без компромісів.
▸ Art Director: художня якість — композиція, світло, атмосфера, матеріали.

ЗАЛІЗНЕ ПРАВИЛО: якщо ТЗ каже "червоний велюр" — є тільки два результати: "виконано" або "не виконано — замінити на червоний велюр". ЗАБОРОНЕНО пропонувати: "схоже підійде", "можна замінити на", "альтернативно", "також вписується в палітру". Будь-яка зміна вимоги — рішення тільки клієнта і PM.

ФОРМАТ МАТЕРІАЛІВ ТЗ: PDF-сторінки надаються парами — спочатку блок "підписи та анотації на сторінці" (текстовий шар), потім зображення тієї самої сторінки. Вони єдині: підпис "ця текстура на підлогу" з текстового блоку — це опис стрілки або виноски що ти бачиш на сусідньому зображенні. Використовуй обидва разом для точного зчитування вимог клієнта.

${tzSection}

${ZONE_PROMPT}

══════════════════════════════════════════
ШАРИ ПЕРЕВІРКИ
══════════════════════════════════════════

── ШАР 1: ВІДПОВІДНІСТЬ ТЗ (PM) ──
${tzCards.length > 0
  ? `Перевір КОЖЕН з ${tzCards.length} підтверджених пунктів ТЗ буквально:
• Знайди відповідний елемент на рендері
• Порівняй з вимогою точно — без інтерпретацій та припущень
• note формат: "ТЗ: [вимога] → Знайдено: [що є] → [виконано / не виконано]"
• Якщо не виконано — додай тільки: "Виправити: [точна вимога з ТЗ]"`
  : `Перевір відповідність до всіх вимог з матеріалів:
• Кожна вимога з брифу/референсів/креслень перевірена
• note формат: "ТЗ: [вимога] → Знайдено: [що є] → [виконано / не виконано]"`}

── ШАР 2: ХУДОЖНЯ ЯКІСТЬ (Art Director) ──
Оціни незалежно від ТЗ — суто художній погляд:
• Композиція: баланс кадру, фокусна точка, глибина, провідні лінії
• Освітлення: атмосфера, м'якість/жорсткість тіней, правдоподібність джерел світла
• Кольорова гармонія: чи "звучить" палітра разом? Баланс теплого/холодного?
• Матеріали: художнє відчуття поверхні, реалізм текстур (не технічний — естетичний)
• Загальна атмосфера: чи є "настрій" і "душа" в рендері?
note формат: "[AD спостереження] → Рекомендація художнику: [конкретна дія в рамках заданого стилю]"
НЕ пропонуй зміни вимог ТЗ тут — тільки художні покращення.
Використовуй qa_tag: AD.1 (композиція), AD.2 (освітлення), AD.3 (колір/атмосфера), AD.4 (матеріали/текстури)

── ШАР 3: ТЕХНІЧНІ ДЕФЕКТИ (QA) ──
${activeChecklist}

── ШАР 4: CROSS-CHECK (студійний чеклист по документах) ──
${sverkaBlock}

СТАНДАРТИ ЯКОСТІ:
${QUAL_C}

ПІДРАХУНОК СКОРІВ (два незалежних числа):
▸ quality.score (0-100) = якість РЕНДЕРУ: враховуй тільки Q1.x + AD.x + Q3.x
  fail = -15..20 балів залежно від severity, warn = -5..8, ok = повний бал, skipped = не враховується
  standard = NON (<55), MLR (55-79), SDC (80-100)
▸ quality.tz_score (0-100) = виконання ТЗ: враховуй тільки Q2.x + Q4.x
  tz_done = кількість ok/warn серед Q2.x+Q4.x, tz_total = загальна кількість перевірених Q2.x+Q4.x
  tz_score = round(tz_done / tz_total * 100)
ВАЖЛИВО: рендер може бути SDC 90% але tz_score 40% — це нормально, це різні виміри.

ПРАВИЛА:
- Перевіряй ТІЛЬКИ те що реально видно на рендері або підтверджено матеріалами
- Якщо блок не релевантний — не вигадуй проблеми
- Кожна проблема ОБОВ'ЯЗКОВО має zone з точними координатами
- qa_tag: Q1.1-Q1.6 (технічні), Q2.1 (креслення), Q2.2 (ТЗ), Q2.3 (моделі), Q3.1 (геосеттинг), Q3.2 (написи), Q4.1 (client req), AD.1-AD.4 (художні)
${tzParsedInstruction}
- Заповни "checks" по кожному перевіреному пункту:
  • id: Q1.1...Q4.1, AD.1...AD.4
  • status: "ok" / "warn" / "fail" / "skipped"
  • group: "technical" (Q1.x), "tz" (неправильний ТИП по ТЗ), "materials" (нюанс відтінку), "geosetting" (Q3.x), "client" (Q4.x), "artistic" (AD.x)
  • note ЗАВЖДИ за шаблоном шару:
    ТЗ-пункт: "ТЗ: [вимога] → Знайдено: [що є] → [виконано/не виконано]" + якщо fail: "Виправити: [точна вимога]"
    AD-пункт: "[спостереження] → Рекомендація художнику: [конкретна дія]"
    Tech-пункт: "Знайдено: [опис] → Виправити: [конкретна дія]"
    OK: "Перевірено — [що саме] відповідає"
    Skipped: "Матеріал не наданий" або "Не застосовно"
  • ЗАБОРОНЕНО в будь-якому note: "можна замінити на", "схоже підійде", "альтернативно", "також вписується", "близький варіант"
  • Q2.x group "tz" = неправильний ТИП (червоний → є синій). group "materials" = нюанс (бежевий але холодний відтінок)
- Заповни "materials" — КОЖЕН матеріал згаданий в ТЗ/брифі/кресленнях:
  • name: точна назва матеріалу (напр. "Паркет дуб натуральний")
  • group: категорія (Підлога, Стіни, Меблі, Освітлення, Текстиль тощо)
  • spec: специфікація якщо вказана (розмір, марка, колір, відділка)
  • status: "match" (відповідає ТЗ) | "mismatch" (не відповідає) | "missing" (відсутній на рендері) | "unknown" (неможливо оцінити)
  • expected: що має бути по ТЗ (точно як в брифі)
  • note: що реально видно на рендері — одне речення
  • zone: ОБОВ'ЯЗКОВО — координати де цей матеріал видно на рендері

ВІДПОВІДАЙ ТІЛЬКИ JSON:
${JSON_SCHEMA}` }];
      cacheParts.push(...filesToParts(briefsList, "БРИФ"));
      cacheParts.push(...filesToParts(refsList, "РЕФЕРЕНС"));
      cacheParts.push(...filesToParts(drawsList, "КРЕСЛЕННЯ"));
      // Позначаємо останній елемент як межу кешу — все до нього кешується
      if (cacheParts.length > 0) {
        cacheParts[cacheParts.length - 1] = { ...cacheParts[cacheParts.length - 1], cache_control: { type: "ephemeral" } };
      }
      cachedPartsRef.current = cacheParts; // зберігаємо для retryFailed

      for (let ri = 0; ri < rImages.length; ri++) {
        setStatuses(prev => prev.map((s, i) => i === ri ? "Аналізую…" : i > ri ? "У черзі…" : null));
        const render = rImages[ri]; const isLast = ri === rImages.length - 1;

        // Унікальна частина для кожного рендера
        const renderParts = [{ type: "text", text: `Аналізуй ракурс ${ri + 1} з ${rImages.length}.${isLast ? "\nЗаповни globalSummary — загальна оцінка всього проекту." : '\nglobalSummary: ""'}` }];
        (render.pages || []).filter(p => p.b64).forEach((pg, pi) => {
          renderParts.push({ type: "text", text: `РЕНДЕР ${ri + 1}${pi > 0 ? ` стор.${pi + 1}` : ""}:` });
          renderParts.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: pg.b64 } });
        });

        const parts = [...cacheParts, ...renderParts];
        try {
          const p = await callAPI(parts, 2, anthropicKey);
          results[ri] = normalizeZones({ tz_parsed: p.tz_parsed || [], checks: p.checks || [], items: p.items || [], corrections: p.corrections || [], defects: p.defects || [], materials: p.materials || [], sverka: p.sverka || [], quality: p.quality || null, summary: p.summary || "" });
          if (p.globalSummary) setGlobalSum(p.globalSummary);
        } catch (e) { results[ri] = { items: [], corrections: [], defects: [], materials: [], quality: null, error: e.message }; }
        setPerData([...results]);
        saveSession({ savedAt: new Date().toISOString(), mode, perData: results, globalSum, tzCards: tzCards.map(c => ({ ...c, imgPreview: null })), tzAnnotation, tzClientComments });
        setStatuses(prev => prev.map((s, i) => i === ri ? null : s));
        if (ri < rImages.length - 1) await new Promise(r => setTimeout(r, 1500));
      }

      // ── Consistency check — тільки якщо 2+ ракурсів без помилок ──────────────
      const validResults = results.filter(r => r && !r.error);
      if (validResults.length >= 2) {
        setConsistencyLoading(true);
        try {
          const summaries = validResults.map((r, i) => `Ракурс ${i + 1}: ${r.summary || "без summary"}`).join("\n");
          const consParts = [{ type: "text", text: `Ти — Art Director. Проаналізуй консистентність пост-продакшну між ${rImages.length} ракурсами одного проекту.

Саммарі по кожному ракурсу:
${summaries}

Перевір консистентність по всіх параметрах:
• Освітлення: однаковий тип, температура, напрямок тіней між ракурсами?
• Кольорокорекція: однаковий тон, насиченість, контраст, гамма?
• Атмосфера: однаковий настрій, пора дня, погода?
• Матеріали: один і той самий матеріал (диван, підлога, стіни) виглядає ОДНАКОВО на всіх ракурсах де видно? Колір, відтінок, roughness, відблиски?
• Кольори об'єктів: один і той самий предмет не змінює колір між ракурсами?
• Моделі: одні й ті самі меблі/декор виглядають однаково (не різні версії моделі)?
• Постпродакшн: однаковий стиль обробки, однакові фільтри/ефекти?

ВІДПОВІДАЙ ТІЛЬКИ JSON:
{"consistency":{"score":85,"verdict":"Консистентний","issues":[{"type":"lighting|color|materials|models|postprod","description":"Диван на ракурсі 1 виглядає темнішим ніж на ракурсі 3 — різний відтінок тканини","renders":[1,3]}],"summary":"Загальний висновок по консистентності пост-продакшну"}}` }];
          rImages.forEach((render, ri) => {
            (render.pages || []).filter(p => p.b64).slice(0, 1).forEach(pg => {
              consParts.push({ type: "text", text: `Ракурс ${ri + 1}:` });
              consParts.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: pg.b64 } });
            });
          });
          const cp = await callAPI(consParts, 1, anthropicKey);
          const cons = cp.consistency || null;
          setConsistency(cons);
          saveSession({ savedAt: new Date().toISOString(), mode, perData: results, globalSum, consistency: cons, tzCards: tzCards.map(c => ({ ...c, imgPreview: null })), tzAnnotation, tzClientComments });
        } catch (e) { setConsistency({ error: e.message }); }
        setConsistencyLoading(false);
      }
    }
    analysisRunningRef.current = false;
  }

  async function retryFailed() {
    const rImages = readyFiles(renders).filter(f => f.pages?.some(p => p.b64));
    const failedIdxs = perData.map((d, i) => d?.error ? i : -1).filter(i => i >= 0);
    if (!failedIdxs.length) return;
    if (!cachedPartsRef.current) { setErr("Не вдалось повторити — перезапустіть аналіз заново."); return; }
    const newStatuses = perData.map((d, i) => d?.error ? "Повтор…" : statuses[i]);
    setStatuses([...newStatuses]);
    const results = [...perData];
    for (const ri of failedIdxs) {
      const render = rImages[ri]; if (!render) continue;
      const isLast = ri === rImages.length - 1;
      const renderParts = [{ type: "text", text: `Аналізуй ракурс ${ri + 1} з ${rImages.length}.${isLast ? "\nЗаповни globalSummary — загальна оцінка всього проекту." : '\nglobalSummary: ""'}` }];
      (render.pages || []).filter(p => p.b64).forEach((pg, pi) => {
        renderParts.push({ type: "text", text: `РЕНДЕР ${ri + 1}${pi > 0 ? ` стор.${pi + 1}` : ""}:` });
        renderParts.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: pg.b64 } });
      });
      const parts = [...cachedPartsRef.current, ...renderParts];
      try {
        const p = await callAPI(parts, 2, anthropicKey);
        results[ri] = normalizeZones({ tz_parsed: p.tz_parsed || [], checks: p.checks || [], items: p.items || [], corrections: p.corrections || [], defects: p.defects || [], materials: p.materials || [], sverka: p.sverka || [], quality: p.quality || null, summary: p.summary || "" });
        if (p.globalSummary) setGlobalSum(p.globalSummary);
      } catch (e) { results[ri] = { items: [], corrections: [], defects: [], materials: [], quality: null, error: e.message }; }
      setPerData([...results]);
      setStatuses(prev => prev.map((s, i) => i === ri ? null : s));
      if (ri !== failedIdxs[failedIdxs.length - 1]) await new Promise(r => setTimeout(r, 1500));
    }
  }

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

  function openPrintWindow(html, filename) {
    if (window.electronAPI?.savePdf) {
      window.electronAPI.savePdf(html).then(res => {
        if (res?.ok) alert(`PDF збережено:\n${res.path}`);
      }).catch(err => alert("Помилка: " + err.message));
      return;
    }
    const bar = `<div id="print-bar" style="position:fixed;top:0;left:0;right:0;z-index:9999;background:#1a1a1a;color:#f2f0ec;padding:10px 20px;display:flex;align-items:center;gap:14px;font-family:monospace;font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,.4)">
      <span style="flex:1">📄 Готово до збереження — <b>${filename}</b></span>
      <span style="color:#aaa;font-size:11px">Оберіть принтер <b>"Save as PDF"</b> або натисніть кнопку →</span>
      <button onclick="window.print()" style="background:#27ae60;color:#fff;border:none;padding:7px 18px;border-radius:5px;font-family:monospace;font-size:12px;cursor:pointer;font-weight:bold">⬇ Зберегти PDF</button>
      <button onclick="document.getElementById('print-bar').remove()" style="background:transparent;color:#888;border:1px solid #444;padding:7px 12px;border-radius:5px;font-family:monospace;font-size:11px;cursor:pointer">✕</button>
    </div>
    <div style="height:52px"></div>
    <style>@media print{#print-bar,#print-bar+div{display:none!important}}</style>`;
    const fullHtml = html.replace("<body>", "<body>" + bar);
    const w = window.open("", "_blank");
    w.document.write(fullHtml);
    w.document.close();
  }

  function generateTzReport() {
    const e = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const annotationHtml = tzAnnotation ? `
      <div class="block">
        <div class="block-title">📝 Опис проекту</div>
        <div class="annotation">${e(tzAnnotation)}</div>
      </div>` : "";

    const commentsHtml = tzClientComments.length > 0 ? `
      <div class="block">
        <div class="block-title">💬 Коментарі клієнта</div>
        <div class="comments-body">
          ${Object.entries(tzClientComments.reduce((acc, item) => { (acc[item.page] = acc[item.page] || []).push(item.text); return acc; }, {})).map(([page, texts]) => {
            const lines = texts.flatMap(t => t.split(/\n/).map(l => l.replace(/^[•\-–—]\s*/, "").trim()).filter(l => l.length > 0));
            return `<div class="comment-group">
              <div class="comment-page">${e(page)}</div>
              ${lines.map(l => `<div class="comment-line">— ${e(l)}</div>`).join("")}
            </div>`;
          }).join("")}
        </div>
      </div>` : "";

    const grouped = tzCards.reduce((acc, c) => { if (!acc[c.category]) acc[c.category] = []; acc[c.category].push(c); return acc; }, {});
    const tzHtml = tzCards.length > 0 ? `
      <div class="block">
        <div class="block-title">📋 Пункти ТЗ (${tzCards.length})</div>
        <div class="tz-sections">
          ${Object.entries(grouped).map(([cat, items]) => `
            <div class="tz-section">
              <div class="tz-cat">${e(cat)}</div>
              <div class="tz-items">
                ${items.map(it => `
                  <div class="tz-card">
                    ${it.imgPreview ? `<img class="tz-thumb" src="${it.imgPreview}" alt="ref" />` : ""}
                    <div class="tz-card-body">
                      <div class="tz-text">${e(it.text)}</div>
                      <div class="tz-meta">
                        ${it.source ? `<span class="src">[${e(it.source)}]</span>` : ""}
                        ${it.link ? `<a class="tz-link" href="${e(it.link)}">${e(it.link.replace(/^https?:\/\//, ""))}</a>` : ""}
                      </div>
                    </div>
                  </div>`).join("")}
              </div>
            </div>`).join("")}
        </div>
      </div>` : "";

    const css = `
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:Arial,sans-serif;font-size:11px;color:#333;background:#fff;padding:0}
      .cover{background:#1a1a1a;color:#f2f0ec;padding:24px 28px}
      .cover .label{font-size:9px;color:#888;letter-spacing:.15em;margin-bottom:4px}
      .cover .title{font-size:22px;font-weight:bold}
      .cover .date{font-size:10px;color:#888;margin-top:3px}
      .block{margin:10px 16px;border:1px solid #e8e8e8;border-radius:6px;overflow:hidden;page-break-inside:avoid}
      .block-title{background:#f5f4f1;padding:6px 10px;font-size:10px;font-weight:bold;color:#333;border-bottom:1px solid #e8e8e8}
      .annotation{padding:10px 12px;font-size:11px;color:#444;line-height:1.65}
      .comments-body{padding:8px 12px;display:flex;flex-direction:column;gap:10px}
      .comment-group{display:flex;flex-direction:column;gap:3px}
      .comment-page{font-size:8px;color:#aaa;letter-spacing:.08em;text-transform:uppercase;margin-bottom:2px}
      .comment-line{font-size:11px;color:#333;line-height:1.6;padding-left:4px}
      .tz-sections{padding:10px 12px;display:flex;flex-direction:column;gap:14px}
      .tz-section{}
      .tz-cat{font-size:8px;font-weight:bold;color:#aaa;letter-spacing:.1em;text-transform:uppercase;margin-bottom:6px;padding-bottom:3px;border-bottom:1px solid #f0eeea}
      .tz-items{display:flex;flex-direction:column;gap:5px}
      .tz-card{display:flex;align-items:flex-start;gap:8px;padding:5px 6px;border-radius:4px;background:#fafaf8;border:1px solid #f0eeea}
      .tz-thumb{width:64px;height:46px;object-fit:cover;border-radius:3px;border:1px solid #e8e6e1;flex-shrink:0}
      .tz-card-body{flex:1;min-width:0}
      .tz-text{font-size:10.5px;color:#333;line-height:1.5}
      .tz-meta{display:flex;align-items:center;gap:8px;margin-top:3px;flex-wrap:wrap}
      .src{color:#bbb;font-size:8px}
      .tz-link{color:#3498db;font-size:8px;text-decoration:none;word-break:break-all}
      @media print{
        body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
        .block{page-break-inside:avoid}
        .tz-section{page-break-inside:avoid}
      }`;

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>ТЗ Розбір</title><style>${css}</style></head><body>
      <div class="cover">
        <div class="label">РОЗБІР ТЗ</div>
        <div class="title">Технічне завдання</div>
        <div class="date">${new Date().toLocaleDateString("uk", { year: "numeric", month: "long", day: "numeric" })}</div>
      </div>
      ${annotationHtml}${commentsHtml}${tzHtml}
    </body></html>`;

    openPrintWindow(html, `RenderQA_TZ_${new Date().toISOString().slice(0,10)}.pdf`);
  }

  function generateReport() {
    const rImgs = readyFiles(renders).filter(f => f.pages?.some(p => p.b64));
    const validResults = perData.filter(d => d?.quality?.score);
    const avg = validResults.length ? Math.round(validResults.reduce((s,d) => s + d.quality.score, 0) / validResults.length) : null;
    const stdKey = avg ? (avg >= 80 ? "SDC" : avg >= 55 ? "MLR" : "NON") : null;
    const SC = { NON: "#e74c3c", MLR: "#e67e22", SDC: "#27ae60" };
    const stC = { ok: "#27ae60", warn: "#e67e22", fail: "#e74c3c", skipped: "#bbb" };
    const stI = { ok: "✅", warn: "⚠️", fail: "❌", skipped: "—" };
    const svC = { high: "#e74c3c", medium: "#e67e22", low: "#3498db" };
    const mC = { match: "#27ae60", mismatch: "#e74c3c", missing: "#9b59b6", unknown: "#aaa" };
    const mL = { match: "Відповідає", mismatch: "Невідповідність", missing: "Відсутній", unknown: "?" };
    const e = s => String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

    // ── ТЗ (колонки) ──
    const tzHtml = tzCards.length > 0 ? (() => {
      const grouped = tzCards.reduce((acc,c) => { if(!acc[c.category]) acc[c.category]=[]; acc[c.category].push(c); return acc; }, {});
      const cols = Object.entries(grouped).map(([cat, items]) => `
        <div class="tz-col">
          <div class="tz-cat">${e(cat)}</div>
          ${items.map(it => `<div class="tz-row">• ${e(it.text)}${it.source?` <span class="src">[${e(it.source)}]</span>`:""}</div>`).join("")}
        </div>`).join("");
      return `<div class="block tz-block"><div class="block-title">📋 Пункти ТЗ (${tzCards.length})</div><div class="tz-grid">${cols}</div></div>`;
    })() : "";

    // ── Ракурси ──
    const rendersHtml = perData.map((data, i) => {
      if (!data || data.error) return "";
      const thumb = rImgs[i]?.preview || rImgs[i]?.pages?.[0]?.preview;
      const sk = data.quality?.standard?.startsWith("SDC") ? "SDC" : data.quality?.standard?.startsWith("MLR") ? "MLR" : "NON";
      const checks = data.checks || [], defects = data.defects || [], mats = data.materials || [];

      const checksHtml = checks.length ? `
        <div class="sub-title">QA Перевірка</div>
        <div class="checks-grid">
          ${checks.map(c => `<div class="chk" style="border-left:3px solid ${stC[c.status]||"#eee"}">
            <div class="chk-top"><span class="chk-icon">${stI[c.status]||"—"}</span><span class="chk-id" style="color:${stC[c.status]||"#bbb"}">${e(c.id)}</span></div>
            <div class="chk-note">${e(c.note)}</div>
          </div>`).join("")}
        </div>` : "";

      const svAiRows = data.sverka || [];
      // активність пунктів відновлюється з AI-відповіді всередині sverkaRows
      const svRowsPdf = sverkaRows(svAiRows, data.sverkaOverrides, activeSverka([], mode));
      const svHtml = svAiRows.length ? `
        <div class="sub-title">Cross-Check (${svRowsPdf.filter(r => ["ok","warn","fail"].includes(r.status)).length}/${svRowsPdf.length})</div>
        <div class="def-list">
          ${svRowsPdf.map(r => `<div class="def-row">
            <span class="dot" style="background:${SVERKA_STATUS[r.status]?.color || "#aaa"}"></span>
            <div><b>${e(r.id)} ${e(r.label)}</b>${r.overridden ? ` <span class="tag">ПМ</span>` : ""}${r.doc_ref ? ` <span class="tag">${e(r.doc_ref)}</span>` : ""}${r.note ? `<br><span class="dim">${e(r.note)}</span>` : ""}</div>
          </div>`).join("")}
        </div>` : "";

      const defHtml = defects.length ? `
        <div class="sub-title">Дефекти (${defects.length})</div>
        <div class="def-list">
          ${defects.map(d => `<div class="def-row">
            <span class="dot" style="background:${svC[d.severity]||"#999"}"></span>
            <div><b>${e(d.title)}</b>${d.qa_tag?` <span class="tag">${e(d.qa_tag)}</span>`:""}${d.description?`<br><span class="dim">${e(d.description)}</span>`:""}</div>
          </div>`).join("")}
        </div>` : "";

      const matHtml = mats.length ? `
        <div class="sub-title">Матеріали (${mats.length})</div>
        <div class="mat-grid">
          ${mats.map(m => `<div class="mat-row">
            <span class="dot" style="background:${mC[m.status]||"#aaa"}"></span>
            <span class="mat-name">${e(m.name)}</span>
            <span style="color:${mC[m.status]||"#aaa"};font-size:9px">${mL[m.status]||""}</span>
          </div>`).join("")}
        </div>` : "";

      return `<div class="block render-block">
        <div class="render-top">
          ${thumb ? `<img src="${thumb}" class="thumb">` : ""}
          <div class="render-right">
            <div class="render-hdr">
              <span class="render-num">Ракурс ${i+1}${rImgs.length>1?` / ${rImgs.length}`:""}</span>
              ${data.quality?`<span class="badge" style="background:${SC[sk]}">${e(data.quality.standard)} ${data.quality.score}%</span>`:""}
              ${data.quality?.tz_score!=null?`<span class="badge" style="background:${data.quality.tz_score>=80?"#27ae60":data.quality.tz_score>=55?"#e67e22":"#e74c3c"}">ТЗ ${data.quality.tz_score}%${data.quality.tz_total?` (${data.quality.tz_done}/${data.quality.tz_total})`:""}</span>`:""}
            </div>
            ${data.summary?`<div class="summary">${e(data.summary)}</div>`:""}
          </div>
        </div>
        ${checksHtml}${svHtml}${defHtml}${matHtml}
      </div>`;
    }).join("");

    const css = `
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:Arial,sans-serif;font-size:11px;color:#333;background:#fff;padding:0}
      .cover{background:#1a1a1a;color:#f2f0ec;padding:24px 24px 20px;display:flex;align-items:center;gap:20px}
      .cover-text .label{font-size:9px;color:#555;letter-spacing:.15em;margin-bottom:4px}
      .cover-text .title{font-size:22px;font-weight:bold}
      .cover-text .date{font-size:10px;color:#777;margin-top:3px}
      .cover-score{margin-left:auto;text-align:right}
      .score-badge{display:inline-block;padding:6px 18px;border-radius:5px;color:#fff;font-size:18px;font-weight:bold}
      .score-desc{font-size:9px;color:#888;margin-top:3px}
      .global-sum{margin:10px 16px;background:#f5f4f1;border-radius:5px;padding:7px 10px;font-size:10px;color:#555;line-height:1.5}
      .block{margin:10px 16px;border:1px solid #e8e8e8;border-radius:6px;overflow:hidden;page-break-inside:avoid}
      .block-title{background:#f5f4f1;padding:6px 10px;font-size:10px;font-weight:bold;color:#333;border-bottom:1px solid #e8e8e8}
      .tz-block .tz-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:0;padding:8px 10px 4px}
      .tz-col{padding:0 8px 8px 0}
      .tz-cat{font-size:8px;font-weight:bold;color:#aaa;letter-spacing:.08em;margin-bottom:3px;text-transform:uppercase}
      .tz-row{font-size:10px;color:#444;line-height:1.45;padding:1px 0}
      .src{color:#ccc;font-size:8px}
      .render-block{padding:0}
      .render-top{display:flex;gap:10px;padding:8px 10px}
      .thumb{width:160px;height:105px;object-fit:cover;border-radius:4px;border:1px solid #ddd;flex-shrink:0}
      .render-right{flex:1;min-width:0}
      .render-hdr{display:flex;align-items:center;gap:8px;margin-bottom:5px}
      .render-num{font-size:10px;color:#888;font-weight:bold}
      .badge{color:#fff;padding:2px 8px;border-radius:3px;font-size:11px;font-weight:bold}
      .summary{font-size:10px;color:#555;line-height:1.5}
      .sub-title{font-size:9px;font-weight:bold;color:#555;background:#fafafa;border-top:1px solid #eee;border-bottom:1px solid #eee;padding:3px 10px;letter-spacing:.05em;text-transform:uppercase}
      .checks-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:0;padding:4px 6px}
      .chk{padding:3px 6px;margin:2px;border-radius:3px;background:#fafafa}
      .chk-top{display:flex;align-items:center;gap:4px;margin-bottom:1px}
      .chk-icon{font-size:10px}
      .chk-id{font-size:9px;font-weight:bold}
      .chk-note{font-size:9px;color:#666;line-height:1.35}
      .def-list{padding:4px 10px}
      .def-row{display:flex;gap:7px;align-items:flex-start;padding:3px 0;border-bottom:1px solid #f5f5f5;font-size:10px}
      .mat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));padding:4px 10px;gap:0}
      .mat-row{display:flex;align-items:center;gap:6px;padding:2px 0;font-size:10px}
      .mat-name{flex:1;font-weight:bold}
      .dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;margin-top:2px}
      .tag{font-size:8px;color:#aaa;font-weight:normal}
      .dim{font-size:9px;color:#999}
      @media print{
        body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
        .tz-block{page-break-after:always}
        .render-block{page-break-inside:avoid}
      }`;

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Render QA Report</title><style>${css}</style></head><body>
      <div class="cover">
        <div class="cover-text">
          <div class="label">RENDER QA REPORT</div>
          <div class="title">QA Report</div>
          <div class="date">${new Date().toLocaleDateString("uk",{year:"numeric",month:"long",day:"numeric"})}</div>
        </div>
        ${stdKey?`<div class="cover-score"><div class="score-badge" style="background:${SC[stdKey]}">${stdKey} ${avg}%</div><div class="score-desc">${e(STANDARDS[stdKey].desc)}</div></div>`:""}
      </div>
      ${globalSum?`<div class="global-sum">${e(globalSum)}</div>`:""}
      ${tzHtml}
      ${rendersHtml}
    </body></html>`;

    openPrintWindow(html, `RenderQA_Report_${new Date().toISOString().slice(0,10)}.pdf`);
  }

  async function parseTzCards() {
    if (!anthropicKey.trim()) { setErr("Введіть Anthropic API ключ"); return; }
    const briefsList = readyFiles(briefs);
    const refsList = readyFiles(refs);
    const drawsList = readyFiles(draws);
    const hasMaterials = briefText.trim() || briefsList.length > 0 || refsList.length > 0 || drawsList.length > 0;
    if (!hasMaterials) { setTzCards([]); setTzReview(true); return; }
    setTzParsing(true); setErr("");
    const mn = matNote([...briefsList, ...drawsList]);

    // Build image index: label → preview URL (matches filesToParts labeling)
    const imgIndex = {};
    const indexFiles = (files, label) => {
      (files || []).forEach((f, fi) => {
        (f.pages || []).filter(p => p.b64).forEach((pg, pi) => {
          const key = `${label} ${fi + 1}${pi > 0 ? ` стор.${pi + 1}` : ""}`;
          if (pg.preview) imgIndex[key.toLowerCase()] = pg.preview;
        });
      });
    };
    indexFiles(briefsList, "БРИФ");
    indexFiles(refsList, "РЕФЕРЕНС");
    indexFiles(drawsList, "КРЕСЛЕННЯ");

    const parts = [{ type: "text", text: `Ти — PM студії 3D-візуалізації. Розбери всі надані матеріали та поверни структурований опис проекту і повний перелік вимог.

ВАЖЛИВО — формат матеріалів: PDF-сторінки надаються парами: спочатку блок "підписи та анотації на сторінці" (витягнутий текстовий шар), потім зображення тієї ж сторінки. Текст і зображення — це ОДНА сторінка. Стрілки, підписи, виноски на зображенні — це ті самі слова що ти бачиш у текстовому блоці поруч. Використовуй це для точного розуміння що куди застосовується.

ТЗ ТЕКСТ:
${briefText.trim() || "(дивись прикріплені матеріали)"}${mn}

ЗАВДАННЯ 1 — project_annotation:
Напиши розгорнутий опис роботи яку потрібно виконати (4-8 речень). Включи:
• Що саме візуалізується (тип простору/об'єкту, назва якщо є)
• Площа, планування, кількість приміщень/ракурсів якщо вказано
• Стиль та атмосфера (скандинавський, класичний, лофт, вечірній/денний тощо)
• Ключові матеріали та кольорова палітра
• Тип та характер освітлення
• Що надано: креслення (які саме), референси, специфікації
• Особливі вимоги клієнта або технічні обмеження
• Що художник повинен перевірити особливо уважно

ЗАВДАННЯ 2 — tz_parsed:
КРИТИЧНО: знайди АБСОЛЮТНО ВСІ вимоги — жодного матеріалу, жодного меблю, жодного пункту не пропускати. Краще додати зайве ніж пропустити.
- Кожен пункт = ОДНА конкретна вимога
- text = ПОВНИЙ опис: назва + матеріал + колір (назва або HEX) + відділка + розмір + марка якщо є
- НЕ пиши загальні фрази — лише конкретику
- img_ref: мітка сторінки де ЗОБРАЖЕНО цей матеріал/предмет (напр. "РЕФЕРЕНС 1 стор.2", "БРИФ 1") або null — вказуй навіть якщо це бриф, не тільки референс
- link: URL-посилання на матеріал/продукт якщо є в брифі (повне https://... посилання) або null
- source: "бриф", "референс", "креслення", "ТЗ"
- Не вигадуй вимоги яких немає в матеріалах
- Категорії: "Матеріали та текстури", "Меблі та моделі", "Сезон / атмосфера", "Тип освітлення", "Креслення та планування", "Логотип / написи", "Вимоги клієнта", "Специфічні запити"

ЗАВДАННЯ 3 — client_comments:
Уважно проглянь кожну сторінку і знайди ВСІ коментарі/побажання клієнта — вони можуть бути:
- в рамках, прямокутниках, обведених блоках
- просто як текст на сторінці (підписи, нотатки, побажання)
- стрілки з підписами, виносками
- будь-який текст що виглядає як коментар або вимога клієнта
Кожен окремий коментар/блок = окремий елемент масиву.
- page: мітка сторінки (напр. "БРИФ 1", "БРИФ 1 стор.2")
- text: точний текст дослівно, нічого не змінюй, не скорочуй, не додавай

ВІДПОВІДАЙ ТІЛЬКИ JSON:
{"project_annotation":"Візуалізація вітальні площею ~35м² у скандинавському стилі. Денне освітлення через великі вікна зліва, м'які розсіяні тіні. Підлога — дубовий паркет натуральний, стіни — біла матова штукатурка. Меблі: сірий велюровий диван, журнальний столик зі скла та металу. Надано: флорплан з розстановкою меблів та 3 референси атмосфери. Особлива увага — консистентність матеріалів між ракурсами та відповідність розташування меблів плану.","client_comments":[{"page":"БРИФ 1","text":"Диван має бути пудрово-рожевий, не бежевий. Підлога тільки дуб, без імітацій."},{"page":"БРИФ 1 стор.2","text":"Штори обов'язково — довгі, до підлоги, колір слонова кістка."}],"tz_parsed":[{"category":"Матеріали та текстури","items":[{"id":"tz1","text":"Підлога — паркет дуб 180×1200мм, колір натуральний, матовий лак","source":"бриф","img_ref":"БРИФ 1","link":null},{"id":"tz2","text":"Диван — оксамит пудровий рожевий #D4A5A0","source":"референс","img_ref":"РЕФЕРЕНС 1 стор.2","link":"https://example.com/fabric/velvet-pink"}]}]}` }];
    parts.push(...filesToParts(briefsList, "БРИФ"));
    parts.push(...filesToParts(refsList, "РЕФЕРЕНС"));
    parts.push(...filesToParts(drawsList, "КРЕСЛЕННЯ"));
    try {
      const result = await callAPI(parts, 2, anthropicKey);
      const cards = []; let counter = 1;
      (result.tz_parsed || []).forEach(group => {
        (group.items || []).forEach(item => {
          cards.push({
            id: item.id || `tz${counter}`,
            category: group.category || "Загальні вимоги",
            text: item.text || "",
            source: item.source || "",
            imgPreview: item.img_ref ? (imgIndex[item.img_ref.toLowerCase()] || null) : null,
            link: item.link || null,
          });
          counter++;
        });
      });
      setTzCards(cards);
      if (result.project_annotation) setTzAnnotation(result.project_annotation);
      if (result.client_comments?.length) setTzClientComments(result.client_comments);
      saveSession({ savedAt: new Date().toISOString(), mode: "tz-review", tzCards: cards.map(c => ({ ...c, imgPreview: null })), tzAnnotation: result.project_annotation || "", tzClientComments: result.client_comments || [] });
    } catch (e) { setErr(`Помилка розбору ТЗ: ${e.message}`); setTzCards([]); }
    setTzParsing(false); setTzReview(true);
  }

async function loadFromArchivizer() {
    if (!archivizerToken.trim()) { setArchivizerStatus({ error: "Введіть Archivizer токен" }); return; }
    if (!archivizerUrl.trim()) { setArchivizerStatus({ error: "Введіть посилання на задачу" }); return; }
    const match = archivizerUrl.match(/tasks\/([^/?#\s]+)/);
    if (!match) { setArchivizerStatus({ error: "Невірне посилання. Приклад: https://archivizer.com/tasks/WF8PSTKA" }); return; }
    const taskId = match[1];
    const headers = { "Content-Type": "application/json", "Authorization": `Bearer ${archivizerToken.trim()}` };
    const arcFetch = async (url, body) => {
      const r = await fetch(url, { method: "POST", headers: { ...headers, "x-real-method": "GET" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    };
    const proxyUrl = u => (u || "").replace("https://static.archivizer.com", "/archivizer-static");

    try {
      // 2. Повідомлення задачі
      setArchivizerStatus({ loading: true, msg: "Завантаження повідомлень..." });
      let messages = [];
      const msgEndpoints = [
        ["/archivizer/api/v3/messages", { filters: { task_id: taskId } }],
        [`/archivizer/api/v3/tasks/${taskId}/messages`, {}],
      ];
      for (const [url, body] of msgEndpoints) {
        try {
          const msgData = await arcFetch(url, body);
          const items = msgData.data || msgData || [];
          if (Array.isArray(items) && items.length >= 0) {
            messages = items;
            console.log(`Messages loaded from ${url}:`, messages.length);
            break;
          }
        } catch(e) { console.log(`Messages endpoint ${url} failed: ${e.message}`); }
      }
      if (messages.length === 0) console.warn("All message endpoints failed or returned empty");

      // Автозаповнення поля ТЗ — задача + повідомлення
      const tzLines = [];
      if (messages.length > 0) {
        tzLines.push("\nПОВІДОМЛЕННЯ:");
        messages.forEach(m => {
          const author = m.user?.name || m.author?.name || m.sender?.name || "?";
          const text = (m.body || m.text || m.content || "").trim();
          const time = m.created_at ? new Date(m.created_at).toLocaleDateString("uk") : "";
          if (text) tzLines.push(`[${time} ${author}]: ${text}`);
        });
      }
      if (tzLines.length > 0) setBriefText(tzLines.join("\n"));

      // 3. Список файлів (з пагінацією)
      setArchivizerStatus({ loading: true, msg: "Завантаження списку файлів..." });
      const fetchAllPages = async (endpoint, filters) => {
        const items = [];
        let page = 1;
        while (true) {
          const data = await arcFetch(endpoint, { filters, page, per_page: 50 });
          const batch = data.data || (Array.isArray(data) ? data : []);
          items.push(...batch);
          console.log(`${endpoint} page ${page}: ${batch.length} items, has_more: ${data.meta?.has_more}`);
          if (!data.meta?.has_more || batch.length === 0) break;
          page++;
          if (page > 20) break; // safety limit
        }
        return items;
      };

      const allFiles = await fetchAllPages("/archivizer/api/v3/file_attachments", { task_id: taskId });
      console.log("Total files fetched:", allFiles.length);
      if (!allFiles.length) { setArchivizerStatus({ ok: "Файлів не знайдено" }); return; }

      // 4. Claude аналізує файли (якщо є API ключ)
      let categories = {}; // index -> "render"|"brief"|"reference"|"drawing"|"skip"
      if (anthropicKey.trim()) {
        setArchivizerStatus({ loading: true, msg: "Клод аналізує файли задачі..." });
        const msgContext = messages.length > 0
          ? messages.slice(-30).map(m => {
              const author = m.user?.name || m.author?.name || m.sender?.name || "?";
              const text = (m.body || m.text || m.content || "").slice(0, 300);
              const time = m.created_at ? new Date(m.created_at).toLocaleDateString("uk") : "";
              return `[${time} ${author}]: ${text}`;
            }).join("\n")
          : "";

        const fileList = allFiles.map((f, i) =>
          `${i}: "${f.name}" (${f.size ? Math.round(f.size/1024)+"KB" : "?"}, ${f.content_type || ""})`
        ).join("\n");

        const prompt = `Ти — QA-асистент для перевірки 3D-рендерів інтер'єрів.
${msgContext ? `\nПовідомлення в задачі (від клієнта та команди):\n${msgContext}\n` : ""}
Список файлів задачі:
${fileList}

Визнач категорію кожного файлу з урахуванням контексту задачі та повідомлень. Відповідай ТІЛЬКИ JSON масивом без пояснень:
[{"i":0,"cat":"render"}, ...]

Категорії:
- "render" — фінальний рендер для QA (зображення інтер'єру/кімнати що здається на перевірку)
- "brief" — ТЗ, бриф, специфікація, таблиця матеріалів, прайс, Excel/CSV, Word, PDF з описом
- "reference" — референс зображення, мудборд, фото для настрою (не рендер цього проекту)
- "drawing" — креслення, план, DWG, DXF файл
- "skip" — архіви, технічні файли, дублікати, непотрібне`;
        try {
          const resp = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true", "x-api-key": anthropicKey.trim() },
            body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1000, messages: [{ role: "user", content: prompt }] })
          });
          const data = await resp.json();
          const text = data.content?.[0]?.text || "";
          const jsonMatch = text.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            try {
              const parsed = JSON.parse(jsonMatch[0]);
              parsed.forEach(({ i, cat }) => { if (typeof i === "number" && cat) categories[i] = cat; });
              console.log("Claude categorization:", categories);
            } catch (parseErr) {
              console.warn("Claude categorization: invalid JSON in response:", parseErr.message, text.slice(0, 200));
            }
          }
        } catch(e) { console.warn("Claude categorization failed:", e.message); }
      }

      // Fallback: якщо Claude не відповів — визначаємо по розширенню
      const isImageExt = name => /\.(jpe?g|png|webp|gif|bmp|tiff?)$/i.test(name || "");
      const isDwgExt = name => /\.(dwg|dxf)$/i.test(name || "");
      const getCategoryFallback = f => {
        const nm = f.name || "";
        if (isImageExt(nm)) return "render";
        if (isDwgExt(nm)) return "drawing";
        return "brief";
      };

      // 4. Завантажуємо файли в слоти
      let counts = { render: 0, brief: 0, reference: 0, drawing: 0, skip: 0 };
      for (let i = 0; i < allFiles.length; i++) {
        const f = allFiles[i];
        const cat = categories[i] || getCategoryFallback(f);
        if (cat === "skip") { counts.skip++; continue; }
        const rawUrl = f.file || f.url || f.file_url || f.original_url || f.download_url;
        if (!rawUrl) continue;
        const url = proxyUrl(rawUrl);
        const name = f.name || f.filename || "file";
        const ct = f.content_type || f.mime_type || "";
        setArchivizerStatus({ loading: true, msg: `[${cat}] ${name}` });
        try {
          const blob = await fetch(url).then(r => r.blob());
          const file = new File([blob], name, { type: blob.type || ct });
          if (cat === "render") { renders.add(file); counts.render++; }
          else if (cat === "reference") { refs.add(file); counts.reference++; }
          else if (cat === "drawing") { draws.add(file); counts.drawing++; }
          else { briefs.add(file); counts.brief++; }
        } catch(e) { console.error(`Failed to download [${cat}] ${name}:`, e); }
      }

      const summary = [
        counts.render && `${counts.render} рендерів`,
        counts.brief && `${counts.brief} брифів`,
        counts.reference && `${counts.reference} референсів`,
        counts.drawing && `${counts.drawing} креслень`,
        counts.skip && `${counts.skip} пропущено`,
      ].filter(Boolean).join(", ");
      setArchivizerStatus({ ok: `Завантажено: ${summary}` });
    } catch (e) {
      setArchivizerStatus({ error: `Помилка: ${e.message}` });
    }
  }


  function reset() {
    setStep(1); setSel(null); setErr(""); setBriefText("");
    renders.ref.current = []; briefs.ref.current = []; refs.ref.current = []; draws.ref.current = [];
    revBriefs.ref.current = []; revRefs.ref.current = []; revDraws.ref.current = [];
    pairBefores.current = {}; pairAfters.current = {};
    setPairs([{ id: 1, comment: "" }]); setPerData([]); setStatuses([]); setGlobalSum("");
    setTzCards([]); setTzAnnotation(""); setTzClientComments([]); setTzReview(false); setTzParsing(false); setConsistency(null); setConsistencyLoading(false); clearSession(); setSavedSession(null);
  }

  const isRev = mode === "revision";
  const vPairs = pairs.filter(p => {
    const b = getPF(p.id, "before").filter(f => !f._loading && !f._error && (f.pages?.some(pg => pg.b64) || f.type === "excel"));
    const a = getPF(p.id, "after").filter(f => !f._loading && !f._error && (f.pages?.some(pg => pg.b64) || f.type === "excel"));
    return b.length > 0 && a.length > 0;
  });
  const rImages = readyFiles(renders).filter(f => f.pages?.some(p => p.b64));
  const gridItems = isRev ? vPairs.map(p => ({ befores: getPF(p.id, "before").filter(f => !f._loading && !f._error), afters: getPF(p.id, "after").filter(f => !f._loading && !f._error) })) : rImages;
  const getDP = (i) => {
    if (isRev) { const p = vPairs[i]; return { renderFiles: getPF(p.id, "after").filter(f => !f._loading && !f._error), beforeFiles: getPF(p.id, "before").filter(f => !f._loading && !f._error), drawings: revDraws.files }; }
    return { renderFiles: [rImages[i]], beforeFiles: [], drawings: draws.files };
  };
  const allDocFiles = isRev
    ? [...revBriefs.files, ...revRefs.files, ...revDraws.files]
    : [...briefs.files, ...refs.files, ...draws.files];
  const sverkaChecksUi = activeSverka(allDocFiles.map(f => f._docType), mode);
  const detailProps = sel !== null && sel < gridItems.length ? getDP(sel) : null;

  return (
    <div className="qa-bg" style={{ minHeight: "100vh", fontFamily: "var(--font-ui)" }}>
      <div style={{ background: "#1a1a1a", color: "#f2f0ec", padding: "12px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100 }}>
        <div>
          <div style={{ fontSize: 10, letterSpacing: "0.2em", color: "#555", fontFamily: "monospace" }}>RENDER QA</div>
          <div style={{ fontSize: 16, fontWeight: 400, letterSpacing: "0.05em" }}>Перевірка рендерів</div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {step === 2 && sel !== null && <button onClick={() => setSel(null)} style={{ background: "transparent", border: "1px solid #444", color: "#aaa", padding: "5px 12px", cursor: "pointer", fontSize: 11, fontFamily: "monospace", borderRadius: 4 }}>← {isRev ? "Раунди" : "Ракурси"}</button>}
          {step === 2 && <button onClick={reset} style={{ background: "transparent", border: "1px solid #444", color: "#aaa", padding: "5px 12px", cursor: "pointer", fontSize: 11, fontFamily: "monospace", borderRadius: 4 }}>← Нова перевірка</button>}
          {step === 2 && perData.some(d => d && !d.error) && <button onClick={generateReport} style={{ background: "transparent", border: "1px solid #27ae60", color: "#27ae60", padding: "5px 12px", cursor: "pointer", fontSize: 11, fontFamily: "monospace", borderRadius: 4 }}>📄 PDF</button>}
          <input
            type="password"
            value={anthropicKey}
            onChange={e => saveAnthropicKey(e.target.value)}
            placeholder="Anthropic API key"
            style={{ background: "#111", border: `1px solid ${anthropicKey ? "#27ae60" : "#555"}`, color: "#aaa", padding: "5px 10px", fontSize: 11, fontFamily: "monospace", borderRadius: 4, width: 180, outline: "none" }}
          />
        </div>
      </div>

      {step === 1 && savedSession && (
        <div style={{ margin: "0 24px 12px", background: "#fff", border: "1px solid #3498db33", borderRadius: 10, padding: "10px 16px", display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 13 }}>💾</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#333", fontFamily: "monospace" }}>{savedSession.mode === "tz-review" ? "Збережений розбір ТЗ" : "Є збережена сесія"}</div>
            <div style={{ fontSize: 10, color: "#aaa", fontFamily: "monospace" }}>{new Date(savedSession.savedAt).toLocaleString("uk")} {savedSession.mode === "tz-review" ? `· ${savedSession.tzCards?.length || 0} пунктів` : `· ${savedSession.perData?.filter(Boolean).length || 0} ракурсів`}</div>
          </div>
          <button onClick={() => {
            if (savedSession.mode === "tz-review") {
              setMode("tz-review");
              if (savedSession.tzCards?.length) setTzCards(savedSession.tzCards);
              if (savedSession.tzAnnotation) setTzAnnotation(savedSession.tzAnnotation);
              if (savedSession.tzClientComments?.length) setTzClientComments(savedSession.tzClientComments);
              setTzReview(true); setSavedSession(null);
            } else {
              setMode(savedSession.mode || "first");
              setPerData(savedSession.perData || []);
              setGlobalSum(savedSession.globalSum || "");
              setConsistency(savedSession.consistency || null);
              if (savedSession.tzCards?.length) setTzCards(savedSession.tzCards);
              if (savedSession.tzAnnotation) setTzAnnotation(savedSession.tzAnnotation);
              if (savedSession.tzClientComments?.length) setTzClientComments(savedSession.tzClientComments);
              setStep(2); setSavedSession(null);
            }
          }} style={{ background: "#3498db", color: "#fff", border: "none", padding: "6px 14px", borderRadius: 6, fontSize: 11, fontFamily: "monospace", cursor: "pointer" }}>
            Відновити →
          </button>
          <button onClick={() => { clearSession(); setSavedSession(null); }} style={{ background: "none", border: "1px solid #e0ddd8", color: "#aaa", padding: "6px 10px", borderRadius: 6, fontSize: 11, fontFamily: "monospace", cursor: "pointer" }}>
            ✕
          </button>
        </div>
      )}

      {step === 1 && tzReview && mode !== "revision" && (
        <TzReviewStep
          cards={tzCards}
          onRemove={id => setTzCards(prev => prev.filter(c => c.id !== id))}
          onEdit={(id, text) => setTzCards(prev => prev.map(c => c.id === id ? { ...c, text } : c))}
          onBack={() => setTzReview(false)}
          onProceed={mode === "first" ? runAnalysis : undefined}
          hasRenders={mode === "first" ? rImages.length > 0 : false}
          annotation={tzAnnotation}
          clientComments={tzClientComments}
          onSavePdf={generateTzReport}
          onUseInCheck={mode === "tz-review" ? () => { setMode("first"); } : undefined}
        />
      )}
      {step === 1 && !tzReview && (
        <div style={{ maxWidth: "100%", width: "100%", padding: "22px 24px", display: "flex", flexDirection: "column", gap: 16, boxSizing: "border-box" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            {[
              { id: "tz-review", icon: "📋", label: "Розбір ТЗ",          desc: "Структурувати ТЗ у чекліст" },
              { id: "first",     icon: "🎯", label: "Перший результат",   desc: "Рендер vs ТЗ, референси, специфікація" },
              { id: "revision",  icon: "🔄", label: "Порівняння раундів", desc: "ДО vs ПІСЛЯ — чи внесені правки" },
            ].map(m => (
              <div key={m.id} onClick={() => { setMode(m.id); setErr(""); }} style={{ background: mode === m.id ? "#1a1a1a" : "#fff", color: mode === m.id ? "#f2f0ec" : "#444", border: `2px solid ${mode === m.id ? "#1a1a1a" : "#e0ddd8"}`, borderRadius: 10, padding: "14px 16px", cursor: "pointer", transition: "all 0.15s" }}>
                <div style={{ fontSize: 20, marginBottom: 4 }}>{m.icon}</div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{m.label}</div>
                <div style={{ fontSize: 10, opacity: 0.5, fontFamily: "monospace" }}>{m.desc}</div>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {QA_CHECKS.map(q => <div key={q.id} style={{ display: "flex", alignItems: "center", gap: 4, background: "#fff", border: `1px solid ${q.color}33`, borderLeft: `3px solid ${q.color}`, borderRadius: "0 5px 5px 0", padding: "3px 8px" }}><span style={{ fontSize: 9, fontWeight: "bold", color: q.color, fontFamily: "monospace" }}>#{q.id}</span><span style={{ fontSize: 10, color: "#555", fontFamily: "monospace" }}>{q.label}</span></div>)}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {Object.entries(STANDARDS).map(([k, v]) => <div key={k} style={{ flex: 1, minWidth: 140, background: v.bg, border: `1px solid ${v.color}44`, borderLeft: `4px solid ${v.color}`, borderRadius: "0 8px 8px 0", padding: "7px 11px" }}><div style={{ fontSize: 13, fontWeight: 700, color: v.color, fontFamily: "monospace", marginBottom: 2 }}>{k}</div><div style={{ fontSize: 10, color: "#666", fontFamily: "monospace" }}>{v.desc}</div></div>)}
          </div>
          <div style={{ height: 1, background: "#ddd" }} />
          {mode === "tz-review" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <div style={{ fontSize: 10, letterSpacing: "0.14em", color: "#888", marginBottom: 5, fontFamily: "monospace" }}>ТЗ — ТЕКСТ</div>
                <textarea value={briefText} onChange={e => setBriefText(e.target.value)} placeholder={"• Інтер'єр вітальні у скандинавському стилі\n• Або залиште порожнім — ТЗ у файлах нижче"} style={{ width: "100%", minHeight: 80, padding: "10px 12px", border: "1px solid #ddd", borderRadius: 8, background: "#fff", fontSize: 13, lineHeight: 1.7, fontFamily: "monospace", resize: "vertical", color: "#333", outline: "none", boxSizing: "border-box" }} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                <UploadBox label="БРИФИ" note="PDF, зобр., Excel/CSV" files={briefs.files} onAdd={briefs.add} onAddDone={briefs.addDone} onRemove={briefs.remove} onDocType={briefs.updateDocType} color="#e74c3c" />
                <UploadBox label="РЕФЕРЕНСИ" note="Зображення" files={refs.files} onAdd={refs.add} onAddDone={refs.addDone} onRemove={refs.remove} onTag={refs.updateTag} onDocType={refs.updateDocType} color="#e67e22" />
                <DwgSlot
                  files={draws.files}
                  onAddDwg={draws.add}
                  onRemove={draws.remove}
                  onConverted={(dwgFile, dxfText) => handleDwgConverted(draws, dwgFile, dxfText)}
                  onDocType={draws.updateDocType}
                />
              </div>
            </div>
          )}
          {mode === "first" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ background: "#0d1a2b", border: "1px solid #2980b944", borderRadius: 10, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ fontSize: 10, letterSpacing: "0.14em", color: "#2980b9", fontFamily: "monospace", marginBottom: 4 }}>ARCHIVIZER</div>
                <input type="password" value={archivizerToken} onChange={e => saveArchivizerToken(e.target.value)} placeholder="API токен" style={{ width: "100%", background: "#111", border: `1px solid ${archivizerToken ? "#27ae60" : "#333"}`, color: "#aaa", padding: "6px 10px", fontSize: 11, fontFamily: "monospace", borderRadius: 4, outline: "none", boxSizing: "border-box", marginBottom: 6 }} />
                <div style={{ display: "flex", gap: 8 }}>
                  <input type="text" value={archivizerUrl} onChange={e => setArchivizerUrl(e.target.value)} onKeyDown={e => e.key === "Enter" && loadFromArchivizer()} placeholder="https://archivizer.com/tasks/WF8PSTKA" style={{ flex: 1, background: "#111", border: "1px solid #333", color: "#aaa", padding: "6px 10px", fontSize: 11, fontFamily: "monospace", borderRadius: 4, outline: "none" }} />
                  <button onClick={loadFromArchivizer} disabled={archivizerStatus?.loading} style={{ background: archivizerStatus?.loading ? "#333" : "#2980b9", border: "none", color: "#fff", borderRadius: 4, padding: "6px 16px", cursor: archivizerStatus?.loading ? "not-allowed" : "pointer", fontSize: 11, fontFamily: "monospace", whiteSpace: "nowrap" }}>
                    {archivizerStatus?.loading ? "Завантаження..." : "Завантажити"}
                  </button>
                </div>
                {archivizerStatus && <div style={{ fontSize: 10, fontFamily: "monospace", color: archivizerStatus.error ? "#e74c3c" : archivizerStatus.ok ? "#27ae60" : "#aaa" }}>{archivizerStatus.error || archivizerStatus.ok || archivizerStatus.msg}</div>}
              </div>
              <UploadBox label="РЕНДЕРИ" files={renders.files} onAdd={renders.add} onAddDone={renders.addDone} onRemove={renders.remove} color="#1a1a1a" />
              <div>
                <div style={{ fontSize: 10, letterSpacing: "0.14em", color: "#888", marginBottom: 5, fontFamily: "monospace" }}>ТЗ — ТЕКСТ</div>
                <textarea value={briefText} onChange={e => setBriefText(e.target.value)} placeholder={"• Інтер'єр вітальні у скандинавському стилі\n• Або залиште порожнім — ТЗ у файлах нижче"} style={{ width: "100%", minHeight: 80, padding: "10px 12px", border: "1px solid #ddd", borderRadius: 8, background: "#fff", fontSize: 13, lineHeight: 1.7, fontFamily: "monospace", resize: "vertical", color: "#333", outline: "none", boxSizing: "border-box" }} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                <UploadBox label="БРИФИ" note="PDF, зобр., Excel/CSV" files={briefs.files} onAdd={briefs.add} onAddDone={briefs.addDone} onRemove={briefs.remove} onDocType={briefs.updateDocType} color="#e74c3c" />
                <UploadBox label="РЕФЕРЕНСИ" note="Зображення" files={refs.files} onAdd={refs.add} onAddDone={refs.addDone} onRemove={refs.remove} onTag={refs.updateTag} onDocType={refs.updateDocType} color="#e67e22" />
                <DwgSlot
                  files={draws.files}
                  onAddDwg={draws.add}
                  onRemove={draws.remove}
                  onConverted={(dwgFile, dxfText) => handleDwgConverted(draws, dwgFile, dxfText)}
                  onDocType={draws.updateDocType}
                />
              </div>
              <div style={{ background: "#f0faf4", border: "1px solid #27ae6033", borderRadius: 8, padding: "8px 12px", fontSize: 11, color: "#555", fontFamily: "monospace" }}>
                💡 Excel/CSV з переліком матеріалів — Claude перевірить відповідність кожного на рендері
              </div>
            </div>
          )}
          {isRev && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {pairs.map((pair, pi) => (
                <div key={pair.id} style={{ background: "#fff", border: "1px solid #e8e6e1", borderRadius: 12, padding: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                    <div style={{ fontSize: 11, fontFamily: "monospace", fontWeight: 600, color: "#555" }}>РАУНД {pi + 1}</div>
                    {pairs.length > 1 && <button onClick={() => setPairs(p => p.filter((_, j) => j !== pi))} style={{ background: "none", border: "1px solid #ddd", color: "#bbb", borderRadius: 5, cursor: "pointer", fontSize: 10, padding: "2px 8px", fontFamily: "monospace" }}>видалити</button>}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
                    <UploadBox label="ДО" files={getPF(pair.id, "before")} onAdd={f => addPF(pair.id, "before", f)} onRemove={i => removePF(pair.id, "before", i)} color="#888" onAddDone={f => { const id = "f"+Date.now()+"_"+Math.random().toString(36).slice(2); pairBefores.current[pair.id]=[...(pairBefores.current[pair.id]||[]),{...f,_id:id}]; bumpPairs(); }} />
                    <UploadBox label="ПІСЛЯ" files={getPF(pair.id, "after")} onAdd={f => addPF(pair.id, "after", f)} onRemove={i => removePF(pair.id, "after", i)} color="#27ae60" onAddDone={f => { const id = "f"+Date.now()+"_"+Math.random().toString(36).slice(2); pairAfters.current[pair.id]=[...(pairAfters.current[pair.id]||[]),{...f,_id:id}]; bumpPairs(); }} />
                  </div>
                  <textarea value={pair.comment} onChange={e => setPairs(p => p.map((x, j) => j === pi ? { ...x, comment: e.target.value } : x))} placeholder="• Правки до цього раунду (опціонально)" style={{ width: "100%", minHeight: 65, padding: "9px 11px", border: "1px solid #ddd", borderRadius: 8, background: "#fafafa", fontSize: 13, lineHeight: 1.7, fontFamily: "monospace", resize: "vertical", color: "#333", outline: "none", boxSizing: "border-box" }} />
                </div>
              ))}
              <button onClick={() => setPairs(p => [...p, { id: Date.now(), comment: "" }])} style={{ background: "transparent", border: "2px dashed #ddd", color: "#aaa", padding: "11px", cursor: "pointer", fontSize: 11, fontFamily: "monospace", borderRadius: 10 }}>+ додати раунд</button>
              <div style={{ height: 1, background: "#ddd" }} />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                <UploadBox label="БРИФИ" note="PDF, Excel/CSV" files={revBriefs.files} onAdd={revBriefs.add} onAddDone={revBriefs.addDone} onRemove={revBriefs.remove} onDocType={revBriefs.updateDocType} color="#e74c3c" />
                <UploadBox label="РЕФЕРЕНСИ" files={revRefs.files} onAdd={revRefs.add} onAddDone={revRefs.addDone} onRemove={revRefs.remove} onDocType={revRefs.updateDocType} color="#e67e22" />
                <DwgSlot
                  files={revDraws.files}
                  onAddDwg={revDraws.add}
                  onRemove={revDraws.remove}
                  onConverted={(dwgFile, dxfText) => handleDwgConverted(revDraws, dwgFile, dxfText)}
                  onDocType={revDraws.updateDocType}
                />
              </div>
            </div>
          )}
          {err && <div style={{ color: "#e74c3c", fontSize: 12, fontFamily: "monospace", padding: "10px 13px", background: "#fff5f5", borderRadius: 6, border: "1px solid #fcc" }}>{err}</div>}
          {mode === "revision"
            ? <button onClick={runAnalysis} style={{ background: "#1a1a1a", color: "#f2f0ec", border: "none", padding: "14px", fontSize: 12, letterSpacing: "0.14em", fontFamily: "monospace", cursor: "pointer", borderRadius: 8 }}>ПОРІВНЯТИ РАУНДИ →</button>
            : mode === "tz-review"
              ? <button onClick={parseTzCards} disabled={tzParsing} style={{ background: tzParsing ? "#444" : "#1a1a1a", color: "#f2f0ec", border: "none", padding: "14px", fontSize: 12, letterSpacing: "0.14em", fontFamily: "monospace", cursor: tzParsing ? "not-allowed" : "pointer", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%" }}>
                  {tzParsing ? <><div style={{ width: 12, height: 12, border: "1.5px solid #aaa", borderTop: "1.5px solid #fff", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />РОЗБИРАЮ ТЗ…</> : "РОЗІБРАТИ ТЗ →"}
                </button>
              : tzCards.length > 0
                ? <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ background: "#f0faf4", border: "1px solid #27ae6033", borderRadius: 8, padding: "8px 12px", fontSize: 11, color: "#27ae60", fontFamily: "monospace", display: "flex", alignItems: "center", gap: 8 }}>
                      ✓ ТЗ розібрано — {tzCards.length} пунктів. <button onClick={() => { setTzCards([]); setTzAnnotation(""); setTzClientComments([]); }} style={{ background: "none", border: "none", color: "#aaa", fontSize: 10, fontFamily: "monospace", cursor: "pointer", padding: 0, marginLeft: "auto" }}>скинути</button>
                    </div>
                    <button onClick={() => setTzReview(true)} style={{ background: "#1a1a1a", color: "#f2f0ec", border: "none", padding: "14px", fontSize: 12, letterSpacing: "0.14em", fontFamily: "monospace", cursor: "pointer", borderRadius: 8, width: "100%" }}>
                      ПЕРЕЙТИ ДО ПЕРЕВІРКИ ({tzCards.length} пунктів ТЗ) →
                    </button>
                  </div>
                : <button onClick={parseTzCards} disabled={tzParsing} style={{ background: tzParsing ? "#444" : "#1a1a1a", color: "#f2f0ec", border: "none", padding: "14px", fontSize: 12, letterSpacing: "0.14em", fontFamily: "monospace", cursor: tzParsing ? "not-allowed" : "pointer", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%" }}>
                    {tzParsing ? <><div style={{ width: 12, height: 12, border: "1.5px solid #aaa", borderTop: "1.5px solid #fff", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />РОЗБИРАЮ ТЗ…</> : "РОЗІБРАТИ ТЗ →"}
                  </button>
          }
        </div>
      )}

      {step === 2 && sel === null && consistencyLoading && (
        <div style={{ margin: "0 24px 12px", background: "#fff", border: "1px solid #e8e6e1", borderRadius: 10, padding: "12px 16px", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 14, height: 14, border: "2px solid #3498db", borderTop: "2px solid transparent", borderRadius: "50%", animation: "spin 0.7s linear infinite", flexShrink: 0 }} />
          <span style={{ fontSize: 11, color: "#888", fontFamily: "monospace" }}>Перевіряю консистентність між ракурсами…</span>
        </div>
      )}
      {step === 2 && sel === null && consistency && !consistency.error && (
        <div style={{ margin: "0 24px 12px", background: "#fff", border: `1px solid ${consistency.score >= 80 ? "#27ae6033" : consistency.score >= 60 ? "#e67e2233" : "#e74c3c33"}`, borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: "8px 14px", background: "#faf9f7", borderBottom: "1px solid #f0eeea", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13 }}>🎬</span>
            <span style={{ fontSize: 10, fontWeight: 700, color: "#555", fontFamily: "monospace", letterSpacing: "0.08em", flex: 1 }}>КОНСИСТЕНТНІСТЬ ПОСТ-ПРОДАКШНУ</span>
            <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "monospace", color: consistency.score >= 80 ? "#27ae60" : consistency.score >= 60 ? "#e67e22" : "#e74c3c" }}>{consistency.score}% — {consistency.verdict}</span>
          </div>
          {consistency.issues?.length > 0 && (
            <div style={{ padding: "8px 14px", display: "flex", flexDirection: "column", gap: 4 }}>
              {consistency.issues.map((issue, i) => (
                <div key={i} style={{ fontSize: 11, color: "#555", display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <span style={{ color: "#e67e22", flexShrink: 0 }}>⚠</span>
                  <span>{issue.description}{issue.renders?.length ? <span style={{ color: "#aaa", fontSize: 10, marginLeft: 6 }}>[ракурси {issue.renders.join(", ")}]</span> : ""}</span>
                </div>
              ))}
            </div>
          )}
          {consistency.summary && <div style={{ padding: "6px 14px 10px", fontSize: 11, color: "#777", borderTop: "1px solid #f0eeea" }}>{consistency.summary}</div>}
        </div>
      )}
      {step === 2 && sel === null && tzClientComments.length > 0 && (
        <div style={{ margin: "0 24px 12px", background: "#fff", border: "1px solid #e8e6e1", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: "8px 14px", background: "#faf9f7", borderBottom: "1px solid #f0eeea", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13 }}>💬</span>
            <span style={{ fontSize: 10, fontWeight: 700, color: "#555", fontFamily: "monospace", letterSpacing: "0.1em" }}>КОМЕНТАРІ КЛІЄНТА</span>
          </div>
          <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
            {Object.entries(tzClientComments.reduce((acc, item) => { (acc[item.page] = acc[item.page] || []).push(item.text); return acc; }, {})).map(([page, texts], gi) => {
              const lines = texts.flatMap(t => t.split(/\n/).map(l => l.replace(/^[•\-–—]\s*/, "").trim()).filter(l => l.length > 0));
              return (
                <div key={gi} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ fontSize: 9, color: "#aaa", fontFamily: "monospace", letterSpacing: "0.08em", borderBottom: "1px solid #f0eeea", paddingBottom: 4 }}>{page}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    {lines.map((line, li) => (
                      <div key={li} style={{ display: "flex", gap: 7, alignItems: "flex-start" }}>
                        <span style={{ color: "#bbb", fontSize: 11, flexShrink: 0, marginTop: 2 }}>—</span>
                        <span style={{ fontSize: 12, fontFamily: "monospace", color: "#333", lineHeight: 1.6 }}>{line}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {step === 2 && sel === null && <Grid items={gridItems} perData={perData} statuses={statuses} globalSummary={globalSum} onSelect={setSel} onRetry={mode === "first" ? retryFailed : undefined} mode={mode} />}
      {step === 2 && sel !== null && detailProps && (
        <DetailPage
          renderFiles={detailProps.renderFiles}
          beforeFiles={detailProps.beforeFiles}
          data={perData[sel]}
          drawings={detailProps.drawings}
          num={sel + 1}
          total={isRev ? vPairs.length : rImages.length}
          status={statuses[sel] || null}
          apiError={perData[sel]?.error || null}
          onBack={() => setSel(null)}
          mode={mode}
          tzCards={tzCards}
          tzAnnotation={tzAnnotation}
          tzClientComments={tzClientComments}
          sverkaChecks={sverkaChecksUi}
          onSverkaOverride={(checkId, status) => handleSverkaOverride(sel, checkId, status)}
          onReview={async (excluded) => {
            const ri = sel;
            const rImages = readyFiles(renders).filter(f => f.pages?.some(p => p.b64));
            const render = rImages[ri]; if (!render) return;
            const newStatuses = [...statuses]; newStatuses[ri] = "Аналізую…"; setStatuses([...newStatuses]);
            const drawsList = readyFiles(draws);
            const briefsList = readyFiles(briefs);
            const mn = matNote([...briefsList, ...drawsList]);
            const excNote = excluded.length > 0
              ? `\n\nІГНОРУЙ ЦІ ПУНКТИ — відмічені як нерелевантні для даного ракурсу:\n${excluded.map((e, i) => `${i+1}. [${e.type}] ${e.text}`).join("\n")}\nНЕ включай їх в items/corrections/defects та не знижуй оцінку через них.`
              : "";
            const tzLower = briefText.toLowerCase();
            const isExterior = /екстер|exterior|фасад|facade|будинок|house|office|building/.test(tzLower);
            const isInterior = !isExterior || /інтер|interior|кімнат|room|kitchen|living/.test(tzLower);
            const drawCount = drawsList.filter(d => d.pages?.some(p => p.b64)).length;
            const hasDwgText = drawsList.filter(d => (d.type==="dxf"||d.type==="dwg") && d.textContent).length > 0;
            const blocks = [`── ТЕХНІЧНІ ДЕФЕКТИ ──\nQ1.1 Левітація, Q1.2 Перетин, Q1.3 Текстури, Q1.4 Аліасинг, Q1.5 Артефакти, Q1.6 Матеріали`];
            if (drawCount > 0 || hasDwgText) blocks.push(`── КРЕСЛЕННЯ ──\n${BLUEPRINT_COMPARE_PROMPT}`);
            if (briefText.trim() || briefsList.length > 0) blocks.push(`── БРИФ/МУДБОРД ──\nВідповідність кольорів, стилю, пори року, освітлення`);
            blocks.push(`── РЕОСЕТТИНГ ──\n${isInterior ? "Розетки, сантехніка, " : "Номери машин, дороги, "}рослинність, штори, написи на техніці, BEK`);
            const parts = [{ type: "text", text: `Ти — QA-спеціаліст 3D-візуалізації. Повторна перевірка ракурсу ${ri+1}.

ТЗ: ${briefText.trim() || "(дивись матеріали)"}
${mn}${excNote}

${ZONE_PROMPT}

${blocks.join("\n\n")}

СТАНДАРТИ: ${QUAL_C}

- Заповни "checks" по кожному Q-пункту: status (ok/warn/fail/skipped), group (technical/tz/materials/geosetting/client), note.

ВІДПОВІДАЙ ТІЛЬКИ JSON:
${JSON_SCHEMA}` }];
            (render.pages || []).filter(p => p.b64).forEach((pg, pi) => {
              parts.push({ type: "text", text: `РЕНДЕР ${ri+1}${pi>0?` стор.${pi+1}`:""}:` });
              parts.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: pg.b64 } });
            });
            parts.push(...filesToParts(briefsList, "БРИФ"));
            parts.push(...filesToParts(readyFiles(refs), "РЕФЕРЕНС"));
            parts.push(...filesToParts(drawsList, "КРЕСЛЕННЯ"));
            try {
              const p = await callAPI(parts, 2, anthropicKey);
              const newData = [...perData];
              newData[ri] = normalizeZones({ tz_parsed: p.tz_parsed||[], checks: p.checks||[], items: p.items||[], corrections: p.corrections||[], defects: p.defects||[], materials: p.materials||[], sverka: p.sverka||[], quality: p.quality||null, summary: p.summary||"" });
              setPerData(newData);
            } catch(e) {
              const newData = [...perData]; newData[ri] = { ...perData[ri], error: e.message }; setPerData(newData);
            }
            const ns = [...statuses]; ns[ri] = null; setStatuses(ns);
          }}
        />
      )}

      <style>{`
        @keyframes spin{to{transform:rotate(360deg)}}
        .qa-bg { background: var(--void); }
      `}</style>
    </div>
  );
}
