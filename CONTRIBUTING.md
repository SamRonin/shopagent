# مشارکت در خرید‌یار هوشمند · Contributing to ShopAgent

ممنون که اینجا هستی! 🙏 این سند کوتاه، مسیر مشارکت را روشن می‌کند.
*Thanks for being here! 🙏 This short doc explains how to contribute.*

---

## 🇮🇷 فارسی

### پیش از شروع

- اکستنشن **هیچ وابستگی npm ندارد و build step هم ندارد**. `package.json` موجود فقط اسکریپت‌های تستِ Node را صدا می‌زند (صفر dependency). افزودن هر dependency واقعی یعنی تغییر فلسفهٔ پروژه — اول در Issue گفتگو کنید.
- تست سریع و بدون مرورگر:

  ```bash
  npm run check            # validate + همهٔ تست‌ها
  # یا به‌صورت مستقیم:
  node scripts/selftest.js
  node --test "tests/*.test.js"
  node scripts/validate.js
  ```

  `selftest` ماژول‌های `shared/*` را در Node بارگذاری می‌کند و پارسر پول/بودجه/intent، تعمیر JSON، ولیدیتور schema و گاردریل را assertion می‌زند. `tests/` همان‌ها را با Node Test Runner پوشش می‌دهد و `validate` سازگاری بین‌فایلی (manifest/i18n/پیام‌ها) را چک می‌کند.

- بررسی سینتکس فایل‌هایی که لمس کردی (یا فقط `npm run check` را بزن که همه را کامپایل می‌کند):

  ```bash
  node --check background.js
  node --check content/content.js
  node --check sidepanel/sidepanel.js
  node --check shared/utils.js   # و بقیهٔ shared
  ```

### سبک کد

1. **Vanilla JS، کلاسیک و ماژولار.** هر فایل `shared/*` یک IIFE است که نام‌فضای خودش را روی `globalThis.ShopAgent` ثبت می‌کند. همین الگو را حفظ کن؛ content scriptها ماژول ES نیستند.
2. **هرگز به یک سلکتور اعتماد نکن.** اگر آداپتر فروشگاه اضافه/تغییر می‌دهی، حداقل ۳ سلکتور جایگزین + یک برچسب متنی فارسی + راه هیوریستیک بده. به `content/adapters/` نگاه کن.
3. **پول همیشه تومانِ صحیح است.** همهٔ تبدیل‌ها در `shared/utils.js` انجام می‌شود؛ در لایه‌های دیگر عدد خام ریال نگردان.
4. **رشته‌های خوانده‌شده از صفحه با `textContent`.** در پنل هرگز `innerHTML` با دادهٔ صفحه نساز (XSS). آیکون‌ها از اسپرایت SVG می‌آیند.
5. **بدون API پولی.** هر endpoint جدید باید یا لوکال باشد یا لایهٔ رایگان، وگرنه پشت یک سوئیچ تنظیمات با پیش‌فرض خاموش برود.
6. **i18n دو طرفه.** هر رشتهٔ UI جدید را هم در `shared/locales.js` (fa و en) و هم در صورت نیاز در `_locales/*/messages.json` اضافه کن. کلیدها `dot.case` هستند.
7. **کامنت‌ها انگلیسی، پیام‌های کاربر فارسی/انگلیسی از طریق i18n.** کامنت‌های توضیح‌دهندهٔ «چرا» را انگلیسی بنویس تا همهٔ مشارکت‌کنندگان بخوانند.

### جریان کار

```bash
git clone https://github.com/SamRonin/shopagent.git
cd shopagent
git checkout -b feat/نام-تغییر
# ... تغییر، تست، لود در chrome://extensions ...
git commit -m "feat(sites): add adapter for example-store"
git push -u origin feat/نام-تغییر
# سپس Pull Request
```

عنوان کامیت‌ها Conventional Commits:
`feat | fix | docs | refactor | test | chore | perf` + scope اختیاری مثل `(content)`, `(llm)`, `(ui)`, `(sites)`.

### چه چیزی را کجا بگذارم؟

| تغییر | فایل |
|---|---|
| فروشگاه جدید | `content/adapters/<store>.js` (سلکتورها) + `shared/sites.js` (متادیتای URL) |
| قواعد جدید فارسی (صفت/رنگ/برند) | `shared/llm.js` → `ATTRIBUTE_RULES` / `BRANDS` / `CATEGORY_HINTS` |
| رفتار تایپ/اسکرول/استخراج | `content/actions/*` |
| رفتار کلی اجرا | `background/pipeline.js` |
| پرووایدر مدل جدید | `background/providers/<name>.js` + ثبت در `background/providers/index.js` |
| استایل پنل | `sidepanel/sidepanel.css` |
| استایل HUD روی صفحه | `content/content.css` |
| رشتهٔ UI | `shared/locales.js` (+ `_locales` برای manifest) |
| تنظیمات جدید | `shared/storage.js` → `DEFAULT_SETTINGS` + فرم در `sidepanel.html` |
| آیکون‌ها/بنر | `scripts/build-assets.py` را اجرا کن، PNG را دستی ویرایش نکن |

### گزارش باگ

در Issue بنویس: نسخهٔ کروم، فروشگاه و URL، دستور فارسی، هستهٔ انتخابی (Ollama/Groq/Gemini/Built-in)، و خروجی «لاگ‌های دیباگ». اسکرین‌شات از HUD خیلی کمک می‌کند.

---

## 🇬🇧 English

### Before you start

- The extension has **no npm dependencies and no build step**. The bundled `package.json` only wires zero-dependency Node test scripts — adding any real dependency changes the project philosophy, discuss it in an Issue first.
- Fast, browser-free tests:

  ```bash
  npm run check            # validate + all tests
  # or directly:
  node scripts/selftest.js
  node --test "tests/*.test.js"
  node scripts/validate.js
  ```

  `selftest` loads the `shared/*` modules in Node and asserts the money/budget/intent parsers, JSON repair, schema validators and guardrails. `tests/` covers the same with the Node Test Runner; `validate` checks cross-file contracts (manifest/i18n/messages).

- Syntax-check whatever you touched (or just run `npm run check`, which compiles every JS file):

  ```bash
  node --check background.js
  node --check content/content.js
  node --check sidepanel/sidepanel.js
  node --check shared/utils.js   # and the rest of shared/
  ```

### Code style

1. **Vanilla, classic, modular JS.** Each `shared/*` file is an IIFE that registers its own namespace on `globalThis.ShopAgent`. Keep that pattern; content scripts are not ES modules.
2. **Never trust a single selector.** When adding or changing a store adapter, provide at least 3 fallback selectors + a Persian text label + a heuristic path. See `content/adapters/`.
3. **Money is always integer Toman.** All conversion happens in `shared/utils.js`; do not re-derive Rial values in other layers.
4. **Scraped strings go through `textContent`.** Never build panel HTML with `innerHTML` from page data (XSS). Icons come from the SVG sprite.
5. **No paid APIs.** Any new endpoint must be local or free-tier; otherwise hide it behind a settings switch that defaults to off.
6. **i18n both ways.** Every new UI string goes into `shared/locales.js` (fa and en) and, when needed, `_locales/*/messages.json`. Keys are `dot.case`.
7. **Comments in English, user-facing strings via i18n.** Write "why" comments in English so every contributor can read them.

### Workflow

```bash
git clone https://github.com/SamRonin/shopagent.git
cd shopagent
git checkout -b feat/your-change
# ... change, test, load in chrome://extensions ...
git commit -m "feat(sites): add adapter for example-store"
git push -u origin feat/your-change
# then open a Pull Request
```

Commit titles follow Conventional Commits:
`feat | fix | docs | refactor | test | chore | perf` + optional scope such as `(content)`, `(llm)`, `(ui)`, `(sites)`.

### Where does my change live?

| Change | File |
|---|---|
| New store | `content/adapters/<store>.js` (selectors) + `shared/sites.js` (URL metadata) |
| New Persian rules (attribute/colour/brand) | `shared/llm.js` → `ATTRIBUTE_RULES` / `BRANDS` / `CATEGORY_HINTS` |
| Typing / scrolling / extraction behaviour | `content/actions/*` |
| Overall run behaviour | `background/pipeline.js` |
| New model provider | `background/providers/<name>.js` + register in `background/providers/index.js` |
| Panel styling | `sidepanel/sidepanel.css` |
| On-page HUD styling | `content/content.css` |
| UI string | `shared/locales.js` (+ `_locales` for manifest strings) |
| New setting | `shared/storage.js` → `DEFAULT_SETTINGS` + form in `sidepanel.html` |
| Icons / banner | run `scripts/build-assets.py`; never hand-edit the PNGs |

### Reporting a bug

Include: Chrome version, store + URL, the Persian command, the selected engine (Ollama/Groq/Gemini/Built-in), and the “Debug logs” output. A screenshot of the HUD helps a lot.

---

## ❤️ رفتار جامعه · Code of conduct

با احترام، مثل یک فروشگاه خوب: بدون تبلیغ مخرب، بدون دادهٔ شخصی دیگران، بدون شکستن حریم خصوصی کاربران.
*With respect, like a good shop: no malicious ads, no other people's personal data, no breaking user privacy.*
