/**
 * tests/stream.test.js — SSE/NDJSON transport parsing
 * (background/providers/sse.js) + provider payload shapes.
 * Run: node --test tests/
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers/load');

const SA = load('shared/utils.js', 'background/providers/sse.js');
const { makeLineSplitter, parseSseLine } = SA.sse;

test('ndjson lines survive arbitrary chunk boundaries', () => {
  const sp = makeLineSplitter();
  const out = [
    ...sp.push('{"a":1}\n{"b"'),
    ...sp.push(':2}\n{"c":'),
    ...sp.push('3}\n'),
    ...sp.flush(),
  ];
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((l) => JSON.parse(l)), [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

test('crlf line endings are handled', () => {
  const sp = makeLineSplitter();
  const out = [...sp.push('data: {"x":1}\r\ndata: {"y":2}\r\n'), ...sp.flush()];
  assert.equal(out.length, 2);
});

test('flush emits the trailing partial line', () => {
  const sp = makeLineSplitter();
  assert.deepEqual([...sp.push('no newline at end'), ...sp.flush()], ['no newline at end']);
});

test('sse lines: payloads parsed, sentinels and comments ignored', () => {
  assert.deepEqual(parseSseLine('data: {"choices":[{"delta":{"content":"تو"}}]}').choices[0].delta.content, 'تو');
  assert.equal(parseSseLine('data: [DONE]'), null);
  assert.equal(parseSseLine(': keep-alive'), null);
  assert.equal(parseSseLine('event: content_block_delta'), null);
  assert.equal(parseSseLine('data: {broken'), null);
});

test('ollama stream body shape → token extraction (contract test)', () => {
  // Mirrors what background/providers/ollama.js reads from each NDJSON line.
  const line = JSON.parse('{"model":"llama3.2","message":{"content":"سلام"},"done":false}');
  assert.equal(line.message.content, 'سلام');
});

test('groq stream body shape → token extraction (contract test)', () => {
  const payload = parseSseLine('data: {"choices":[{"delta":{"content":"Hi"}}]}');
  assert.equal(payload.choices[0].delta.content, 'Hi');
});

test('gemini stream body shape → token extraction (contract test)', () => {
  const payload = parseSseLine('data: {"candidates":[{"content":{"parts":[{"text":"سلام"}]}}]}');
  assert.equal(payload.candidates[0].content.parts.map((p) => p.text).join(''), 'سلام');
});
