#!/usr/bin/env node
/**
 * selftest.js — browser-free smoke test for the pure modules.
 *
 * Loads the shared modules into the current Node global (they are plain
 * IIFEs that only touch globalThis), then asserts the behaviours that
 * everything else depends on:
 *
 *   • Persian/Arabic digit + text normalisation
 *   • money parsing (grouping, decimals, Rial→Toman, multipliers)
 *   • budget phrase parsing («تا …», «بین … تا …»)
 *   • the offline rule-based intent parser
 *   • the deterministic local scorer
 *   • robust JSON extraction/repair from messy model output
 *   • intent + ranking schema validation
 *   • guardrails risk classification
 *   • Persian error mapping
 *   • store adapters are structurally complete
 *
 * Usage:  node scripts/selftest.js
 * Exit code 0 = all green.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/* ------------------------------------------------------------------ *
 * Tiny harness
 * ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${extra !== undefined ? `  → got ${JSON.stringify(extra)}` : ''}`);
  }
}

function eq(name, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  ok(name, same, same ? undefined : actual);
  if (!same) console.log(`      expected ${JSON.stringify(expected)}`);
}

function section(title) {
  console.log(`\n\x1b[36m▸ ${title}\x1b[0m`);
}

/* ------------------------------------------------------------------ *
 * Load the modules into this global
 * ------------------------------------------------------------------ */

const MODULES = [
  'shared/utils.js',
  'shared/locales.js',
  'shared/i18n.js',
  'shared/storage.js',
  'shared/sites.js',
  'shared/json.js',
  'shared/schema.js',
  'shared/guardrails.js',
  'shared/errors.js',
  'background/providers/sse.js',
  'shared/llm.js',
  'content/adapters/generic.js',
  'content/adapters/digikala.js',
  'content/adapters/basalam.js',
  'content/adapters/index.js',
];

for (const rel of MODULES) {
  const file = path.join(ROOT, rel);
  const code = fs.readFileSync(file, 'utf8');
  // indirect eval → runs in global scope, attaches to globalThis.ShopAgent
  (0, eval)(code);
}

const SA = globalThis.ShopAgent;
const { utils, llm, json, schema, guardrails, errors, sse, adapters, sites } = SA;
if (!utils || !llm || !json || !schema || !guardrails || !errors) {
  console.error('FATAL: ShopAgent namespace did not load');
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * 1. Digits & normalisation
 * ------------------------------------------------------------------ */

section('digits & text normalisation');
eq('Persian digits → ASCII', utils.toEnglishDigits('۰۱۲۳۴۵۶۷۸۹'), '0123456789');
eq('Arabic-Indic digits → ASCII', utils.toEnglishDigits('٠١٢٣٤٥٦٧٨٩'), '0123456789');
eq('ASCII → Persian digits', utils.toPersianDigits('12345'), '۱۲۳۴۵');
eq('mixed digits', utils.toEnglishDigits('قیمت ۲,۵۰۰'), 'قیمت 2,500');
eq('ZWNJ removed + letters unified', utils.normalizeText('دیجی‌کالا يك كتاب'), 'دیجیکالا یک کتاب');
eq('harakat removed', utils.normalizeText('كِتابٌ'), 'کتاب');

/* ------------------------------------------------------------------ *
 * 2. Money parsing
 * ------------------------------------------------------------------ */

section('money parsing');
eq('grouped Persian + toman', utils.parsePrice('۱,۲۳۴,۵۶۷ تومان'), 1234567);
eq('dotted grouping + rial → toman', utils.parsePrice('1.234.567 ریال'), 123457);
eq('plain digits', utils.parsePrice('450000'), 450000);
eq('millions word', utils.parsePrice('۳ میلیون تومان'), 3000000);
eq('thousands word', utils.parsePrice('۵۰۰ هزار تومان'), 500000);
eq('billions rial → toman', utils.parsePrice('۲ میلیارد ریال'), 200000000);
eq('decimal millions', utils.parsePrice('2.5 میلیون'), 2500000);
eq('prefer max', utils.parsePrice('از ۴۰۰,۰۰۰ تا ۹۰۰,۰۰۰', { prefer: 'max' }), 900000);
eq('prefer min', utils.parsePrice('از ۴۰۰,۰۰۰ تا ۹۰۰,۰۰۰', { prefer: 'min' }), 400000);
eq('no price → null', utils.parsePrice('هیچ عددی اینجا نیست'), null);

const all = utils.extractMoney('قیمت: ۳,۲۰۰,۰۰۰ تومان (قبلاً ۴,۰۰۰,۰۰۰ تومان)');
eq('extractMoney finds two values', all.length, 2);
eq('first is current price', all[0].value, 3200000);
eq('second is old price', all[1].value, 4000000);

section('stray-number regressions (issue: 300,000 shown as 60)');
eq('review count (۶۰) is not a price', utils.parsePrice('(۶۰)'), null);
eq('discount percent ۶۰٪ is not a price', utils.parsePrice('۶۰٪'), null);
eq('rating 4.5 is not a price', utils.parsePrice('4.5'), null);
eq('real price still parses', utils.parsePrice('۳۰۰,۰۰۰'), 300000);
eq('anchored=true next to currency', utils.extractMoney('۳۰,۰۰۰ تومان')[0].anchored, true);
eq('anchored=false for bare count', utils.extractMoney('(۱۲۳)')[0].anchored, false);
eq('anchoredOnly rejects bare counts', utils.parsePrice('(۱۲۴)', { anchoredOnly: true }), null);
eq('anchoredOnly accepts currency', utils.parsePrice('۱۲۳۴ تومان', { anchoredOnly: true }), 1234);
eq('rial still converts', utils.parsePrice('۳,۰۰۰,۰۰۰ ریال'), 300000);
eq('pure price text likeness = 1', utils.priceLikeness('۲,۸۹۰,۰۰ تومان'), 1);
eq('parenthesised count likeness = 1', utils.priceLikeness('(۱۲۳۴)'), 1);
ok('title with digits is not price-like', utils.priceLikeness('گوشی مدل 2024 ظرفیت 256') < 0.55, utils.priceLikeness('گوشی مدل 2024 ظرفیت 256'));
ok('label + price still price-like', utils.priceLikeness('قیمت: ۲,۸۹۰,۰۰') >= 0.55, utils.priceLikeness('قیمت: ۲,۸۹۰,۰۰۰'));

/* ------------------------------------------------------------------ *
 * 3. Budget phrases
 * ------------------------------------------------------------------ */

section('budget phrases');
eq('«تا ۳ میلیون تومان»', utils.parseBudget('تا ۳ میلیون تومان'), { min: null, max: 3000000 });
eq('«زیر ۸ میلیون»', utils.parseBudget('زیر ۸ میلیون'), { min: null, max: 8000000 });
eq('«بین ۵۰۰ هزار تا ۲ میلیون»', utils.parseBudget('بین ۵۰۰ هزار تا ۲ میلیون'), { min: 500000, max: 2000000 });
eq('«بالای ۱ میلیون»', utils.parseBudget('بالای ۱ میلیون'), { min: 1000000, max: null });
eq('no budget', utils.parseBudget('فقط یه ایرپاد خوب'), { min: null, max: null });

/* ------------------------------------------------------------------ *
 * 4. Formatting
 * ------------------------------------------------------------------ */

section('formatting');
eq('formatMoney fa', utils.formatMoney(3000000), '۳,۰۰۰,۰۰۰ تومان');
eq('formatMoney en digits', utils.formatMoney(3000000, { digits: 'en' }), '3,000,000 تومان');
eq('formatMoneyShort', utils.formatMoneyShort(3000000), '۳ میلیون');
eq('formatMoneyShort thousands', utils.formatMoneyShort(450000), '۴۵۰ هزار');

/* ------------------------------------------------------------------ *
 * 5. Rule-based intent parser (fully offline)
 * ------------------------------------------------------------------ */

section('rule-based intent (offline)');
{
  const i = llm.builtinParseIntent('بهترین ایرپاد بی‌سیم تا ۳ میلیون تومان رو پیدا کن');
  eq('store not forced', i.targetStore, null);
  eq('max price', i.maxPrice, 3000000);
  eq('sort = bestselling for «بهترین»', i.sort, 'bestselling');
  ok('query contains ایرپاد', (i.query || '').includes('ایرپاد'), i.query);
  ok('attribute بی‌سیم detected', i.attributes.includes('بی‌سیم'), i.attributes);
  ok('confidence in range', i.confidence > 0.4 && i.confidence <= 1, i.confidence);
}
{
  const i = llm.builtinParseIntent('ارزون‌ترین گوشی شیائومی تو دیجی کالا زیر ۸ میلیون');
  eq('sort cheapest', i.sort, 'cheapest');
  eq('brand', i.brand, 'شیائومی');
  eq('store digikala', i.targetStore, 'digikala');
  eq('max price', i.maxPrice, 8000000);
  ok('query mentions گوشی', i.query.includes('گوشی'), i.query);
}
{
  const i = llm.builtinParseIntent('کفش رانینگ مردانه بین ۵۰۰ هزار تا ۲ میلیون باسلام');
  eq('store basalam', i.targetStore, 'basalam');
  eq('min price', i.minPrice, 500000);
  eq('max price', i.maxPrice, 2000000);
  ok('attributes gender+sport', i.attributes.includes('مردانه') && i.attributes.includes('ورزشی'), i.attributes);
  eq('category', i.category, 'کفش');
}
{
  const i = llm.builtinParseIntent('سلام خوبی؟');
  eq('greeting → unknown intent', i.intent, 'unknown');
}

/* ------------------------------------------------------------------ *
 * 6. Deterministic local scoring
 * ------------------------------------------------------------------ */

section('local scorer');
{
  const intent = { query: 'ایرپاد بی‌سیم', maxPrice: 3000000, minPrice: null, sort: 'bestselling', brand: null, attributes: ['بی‌سیم'] };
  const good = { title: 'ایرپاد بی‌سیم انکر مدل Soundcore', price: 2400000, rating: 4.5, ratingCount: 320, discount: 20 };
  const over = { title: 'ایرپاد بی‌سیم سونی premium', price: 7500000, rating: 4.8, ratingCount: 90, discount: 0 };
  const a = llm.localScore(good, intent, 'fa');
  const b = llm.localScore(over, intent, 'fa');
  ok('in-budget scores higher than over-budget', a.score > b.score, { a: a.score, b: b.score });
  ok('good product has reasons', a.reasons.length > 0, a.reasons);
  ok('over-budget flagged', b.reasons.some((r) => r.includes('بودجه')), b.reasons);
}

/* ------------------------------------------------------------------ *
 * 7. Robust JSON extraction & repair (shared/json.js)
 * ------------------------------------------------------------------ */

section('json extraction (basic)');
eq('plain json', json.safeJsonParse('{"a":1}'), { a: 1 });
eq('fenced json', json.safeJsonParse('here you go:\n```json\n{"a": 2}\n```\nthanks'), { a: 2 });
eq('json inside prose', json.safeJsonParse('sure! {"intent":"search","query":"x"} hope it helps'), { intent: 'search', query: 'x' });
eq('array', json.safeJsonParse('[1,2,3]'), [1, 2, 3]);
eq('garbage → null', json.safeJsonParse('no json here at all'), null);
eq('escaped quotes', json.safeJsonParse('{"why":"he said \\"hi\\" , ok"}'), { why: 'he said "hi" , ok' });

section('json repair (broken model output)');
eq('trailing commas', json.safeJsonParse('{"a":1,"b":[1,2,],}'), { a: 1, b: [1, 2] });
eq('single-quoted strings', json.safeJsonParse("{'intent':'search','query':'گوشی'}"), { intent: 'search', query: 'گوشی' });
eq('unquoted keys', json.safeJsonParse('{intent: "search", maxResults: 6}'), { intent: 'search', maxResults: 6 });
eq('python literals', json.safeJsonParse('{"a": True, "b": None, "c": False}'), { a: true, b: null, c: false });
eq('line comments', json.safeJsonParse('{\n  // the intent\n  "intent": "search" // inline too\n}'), { intent: 'search' });
eq('smart quotes', json.safeJsonParse('{“intent”:“search”}'), { intent: 'search' });
eq('fenced + trailing comma + prose', json.safeJsonParse('خوبه:\n```json\n{"picks":[{"id":"p1","score":88,},]}\n```'), { picks: [{ id: 'p1', score: 88 }] });
eq('prose + broken json', json.safeJsonParse('جواب: {"intent": "search", "query": "ایرپاد",} موفق بودی'), { intent: 'search', query: 'ایرپاد' });

/* ------------------------------------------------------------------ *
 * 8. Intent schema validation (LLM output is untrusted)
 * ------------------------------------------------------------------ */

section('intent schema validation');
{
  const v = schema.validateIntent(
    { intent: 'hack', query: 'x'.repeat(500), maxPrice: -5, minPrice: 'abc', sort: 'nope', attributes: 'بی‌سیم, ضد آب', confidence: 99 },
    { originalText: 'ایرپاد', stopWords: llm.STOP_WORDS }
  );
  eq('bad intent → search', v.value.intent, 'search');
  eq('query truncated', v.value.query.length, 160);
  eq('negative price → null', v.value.maxPrice, null);
  eq('garbage min → null', v.value.minPrice, null);
  eq('bad sort → best_match', v.value.sort, 'best_match');
  eq('comma string → array', v.value.attributes, ['بی‌سیم', 'ضد آب']);
  eq('confidence clamped', v.value.confidence, 1);
  ok('errors reported, not silent', v.errors.length > 0, v.errors);
}
{
  const v = schema.validateIntent({ query: '', intent: 'search' }, { originalText: 'یه گوشی سامسونگ خوب', stopWords: llm.STOP_WORDS });
  ok('empty query recovered from text', v.value.query.length > 0, v.value.query);
}
{
  // Hallucinated action channels must be stripped + reported.
  const v = schema.validateIntent({ query: 'گوشی', action: 'checkout', command: 'pay' }, { originalText: 'گوشی', stopWords: llm.STOP_WORDS });
  ok('action field flagged', v.errors.some((e) => e.includes('اکشن')), v.errors);
  ok('no action in value', !('action' in v.value), Object.keys(v.value));
}
{
  const v = schema.validateIntent('not an object', { originalText: '', stopWords: [] });
  ok('non-object rejected with error', !v.ok && v.errors.length > 0, v.errors);
}

section('ranking schema validation');
{
  const pool = [{ id: 'p1', title: 'A', price: 1000 }, { id: 'p2', title: 'B', price: 2000 }];
  const v = schema.validateRanking({ picks: [{ id: 'p1', rank: 2, score: 88, why: 'خوب' }, { id: 'HALLUCINATED', rank: 1 }, { id: 'p2', rank: 1, score: 200 }] }, pool);
  eq('unknown ids dropped', v.value.length, 2);
  eq('sorted by rank', v.value.map((p) => p.id), ['p2', 'p1']);
  eq('score clamped', v.value[0].score, 100);
  ok('hallucination reported', v.errors.some((e) => e.includes('HALLUCINATED')), v.errors);
}
{
  const v = schema.validateRanking({ nope: 1 }, [{ id: 'p1' }]);
  ok('missing picks → not ok', !v.ok && v.value.length === 0, v);
}

/* ------------------------------------------------------------------ *
 * 9. Guardrails
 * ------------------------------------------------------------------ */

section('guardrails risk classification');
eq('checkout button blocked', guardrails.assessTarget({ text: 'تایید و پرداخت' }).risk, 'blocked');
eq('checkout url blocked', guardrails.assessTarget({ text: 'ادامه', href: 'https://x.com/checkout/step2' }).risk, 'blocked');
eq('login blocked', guardrails.assessTarget({ text: 'ورود به حساب' }).risk, 'blocked');
eq('address blocked', guardrails.assessTarget({ text: 'ثبت آدرس جدید' }).risk, 'blocked');
eq('add to cart → confirm', guardrails.assessTarget({ text: 'افزودن به سبد خرید' }).risk, 'confirm');
eq('buy now → confirm', guardrails.assessTarget({ ariaLabel: 'Buy now' }).risk, 'confirm');
eq('delete → confirm', guardrails.assessTarget({ text: 'حذف از لیست' }).risk, 'confirm');
eq('search → safe', guardrails.assessTarget({ text: 'جستجو' }).risk, 'safe');
eq('nav link → safe', guardrails.assessTarget({ text: 'گوشی سامسونگ', href: '/category/mobile/' }).risk, 'safe');
eq('assessUrl checkout', guardrails.assessUrl('https://www.digikala.com/checkout/cart/').risk, 'blocked');
eq('assessUrl product page', guardrails.assessUrl('https://www.digikala.com/product/dkp-123/x/').risk, 'safe');
eq('isProductUrl', guardrails.isProductUrl('https://basalam.com/p/abc') === true && guardrails.isProductUrl('https://basalam.com/search?q=x') === false, true);

/* ------------------------------------------------------------------ *
 * 10. Persian error mapping
 * ------------------------------------------------------------------ */

section('error classification & messages');
eq('ollama down classified', errors.classify(new Error('TypeError: Failed to fetch'), { provider: 'ollama' }), errors.KINDS.OLLAMA_DOWN);
eq('timeout classified', errors.classify(new Error('TIMEOUT')), errors.KINDS.TIMEOUT);
eq('auth classified', errors.classify(new Error('Invalid API Key'), { status: 401 }), errors.KINDS.AUTH);
eq('rate limit classified', errors.classify(new Error('Rate limit reached'), { status: 429 }), errors.KINDS.RATE_LIMIT);
{
  const f = errors.friendly(new Error('TypeError: Failed to fetch'), { lang: 'fa', provider: 'ollama' });
  ok('fa message mentions ollama serve', f.message.includes('ollama serve'), f.message);
  eq('kind exposed for UI', f.kind, errors.KINDS.OLLAMA_DOWN);
}

/* ------------------------------------------------------------------ *
 * 11. SSE / NDJSON line parsing
 * ------------------------------------------------------------------ */

section('sse line parsing');
{
  const splitter = sse.makeLineSplitter();
  const lines = [...splitter.push('{"message":{"content":"سلام"}}\n{"message"'), ...splitter.push(':{\"content\":\" دنیا\"}}\n\n'), ...splitter.flush()];
  eq('ndjson across chunk boundary', lines.length, 2);
  eq('first line parses', JSON.parse(lines[0]).message.content, 'سلام');
  eq('second line parses', JSON.parse(lines[1]).message.content, ' دنیا');
}
{
  const lines = ['data: {"choices":[{"delta":{"content":"hi"}}]}', 'data: [DONE]', ':keepalive', 'event: ping'];
  const parsed = lines.map(sse.parseSseLine);
  eq('sse payload parsed', parsed[0].choices[0].delta.content, 'hi');
  eq('done sentinel → null', parsed[1], null);
  eq('non-data lines → null', parsed[2] === null && parsed[3] === null, true);
}

/* ------------------------------------------------------------------ *
 * 12. Store detection & adapters
 * ------------------------------------------------------------------ */

section('store detection & page classification');
eq('digikala www', sites.detect('https://www.digikala.com/search/?q=x').id, 'digikala');
eq('digikala bare', sites.detect('https://digikala.com/product/dkp-1/').id, 'digikala');
eq('basalam', sites.detect('https://basalam.com/search?q=x').id, 'basalam');
eq('other → generic', sites.detect('https://example.com/shop').id, 'generic');
{
  const c = sites.classifyUrl;
  eq('digikala home = home, not results', c('https://www.digikala.com/'), { home: true, results: false, path: '/', query: '' });
  eq('digikala search path → results', c('https://www.digikala.com/search/?q=airpods').results, true);
  eq('basalam search query → results', c('https://basalam.com/search?q=%DA%A9%D9%81%D8%B4').results, true);
  eq('product page ≠ results', c('https://www.digikala.com/product/dkp-123456/x/').results, false);
  eq('product page with ?q= ≠ results', c('https://www.digikala.com/product/dkp-9/?q=a').results, false);
  eq('category page ≠ results-by-url', c('https://www.digikala.com/category/mobile/').results, false);
  eq('garbage url is safe', c('not a url'), { home: false, results: false, path: '', query: '' });
}

section('adapters are structurally complete');
{
  const REQUIRED = ['searchInput', 'searchSubmit', 'productCard', 'productTitle', 'productLink', 'productPrice', 'sortControl'];
  for (const id of ['digikala', 'basalam', 'generic']) {
    const dom = adapters.domFor(id);
    ok(`${id}: selectors present`, Boolean(dom?.selectors), dom);
    const missing = REQUIRED.filter((k) => !Array.isArray(dom?.selectors?.[k]) || !dom.selectors[k].length);
    eq(`${id}: required selector groups`, missing, []);
    ok(`${id}: cartButtonTexts present`, Array.isArray(dom?.cartButtonTexts) && dom.cartButtonTexts.length > 0);
    ok(`${id}: sort labels present`, Object.keys(dom?.labels?.sort || {}).length >= 5);
  }
  // Selector fallback chains must start with data-testid/semantic selectors.
  const d = adapters.domFor('digikala');
  ok('digikala prefers data-testid for cards', /data-testid/.test(d.selectors.productCard[0]), d.selectors.productCard[0]);
}

/* ------------------------------------------------------------------ *
 * 13. i18n
 * ------------------------------------------------------------------ */

section('i18n');
{
  const i18n = SA.i18n;
  i18n.setLang('fa');
  eq('fa key', i18n.t('status.typing'), 'در حال تایپ');
  i18n.setLang('en');
  eq('en key', i18n.t('status.typing'), 'Typing');
  eq('missing key falls back to itself', i18n.t('no.such.key'), 'no.such.key');
  eq('placeholder substitution', i18n.t('results.count', { n: 5 }), '5 products found');
  i18n.setLang('fa');
  eq('new banner key (fa)', i18n.t('banner.ok.builtin'), 'تحلیل‌گر داخلی فعال است (بدون مدل)');
}

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
if (failed) {
  console.log('\x1b[31mfailed:\x1b[0m\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('\x1b[32mAll shared-module self tests passed.\x1b[0m');
