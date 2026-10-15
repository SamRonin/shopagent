/**
 * tests/schema.test.js — intent & ranking validators (shared/schema.js).
 * Run: node --test tests/
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers/load');

const SA = load('shared/utils.js', 'shared/schema.js');
const { validateIntent, validateRanking } = SA.schema;

test('valid intent passes with ok=true and no errors', () => {
  const v = validateIntent(
    { intent: 'search', query: 'ایرپاد', maxPrice: 3000000, sort: 'cheapest', confidence: 0.9, maxResults: 6 },
    { originalText: '', stopWords: [] }
  );
  assert.equal(v.ok, true);
  assert.equal(v.value.query, 'ایرپاد');
  assert.equal(v.value.maxPrice, 3000000);
  assert.deepEqual(v.errors, []);
});

test('wrong types are coerced and reported', () => {
  const v = validateIntent(
    { intent: 42, query: 12345, maxPrice: 'سه میلیون', sort: 'random', attributes: 'بی‌سیم، ضدآب', confidence: 'x' },
    { originalText: '', stopWords: [] }
  );
  assert.equal(v.ok, false);
  assert.equal(v.value.intent, 'search');
  assert.equal(v.value.query, '12345'); // numbers become strings, length-capped
  assert.equal(v.value.maxPrice, null); // non-numeric money → null
  assert.equal(v.value.sort, 'best_match');
  assert.deepEqual(v.value.attributes, ['بی‌سیم', 'ضدآب']);
  assert.equal(v.value.confidence, 0);
});

test('missing query is recovered from the original text', () => {
  const v = validateIntent({ intent: 'search', query: '' }, { originalText: 'دنبال یه لپ تاپ ایسوس هستم', stopWords: ['دنبال', 'یه', 'هستم'] });
  assert.ok(v.value.query.includes('لپ'));
});

test('min/max swap when inverted', () => {
  const v = validateIntent({ query: 'کفش', minPrice: 2000000, maxPrice: 500000 }, {});
  assert.equal(v.value.minPrice, 500000);
  assert.equal(v.value.maxPrice, 2000000);
  assert.ok(v.errors.some((e) => e.includes('جابه‌جا')));
});

test('hallucinated action channels are stripped and flagged', () => {
  const v = validateIntent({ query: 'گوشی', action: 'checkout', click: '#pay' }, {});
  assert.ok(!('action' in v.value) && !('click' in v.value));
  assert.ok(v.errors.some((e) => e.includes('اکشن')));
});

test('ranking: unknown ids dropped, sorted by rank, scores clamped', () => {
  const pool = [{ id: 'p1', title: 'A' }, { id: 'p2', title: 'B' }];
  const v = validateRanking({ picks: [{ id: 'p1', rank: 2 }, { id: 'ghost', rank: 1 }, { id: 'p2', rank: 1, score: 250 }] }, pool);
  assert.equal(v.value.length, 2);
  assert.deepEqual(v.value.map((p) => p.id), ['p2', 'p1']);
  assert.equal(v.value[0].score, 100);
  assert.ok(v.errors.some((e) => e.includes('ghost')));
});

test('ranking: bare array accepted, garbage rejected', () => {
  const pool = [{ id: 'p1' }];
  assert.deepEqual(validateRanking([{ id: 'p1', rank: 1 }], pool).value.length, 1);
  assert.equal(validateRanking('nonsense', pool).value.length, 0);
  assert.equal(validateRanking(null, pool).ok, false);
});
