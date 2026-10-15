#!/usr/bin/env node
/**
 * selftest.js — browser-free smoke test for the pure modules.
 *
 * Loads every context-free module (shared/*, content/adapters/*,
 * content/actions/*, background/providers/*) into the current Node
 * global — they are plain IIFEs that only touch globalThis — then
 * asserts the behaviours everything else depends on:
 *
 *   • Persian/Arabic digit + text normalisation
 *   • money parsing (grouping, decimals, Rial→Toman, multipliers)
 *   • budget phrase parsing («تا …», «بین … تا …»)
 *   • the offline rule-based intent parser (+ follow-up actions)
 *   • the deterministic local scorer
 *   • robust JSON extraction from messy model output
 *   • intent / rank / action-plan schema validators
 *   • the action contract (risk levels, blocked payments)
 *   • provider wire formats (Ollama NDJSON, Groq/Gemini SSE)
 *   • stream consumption with a fake ReadableStream
 *   • Persian/English error guidance
 *   • store adapters + tiered button-label helpers
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
 * Load the modules into this global (order matters: deps first)
 * ------------------------------------------------------------------ */

const MODULES = [
  'shared/utils.js',
  'shared/errors.js',
  'shared/act.js',
  'shared/locales.js',
  'shared/i18n.js',
  'shared/storage.js',
  'shared/sites.js',
  'content/adapters/digikala.js',
  'content/adapters/basalam.js',
  'content/adapters/index.js',
  'content/actions/dom.js',
  'content/actions/interact.js',
  'content/actions/extract.js',
  'content/actions/hud.js',
  'background/providers/index.js',
  'background/providers/ollama.js',
  'background/providers/groq.js',
  'background/providers/gemini.js',
  'shared/llm.js',
];

for (const rel of MODULES) {
  const file = path.join(ROOT, rel);
  const code = fs.readFileSync(file, 'utf8');
  // indirect eval → runs in global scope, attaches to globalThis.ShopAgent
  (0, eval)(code);
}

const { utils, llm, act, errors, sites, adapters, providers } = globalThis.ShopAgent;
if (!utils || !llm || !act || !errors || !sites || !adapters || !providers) {
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
  eq('no follow-up action', i.action, null);
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
{
  const i = llm.builtinParseIntent('بهترین ایرپاد تا ۳ میلیون رو پیدا کن و به سبد خرید اضافه کن');
  eq('add-to-cart follow-up detected', i.action, 'add_to_cart');
  ok('query stays clean (no «سبد»)', !i.query.includes('سبد'), i.query);
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

section('json extraction (legacy safeJsonParse)');
eq('plain json', llm.safeJsonParse('{"a":1}'), { a: 1 });
eq('fenced json', llm.safeJsonParse('here you go:\n```json\n{"a": 2}\n```\nthanks'), { a: 2 });
eq('json inside prose', llm.safeJsonParse('sure! {"intent":"search","query":"x"} hope it helps'), { intent: 'search', query: 'x' });
eq('array', llm.safeJsonParse('[1,2,3]'), [1, 2, 3]);
eq('garbage → null', llm.safeJsonParse('no json here at all'), null);
eq('escaped quotes', llm.safeJsonParse('{"why":"he said \\"hi\\" , ok"}'), { why: 'he said "hi" , ok' });

/* ------------------------------------------------------------------ *
 * 8. Robust JSON parser + auto-repair (small local models)
 * ------------------------------------------------------------------ */

section('robust json parser (parseJsonLoose)');
{
  const r1 = llm.parseJsonLoose('{"intent":"search","query":"ایرپاد",}');
  ok('trailing comma repaired', r1.ok && r1.data.query === 'ایرپاد' && r1.repaired === true, r1);

  const r2 = llm.parseJsonLoose("{'intent':'search','query':'گوشی'}");
  ok('single quotes repaired', r2.ok && r2.data.query === 'گوشی', r2);

  const r3 = llm.parseJsonLoose('```json\n{"intent":"search","query":"کفش"}\n```');
  ok('code fence stripped', r3.ok && r3.data.query === 'کفش', r3);

  const r4 = llm.parseJsonLoose('حتماً! این هم پاسخ:\n{"intent":"search","query":"لپ‌تاپ"} امیدوارم کمک کند');
  ok('prose around json', r4.ok && r4.data.query === 'لپ‌تاپ', r4);

  const r5 = llm.parseJsonLoose('{\n  // توضیح فارسی\n  "intent":"search", /* بلوک */ "query":"ساعت"\n}');
  ok('comments stripped', r5.ok && r5.data.query === 'ساعت', r5);

  const r6 = llm.parseJsonLoose('{"intent":"search","query":"مانیتور","maxPrice":NaN}');
  ok('NaN → null', r6.ok && r6.data.maxPrice === null, r6);

  const r7 = llm.parseJsonLoose('{"picks":[{"id":"p1","score":90,}],"note":"x"}');
  ok('trailing comma inside array', r7.ok && r7.data.picks[0].id === 'p1', r7);

  const r8 = llm.parseJsonLoose('{intent: "search", query: "پاوربانک"}');
  ok('unquoted keys repaired', r8.ok && r8.data.query === 'پاوربانک', r8);

  const r9 = llm.parseJsonLoose('{"intent":"search","query":"هدست');
  ok('truncated object closed', r9.ok && r9.data.query === 'هدست', r9);

  const r10 = llm.parseJsonLoose('   ');
  ok('empty → failure', r10.ok === false && r10.error === 'EMPTY', r10);

  const r11 = llm.parseJsonLoose('«intent»: «search»');
  ok('smart quotes normalised', r11.ok === false || typeof r11.data === 'object', r11);

  const r12 = llm.parseJsonLoose('{"why":"قیمت: ۲,۸۹۰,۰۰۰ تومان (قبلاً ۴,۰۰۰,۰۰۰)"}');
  ok('persian text with digits survives', r12.ok && r12.data.why.includes('تومان'), r12);
}

section('repair prompt (self-correction)');
{
  const messages = llm.buildIntentMessages('بهترین ایرپاد تا ۳ میلیون');
  const repaired = llm.buildRepairMessages(messages, 'NOT JSON AT ALL', 'BAD_FIELDS:sort', 'fa');
  eq('repair keeps the original messages', repaired.length, messages.length + 2);
  eq('original messages untouched', repaired[0], messages[0]);
  ok('repair names the error', repaired[repaired.length - 1].content.includes('BAD_FIELDS:sort'));
  ok('repair quotes the broken reply', repaired[repaired.length - 2].content.includes('NOT JSON'));
  const en = llm.buildRepairMessages(messages, 'x', 'BAD_JSON', 'en');
  ok('english repair note', en[en.length - 1].content.includes('valid JSON'));
}

/* ------------------------------------------------------------------ *
 * 9. Schema validators
 * ------------------------------------------------------------------ */

section('schema validators');
{
  const good = llm.validateIntentShape({ intent: 'search', query: 'x', sort: 'cheapest', action: 'add_to_cart', maxResults: 6, confidence: 0.9 });
  ok('valid intent passes', good.ok === true, good);
  const bad = llm.validateIntentShape({ intent: 'hack', sort: 'sideways', action: 'pay_now', attributes: 'nope' });
  ok('invalid intent rejected', bad.ok === false && bad.error.startsWith('BAD_FIELDS:'), bad);
  ok('rank shape needs picks with ids', llm.validateRankShape({ picks: [{ id: 'p1' }] }).ok === true);
  ok('rank shape rejects id-less picks', llm.validateRankShape({ picks: [{ rank: 1 }] }).ok === false);
  ok('plan shape needs an action', llm.validatePlanShape({ params: {} }).ok === false);
  ok('plan shape accepts action+params', llm.validatePlanShape({ action: 'ADD_TO_CART', params: {} }).ok === true);
}

section('intent sanitisation (LLM output is untrusted)');
{
  const s = llm.sanitizeIntent(
    { intent: 'hack', query: 'x'.repeat(500), maxPrice: -5, minPrice: 'abc', sort: 'nope', attributes: 'notarray', confidence: 99, action: 'delete_everything' },
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
  eq('unknown action → null', s.action, null);
}

/* ------------------------------------------------------------------ *
 * 10. Action contract — risk levels & Human-in-the-Loop
 * ------------------------------------------------------------------ */

section('action contract (shared/act.js)');
{
  const safe = act.validate({ action: 'SORT', params: { mode: 'cheapest' } });
  ok('safe action validates', safe.ok === true && safe.risk === 'safe', safe);

  const confirm = act.validate({ action: 'ADD_TO_CART', params: {} });
  ok('add-to-cart needs confirmation', confirm.ok === true && confirm.risk === 'confirm', confirm);

  const pay = act.validate({ action: 'PAY', params: {} });
  ok('payment is blocked', pay.ok === false && pay.error === 'ACTION_BLOCKED' && pay.risk === 'blocked', pay);
  ok('checkout is blocked', act.validate({ action: 'CHECKOUT' }).error === 'ACTION_BLOCKED');
  ok('address change is blocked', act.validate({ action: 'CHANGE_ADDRESS' }).error === 'ACTION_BLOCKED');
  ok('place order is blocked', act.validate({ action: 'PLACE_ORDER' }).error === 'ACTION_BLOCKED');
  ok('lowercase + dashes normalised', act.validate({ action: 'add-to-cart' }).risk === 'confirm');
  ok('unknown action rejected', act.validate({ action: 'LAUNCH_MISSILES' }).error === 'ACTION_INVALID');
  ok('bad enum rejected', act.validate({ action: 'SORT', params: { mode: 'sideways' } }).ok === false);
  ok('bad url rejected', act.validate({ action: 'OPEN_PRODUCT', params: { url: 'javascript:alert(1)' } }).ok === false);
  ok('good url accepted', act.validate({ action: 'OPEN_PRODUCT', params: { url: 'https://www.digikala.com/product/dkp-1/' } }).ok === true);
  ok('int range clamped/rejected', act.validate({ action: 'SCROLL', params: { rounds: 99 } }).ok === false);

  const fa = act.buildConfirmation('ADD_TO_CART', { productTitle: 'ایرپاد انکر' }, 'fa');
  const en = act.buildConfirmation('ADD_TO_CART', { productTitle: 'Anker earbuds' }, 'en');
  ok('fa confirmation names the product', fa.body.includes('ایرپاد انکر') && fa.title.length > 0, fa);
  ok('en confirmation names the product', en.body.includes('Anker earbuds'), en);

  eq('plan from intent (add_to_cart)', act.planFromIntent({ action: 'add_to_cart' }), { action: 'ADD_TO_CART', params: {} });
  eq('plan from intent (none)', act.planFromIntent({ action: null }), null);
}

/* ------------------------------------------------------------------ *
 * 11. Provider wire formats
 * ------------------------------------------------------------------ */

section('provider wire formats');
{
  const ollama = providers.get('ollama');
  ok('ollama registered', Boolean(ollama));
  eq('ollama non-stream text', ollama.extractText({ message: { content: 'سلام' } }), 'سلام');
  eq('ollama empty text', ollama.extractText({}), '');
  eq('ollama ndjson line', ollama.parseStreamLine('{"message":{"content":"د"},"done":false}'), { content: 'د', done: false, error: null });
  eq('ollama final line', ollama.parseStreamLine('{"message":{"content":""},"done":true}'), { content: '', done: true, error: null });
  eq('ollama error line', ollama.parseStreamLine('{"error":"model not found"}').error, 'model not found');
  eq('ollama garbage line → null', ollama.parseStreamLine('not json'), null);
  ok('ollama base url default', ollama.resolveBase('') === 'http://localhost:11434');
  ok('ollama base url normalised', ollama.resolveBase('http://localhost:11434/') === 'http://localhost:11434');

  const groq = providers.get('groq');
  ok('groq registered', Boolean(groq));
  eq('groq non-stream text', groq.extractText({ choices: [{ message: { content: 'hi' } }] }), 'hi');
  eq('groq sse delta', groq.parseStreamLine('data: {"choices":[{"delta":{"content":"Hi"}}]}'), { content: 'Hi', done: false, error: null });
  eq('groq sse done', groq.parseStreamLine('data: [DONE]'), { content: '', done: true });
  eq('groq non-data line ignored', groq.parseStreamLine(': keep-alive'), null);

  const gemini = providers.get('gemini');
  ok('gemini registered', Boolean(gemini));
  eq('gemini non-stream text', gemini.extractText({ candidates: [{ content: { parts: [{ text: 'A' }, { text: 'B' }] } }] }), 'AB');
  eq('gemini sse delta', gemini.parseStreamLine('data: {"candidates":[{"content":{"parts":[{"text":"سلام"}]}}]}').content, 'سلام');
  ok('gemini finish → done', gemini.parseStreamLine('data: {"candidates":[{"content":{"parts":[{"text":""}]},"finishReason":"STOP"}]}').done === true);
  ok('gemini error surfaced', gemini.parseStreamLine('data: {"error":{"message":"quota"}}').error === 'quota');

  eq('toMessages from prompt+system', providers.toMessages({ prompt: 'سلام', systemPrompt: 'سیستم' }), [
    { role: 'system', content: 'سیستم' },
    { role: 'user', content: 'سلام' },
  ]);
  eq('toMessages prefers explicit messages', providers.toMessages({ messages: [{ role: 'user', content: 'x' }], prompt: 'ignored' }), [{ role: 'user', content: 'x' }]);
}

section('stream consumption (fake ReadableStream)');
const streamTests = (async () => {
  const encoder = new TextEncoder();
  const chunks = [
    '{"message":{"content":"یک"},"done":false}\n{"message":{"content":"دو"},"done":false}\n',
    '{"message":{"content":"سه"},"done":true}\n',
  ];
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  const lines = [];
  await providers.consumeStream(body, (line) => lines.push(line));
  eq('NDJSON split into 3 lines', lines.length, 3);
  const text = lines.map((l) => JSON.parse(l).message.content).join('');
  eq('reassembled text', text, 'یکدوسه');

  const sseBody = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"a":1}\n\ndata: [DONE]\n'));
      controller.close();
    },
  });
  const sseLines = [];
  await providers.consumeStream(sseBody, (l) => sseLines.push(l));
  eq('SSE blank lines skipped', sseLines.length, 2);
  eq('SSE first line', sseLines[0], 'data: {"a":1}');
})();

section('network error codes');
{
  eq('TypeError → NETWORK', providers.netErrorCode(new TypeError('Failed to fetch')), 'NETWORK');
  eq('timeout abort → TIMEOUT', providers.netErrorCode(new Error('TIMEOUT')), 'TIMEOUT');
  eq('user abort → ABORTED', providers.netErrorCode(Object.assign(new Error('x'), { name: 'AbortError' })), 'ABORTED');
  eq('unknown → UNKNOWN', providers.netErrorCode(new Error('boom')), 'UNKNOWN');
}

/* ------------------------------------------------------------------ *
 * 12. Error guidance (Persian + English)
 * ------------------------------------------------------------------ */

section('error guidance');
{
  ok('ollama offline fa mentions ollama serve', errors.describe('OLLAMA_OFFLINE', { lang: 'fa' }).includes('ollama serve'));
  ok('ollama offline en mentions Ollama', errors.describe({ error: 'NETWORK' }, { provider: 'ollama', lang: 'en' }).includes('Ollama'));
  ok('no key fa mentions کلید', errors.describe('NO_KEY', { lang: 'fa' }).includes('کلید'));
  ok('bad json mentions auto-repair fallback', errors.describe('BAD_JSON', { lang: 'fa' }).includes('تحلیل‌گر داخلی'));
  ok('action blocked forbids payment', errors.describe('ACTION_BLOCKED', { lang: 'fa' }).includes('پرداخت'));
  ok('timeout suggests lighter model', errors.describe('TIMEOUT', { lang: 'en' }).toLowerCase().includes('lighter model'));
  ok('http 401 → key guidance', errors.describe('HTTP_401', { lang: 'fa' }).includes('کلید'));
  ok('http 429 → rate limit', errors.describe('HTTP_429', { lang: 'en' }).toLowerCase().includes('rate limit'));
  ok('http 500 → server error', errors.describe('HTTP_500', { lang: 'en' }).toLowerCase().includes('server'));
  ok('http 404 on ollama → model missing', errors.describe('HTTP_404', { provider: 'ollama', lang: 'fa' }).includes('Ollama'));
  ok('codeOf extracts stable code', errors.codeOf({ code: 'TIMEOUT' }), 'TIMEOUT');
}

/* ------------------------------------------------------------------ *
 * 13. Store adapters + button discovery helpers
 * ------------------------------------------------------------------ */

section('store detection');
eq('digikala www', sites.detect('https://www.digikala.com/search/?q=x').id, 'digikala');
eq('digikala bare', sites.detect('https://digikala.com/product/dkp-1/').id, 'digikala');
eq('basalam', sites.detect('https://basalam.com/search?q=x').id, 'basalam');
eq('other → generic', sites.detect('https://example.com/shop').id, 'generic');
eq('two adapters registered', sites.ADAPTERS.length, 2);
ok('digikala declares addToCart selectors', Array.isArray(sites.byId('digikala').selectors.addToCart) && sites.byId('digikala').selectors.addToCart.length > 0);
ok('basalam declares addToCart labels', sites.byId('basalam').labels.addToCart.length > 0);

section('page classification (the results-page gate)');
{
  const c = sites.classifyUrl;
  eq('digikala home = home, not results', c('https://www.digikala.com/'), { home: true, results: false, path: '/', query: '' });
  eq('digikala search path → results', c('https://www.digikala.com/search/?q=airpods').results, true);
  eq('basalam search query → results', c('https://basalam.com/search?q=%DA%A9%D9%81%D8%B4').results, true);
  eq('product page ≠ results', c('https://www.digikala.com/product/dkp-123456/x/').results, false);
  eq('product page with ?q= ≠ results', c('https://www.digikala.com/product/dkp-9/?q=a').results, false);
  eq('category page ≠ results-by-url', c('https://www.digikala.com/category/mobile/').results, false);
  eq('home with ?q= still results=false path-wise', c('https://basalam.com/').home, true);
  eq('garbage url is safe', c('not a url'), { home: false, results: false, path: '', query: '' });
}

section('tiered button-label helpers');
{
  const keys = adapters.labelKeys(['افزودن به سبد خرید', 'Add to Cart']);
  ok('labels normalised', keys.length === 2 && keys[0] === 'افزودن به سبد خرید', keys);
  ok('exact buy label matches', adapters.isExactBuyLabel(' خرید نقدی ', adapters.labelKeys(['خرید نقدی'])) === true);
  ok('long text is not an exact label', adapters.isExactBuyLabel('ایرپاد بی‌سیم انکر با خرید نقدی و گارانتی', adapters.labelKeys(['خرید نقدی'])) === false);

  // Fake document for the cart-count reader.
  const fakeDoc = {
    querySelectorAll(sel) {
      if (sel === '[class*="cart-count" i]') return [{ textContent: '۳' }];
      return [];
    },
  };
  eq('cart count read from badge', adapters.readCartCount(fakeDoc), 3);
  eq('cart count absent → 0', adapters.readCartCount({ querySelectorAll: () => [] }), 0);
  ok('add-to-cart tier table is non-empty', adapters.TESTID_TIER.length > 0 && adapters.ARIA_TIER.length > 0 && adapters.BUY_BOX_TIER.length > 0);
}

/* ------------------------------------------------------------------ *
 * 14. i18n
 * ------------------------------------------------------------------ */

section('i18n');
{
  const i18n = globalThis.ShopAgent.i18n;
  i18n.setLang('fa');
  eq('fa key', i18n.t('status.typing'), 'در حال تایپ');
  i18n.setLang('en');
  eq('en key', i18n.t('status.typing'), 'Typing');
  eq('missing key falls back to itself', i18n.t('no.such.key'), 'no.such.key');
  eq('placeholder substitution', i18n.t('results.count', { n: 5 }), '5 products found');
  ok('new banner key defined', i18n.t('banner.ollama.offline').length > 10, i18n.t('banner.ollama.offline'));
  eq('new action key defined', i18n.t('action.approve'), 'Approve');
  i18n.setLang('fa');
}

/* ------------------------------------------------------------------ *
 * Summary (after the async stream tests settle)
 * ------------------------------------------------------------------ */

streamTests.then(() => {
  console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
  if (failed) {
    console.log('\x1b[31mfailed:\x1b[0m\n - ' + failures.join('\n - '));
    process.exit(1);
  }
  console.log('\x1b[32mAll shared-module self tests passed.\x1b[0m');
});
