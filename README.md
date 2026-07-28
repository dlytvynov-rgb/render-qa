# Render QA — перевірка рендерів на відповідність ТЗ

Інструмент QA для 3D-візуалізації. Завантажуєш пакет від клієнта (бриф, креслення, специфікації, референси) + готові рендери — Claude перевіряє **чи рендер відповідає технічному завданню** і видає по-пунктний вердикт.

> **🌐 Live:** https://dlytvynov-rgb.github.io/render-qa/ — працює прямо в браузері, нічого качати не треба. Введи свій Anthropic API-ключ у ⚙ (зберігається лише локально) і працюй.

> **🤝 Передаєш комусь код / іншій AI?** Читай [HANDOFF.md](HANDOFF.md) — повний брифінг архітектури й логіки всіх перевірок.

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
React UI (src/App.jsx) — повністю клієнтський, без бекенда
   ├─ парсинг файлів у браузері:
   │    PDF → pdf.js (рендер сторінок у JPEG)
   │    XLSX → SheetJS · DOCX/RTF → текст · DWG/DXF → entities
   ├─ fetch напряму → https://api.anthropic.com  (Claude Sonnet, ключ вводить юзер)
   └─ збірка singlefile → один index.html (vite-plugin-singlefile)
        ▲
   Electron-обгортка (desktop .exe, опціонально) — electron/ + start.bat
```

- **Без сервера.** Уся логіка в браузері → деплоїться як статика (GitHub Pages, будь-який CDN)
- Claude викликається **прямо з браузера** (`anthropic-dangerous-direct-browser-access`), з prompt-caching
- API-ключ Anthropic вводиться в UI (не зашитий у код, лежить лише в localStorage юзера)
- Пуш у `main` → GitHub Actions ([deploy-pages.yml](.github/workflows/deploy-pages.yml)) білдить і публікує на Pages автоматично

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
| Хостинг | GitHub Pages (статика, `deploy-pages.yml`) · опц. Electron .exe |

---

## Запуск

```bash
npm install
npm run dev        # Vite dev-сервер (UI)
npm run test       # vitest (логіка Cross-Check)
npm run build      # статична збірка → dist/index.html
npm run preview    # локальний перегляд збірки
# опційно десктоп:
npm run electron   # Electron у dev
npm run dist       # зібрати .exe → release/
```

Anthropic API-ключ вводиться у самому інтерфейсі (⚙ у хедері). Деплой на Pages — автоматичний при пуші в `main`.

---

## Структура

```
render-qa/
├── src/App.jsx        # ★ вся логіка: парсинг файлів, зони, виклик Claude, вердикти
├── electron/          # десктопна обгортка (опціональна .exe/.dmg)
├── .github/workflows/ # deploy-pages.yml (Pages) · build.yml (Electron, ручний)
├── start.bat          # швидкий запуск на Windows
├── ROADMAP.md         # 8-етапний pipeline обробки ТЗ
├── presentation.html · roadmap-presentation.html
└── release/           # зібрані десктоп-білди
```

> Детальний задум pipeline обробки ТЗ — у [ROADMAP.md](ROADMAP.md).
