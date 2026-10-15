/**
 * tests/content-smoke.test.js — load the content-script bundle in the
 * exact manifest order against minimal DOM/chrome stubs, then verify the
 * message router is wired and every background action has a handler.
 * Run: node --test "tests/*.test.js"
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./helpers/load');

test('content bundle loads in manifest order and wires every action', () => {
  // ---- minimal browser stubs (load-time only; actions never run here) ----
  const messageListeners = [];
  global.window = globalThis;
  global.location = new URL('https://www.digikala.com/search/?q=test');
  global.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      sendMessage: async () => {},
    },
    storage: {
      sync: {
        // liveHud:false keeps the HUD from building DOM during the smoke test
        get: (_key, cb) => cb({ settings: { liveHud: false } }),
      },
    },
  };
  global.document = {
    readyState: 'complete',
    addEventListener: () => {},
    querySelector: () => null,
    documentElement: {},
  };
  const realSetInterval = global.setInterval;
  global.setInterval = () => 0; // SPA watcher would keep the test alive

  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    const files = manifest.content_scripts[0].js;
    for (const rel of files) {
      const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      (0, eval)(code.replace(/^#![^\n]*/, ''));
    }

    const SA = globalThis.ShopAgent;

    // Namespace pieces the actions rely on.
    assert.ok(SA.utils && SA.sites && SA.guardrails && SA.adapters && SA.actions);
    assert.ok(SA.actions.dom && SA.actions.hud && SA.actions.events && SA.actions.scroll);
    assert.ok(SA.actions.extract && SA.actions.click && SA.actions.cart && SA.actions.guard);

    // The adapter resolved for the stubbed Digikala URL.
    assert.equal(SA.adapters.current().id, 'digikala');

    // Content script registered its message router exactly once.
    assert.equal(messageListeners.length, 1);

    // Every action the background may call has a handler.
    const wanted = ['PING', 'SYNC_SETTINGS', 'SEARCH', 'SUBMIT_SEARCH', 'SCROLL', 'EXTRACT', 'SORT', 'PRICE_FILTER', 'NEXT_PAGE', 'CLICK_TEXT', 'ADD_TO_CART', 'PAGE_KIND', 'READ_PAGE', 'READ_PRODUCT', 'STOP', 'HUD'];
    const src = fs.readFileSync(path.join(ROOT, 'content/content.js'), 'utf8');
    for (const action of wanted) {
      assert.ok(new RegExp(`^\\s{4}${action}:\\s*async`, 'm').test(src), `missing handler: ${action}`);
    }

    // Runtime context is bound into the DOM layer.
    assert.ok(SA.actions.dom.rt, 'runtime not bound to actions.dom');
    assert.equal(typeof SA.actions.dom.rt.throwIfAborted, 'function');
  } finally {
    global.setInterval = realSetInterval;
    delete global.window;
    delete global.chrome;
    delete global.document;
    delete global.location;
  }
});

test('background bundle load order satisfies its own dependencies', () => {
  // importScripts list order must define utils → errors → sse → providers → llm.
  const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const list = bg.match(/importScripts\(([\s\S]*?)\);/)[1].match(/'([^']+)'/g).map((s) => s.replace(/'/g, ''));
  const idx = (f) => list.indexOf(f);
  assert.ok(idx('shared/utils.js') === 0, 'utils must load first');
  assert.ok(idx('shared/errors.js') < idx('background/providers/ollama.js'), 'errors before providers');
  assert.ok(idx('background/providers/sse.js') < idx('background/providers/ollama.js'), 'sse before providers');
  assert.ok(idx('background/providers/index.js') < idx('shared/llm.js'), 'provider registry before llm (META read)');
  assert.ok(idx('shared/json.js') < idx('shared/llm.js') && idx('shared/schema.js') < idx('shared/llm.js'), 'json+schema before llm');
});
