# Render QA — перевірка рендерів на відповідність ТЗ

Інструмент QA для 3D-візуалізації. Завантажуєш пакет від клієнта (бриф, креслення, специфікації, референси) + готові рендери — Claude перевіряє **чи рендер відповідає технічному завданню** і видає по-пунктний вердикт.

> Внутрішній інструмент Archivizer. Мета (з [ROADMAP](ROADMAP.md)): *«ТЗ готове до виробництва, якщо після його прочитання можна почати моделінг без дзвінка клієнту»* — а Render QA замикає цикл, звіряючи фінальний результат із цим ТЗ.

---

## Що вміє

1. **Завантаження пакета** по зонах:
   - 📋 **БРИФ** — текстове ТЗ (PDF / DOCX / RTF / XLSX)
   - 📐 **КРЕСЛЕННЯ** — floor plans, фасади (PDF / JPG / **DWG/DXF** — парсяться entities: LINE, CIRCLE, MTEXT, HATCH, DIMENSION, INSERT…)
   - 🧊 **Моделі** — 3D / референси
   - 🖼 **ДО** — референс-зображення, мудборди
2. **AI-перевірка** — Claude Sonnet звіряє рендер з вимогами ТЗ, по кожному пункту: **✅ Відповідає ТЗ / ❌ Не відповідає / ⬜ Не виконано**
3. **TZ Review** — окрема вкладка: структурований огляд ТЗ з **експортом у PDF**
4. **Tagging референсів** — прив'язка «ця текстура → на цю поверхню», щоб Claude корелював текст із візуалом
5. **Cross-Check** — студійний чеклист з 13 пунктів (FFE, RCP, елевейшени, розгортки, ландшафтний план…): пункти активуються типом завантажених документів (авто-тег по імені файлу + селект), Claude ставить вердикти, ПМ може перекрити кліком (бейдж «ПМ»), усе йде в PDF-звіт

---

## Архітектура

```
React UI (src/App.jsx, ~3100 рядків)
   ├─ парсинг файлів у браузері:
   │    PDF → pdf.js (рендер сторінок у JPEG)
   │    XLSX → SheetJS · DOCX/RTF → текст · DWG/DXF → entities
   ├─ fetch напряму → https://api.anthropic.com  (Claude Sonnet, ключ вводить юзер)
   └─ Archivizer API (обхід CORS): dev — Vite proxy (vite.config.js), desktop — Express в electron/main.js
        ▲
   Electron-обгортка (desktop .exe) — electron/ + start.bat
```

- Claude викликається **прямо з браузера** (`anthropic-dangerous-direct-browser-access`), з prompt-caching
- API-ключ Anthropic вводиться в UI (не зашитий у код)

---

## Стек

| | |
|---|---|
| Frontend | React + Vite |
| Desktop | Electron (`electron/`, `npm run dist`) |
| AI | Claude Sonnet (`claude-sonnet-4-20250514`), prompt-caching |
| PDF | pdf.js (CDN, lazy) |
| Excel | SheetJS (CDN, lazy) |
| DWG/DXF | парсер entities у `App.jsx` |
| Proxy (Archivizer API) | Vite dev-proxy (web) · Express + http-proxy-middleware в `electron/main.js` (desktop) |

---

## Запуск

```bash
npm install
npm run dev        # Vite dev-сервер (UI + проксі до Archivizer API)
# або десктоп:
npm run electron   # Electron у dev
npm run dist       # зібрати .exe → release/
```

Anthropic API-ключ вводиться у самому інтерфейсі (поле «Anthropic API key»).

---

## Структура

```
render-qa/
├── src/App.jsx        # ★ вся логіка: парсинг файлів, зони, виклик Claude, вердикти
├── electron/          # десктопна обгортка (main.js містить Express-проксі до Archivizer)
├── start.bat          # швидкий запуск на Windows
├── ROADMAP.md         # 8-етапний pipeline обробки ТЗ
├── presentation.html · roadmap-presentation.html
└── release/           # зібрані десктоп-білди
```

> Детальний задум pipeline обробки ТЗ — у [ROADMAP.md](ROADMAP.md).
