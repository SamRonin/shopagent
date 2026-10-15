/**
 * tests/parser.test.js — robust JSON parser & repair (shared/json.js).
 * Run: node --test tests/
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers/load');

const SA = load('shared/utils.js', 'shared/json.js');
const { safeJsonParse, repairJson } = SA.json;

test('parses clean JSON directly', () => {
  assert.deepEqual(safeJsonParse('{"a":1}'), { a: 1 });
  assert.deepEqual(safeJsonParse('[1,2,3]'), [1, 2, 3]);
});

test('extracts JSON from prose and fenced blocks', () => {
  assert.deepEqual(safeJsonParse('sure: ```json\n{"a": 2}\n``` end'), { a: 2 });
  assert.deepEqual(safeJsonParse('جوابت اینه {"intent":"search","query":"x"} موفق باشی'), { intent: 'search', query: 'x' });
});

test('repairs trailing commas', () => {
  assert.deepEqual(safeJsonParse('{"a":1,"b":[1,2,],}'), { a: 1, b: [1, 2] });
});

test('repairs single quotes and unquoted keys', () => {
  assert.deepEqual(safeJsonParse("{'intent':'search','maxResults':6}"), { intent: 'search', maxResults: 6 });
  assert.deepEqual(safeJsonParse('{intent: "search"}'), { intent: 'search' });
});

test('repairs python literals and comments', () => {
  assert.deepEqual(safeJsonParse('{"a": True, "b": None}'), { a: true, b: null });
  assert.deepEqual(safeJsonParse('{\n // comment\n "a": 1 /* block */\n}'), { a: 1 });
});

test('unifies smart quotes', () => {
  assert.deepEqual(safeJsonParse('{“a”:“b”}'), { a: 'b' });
});

test('returns null for hopeless input, never throws', () => {
  assert.equal(safeJsonParse('no json at all'), null);
  assert.equal(safeJsonParse(''), null);
  assert.equal(safeJsonParse(null), null);
  assert.equal(safeJsonParse(undefined), null);
});

test('repairJson is stable on already-valid JSON', () => {
  const valid = '{"intent":"search","query":"گوشی","maxPrice":8000000}';
  const out = repairJson(valid);
  assert.deepEqual(JSON.parse(out), JSON.parse(valid));
});

test('string-aware: commas/braces inside strings survive repair', () => {
  const raw = '{"why":"سلام، خوبی؟ {نه} [بله]"}';
  assert.deepEqual(safeJsonParse(raw), { why: 'سلام، خوبی؟ {نه} [بله]' });
});
