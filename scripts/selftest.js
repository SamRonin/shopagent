#!/usr/bin/env node
/**
 * selftest.js — browser-free smoke test for the pure modules.
 *
 * Loads shared/utils.js, shared/locales.js, shared/i18n.js,
 * shared/storage.js, shared/sites.js and shared/llm.js into the current
 * Node global (they are plain IIFEs that only touch globalThis), then
 * asserts the behaviours that everything else depends on:
 *
 *   • Persian/Arabic digit + text normalisation
 *   • money parsing (grouping, decimals, Rial→Toman, multipliers)
 *   • budget phrase parsing («تا …», «بین … تا …»)
 *   • the offline rule-based intent parser
 *   • the deterministic local scorer
 *   • JSON extraction from messy model output
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
 * Load the shared modules into this global
 * ------------------------------------------------------------------ */

const MODULES = [
  'shared/utils.js',
  'shared/locales.js',
  'shared/i18n.js',
  'shared/storage.js',
  'shared/sites.js',
  'shared/llm.js',
];

for (const rel of MODULES) {
  const file = path.join(ROOT, rel);
  const code = fs.readFileSync(file, 'utf8');
  // indirect eval → runs in global scope, attaches to globalThis.ShopAgent
  (0, eval)(code);
}

const { utils, llm } = globalThis.ShopAgent;
if (!utils || !llm) {
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
 * 7. JSON extraction from messy model output
 * ------------------------------------------------------------------ */

section('json extraction');
eq('plain json', llm.safeJsonParse('{"a":1}'), { a: 1 });
eq('fenced json', llm.safeJsonParse('here you go:\n```json\n{"a": 2}\n```\nthanks'), { a: 2 });
eq('json inside prose', llm.safeJsonParse('sure! {"intent":"search","query":"x"} hope it helps'), { intent: 'search', query: 'x' });
eq('array', llm.safeJsonParse('[1,2,3]'), [1, 2, 3]);
eq('garbage → null', llm.safeJsonParse('no json here at all'), null);
eq('escaped quotes', llm.safeJsonParse('{"why":"he said \\"hi\\" , ok"}'), { why: 'he said "hi" , ok' });

/* ------------------------------------------------------------------ *
 * 8. Intent sanitisation (LLM output is untrusted)
 * ------------------------------------------------------------------ */

section('intent sanitisation');
{
  const s = llm.sanitizeIntent(
    { intent: 'hack', query: 'x'.repeat(500), maxPrice: -5, minPrice: 'abc', sort: 'nope', attributes: 'notarray', confidence: 99 },
    'ایرپاد',
    { maxResults: 6 }
  );
  eq('bad intent → search', s.intent, 'search');
  eq('query truncated', s.query.length, 160);
  eq('negative price → null', s.maxPrice, null);
  eq('garbage min → null', s.minPrice, null);
  eq('bad sort → best_match', s.sort, 'best_match');
  eq('non-array attrs → []', s.attributes, []);
  eq('confidence clamped', s.confidence, 1);
}

/* ------------------------------------------------------------------ *
 * 9. Store detection
 * ------------------------------------------------------------------ */

section('store detection');
eq('digikala www', ShopAgent.sites.detect('https://www.digikala.com/search/?q=x').id, 'digikala');
eq('digikala bare', ShopAgent.sites.detect('https://digikala.com/product/dkp-1/').id, 'digikala');
eq('basalam', ShopAgent.sites.detect('https://basalam.com/search?q=x').id, 'basalam');
eq('other → generic', ShopAgent.sites.detect('https://example.com/shop').id, 'generic');

/* ------------------------------------------------------------------ *
 * 10. i18n
 * ------------------------------------------------------------------ */

section('i18n');
{
  const i18n = ShopAgent.i18n;
  i18n.setLang('fa');
  eq('fa key', i18n.t('status.typing'), 'در حال تایپ');
  i18n.setLang('en');
  eq('en key', i18n.t('status.typing'), 'Typing');
  eq('missing key falls back to itself', i18n.t('no.such.key'), 'no.such.key');
  eq('placeholder substitution', i18n.t('results.count', { n: 5 }), '5 products found');
  i18n.setLang('fa');
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
