#!/usr/bin/env node
/**
 * protocol.test.js — integration test for the background orchestrator.
 *
 * Stubs the `chrome` APIs the service worker uses (tabs, runtime,
 * scripting, storage, action, sidePanel) plus `importScripts`, then
 * loads the REAL background.js and drives it through the message
 * protocol:
 *
 *   • settings / tab-context routing
 *   • RUN_TASK end-to-end with the offline (builtin) provider and a
 *     fully scripted content-script double
 *   • EXEC_ACTION risk gating: blocked (PAY) vs confirm (ADD_TO_CART)
 *   • CONFIRM_ACTION approve / cancel paths
 *   • OLLAMA_STATUS banner probe
 *
 * No browser, no network, no dependencies.
 *
 * Usage:  node scripts/protocol.test.js
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

function section(title) {
  console.log(`\n\x1b[36m▸ ${title}\x1b[0m`);
}

/* ------------------------------------------------------------------ *
 * chrome stub
 * ------------------------------------------------------------------ */

const broadcasts = []; // everything background.js pushes to the UI
let messageListener = null;
const store = {
  sync: { settings: { provider: 'builtin', language: 'fa' } },
  local: {},
};

const TABS = [
  { id: 1, url: 'https://www.digikala.com/', status: 'complete', windowId: 10, active: true, title: 'دیجی‌کالا' },
];

/** Content-script double: answers SHOPAGENT_* messages like the page would. */
const CONTENT_REPLIES = {
  SHOPAGENT_PING: { ok: true, store: 'digikala', url: 'https://www.digikala.com/', ready: true, cards: 0, hasSearchInput: true },
  SHOPAGENT_PAGE_KIND: { ok: true, url: 'https://www.digikala.com/', home: false, resultsUrl: true, resultsDom: true, results: true, cards: 3 },
  SHOPAGENT_SYNC_SETTINGS: { ok: true },
  SHOPAGENT_SEARCH: { ok: true, ok2: true, resultsPage: true, urlChanged: true, cards: 3 },
  SHOPAGENT_SCROLL: { ok: true, scrolled: 100, cards: 3 },
  SHOPAGENT_SORT: { ok: true, method: 'select' },
  SHOPAGENT_PRICE_FILTER: { ok: true, method: 'inputs' },
  SHOPAGENT_EXTRACT: {
    ok: true,
    products: [
      { id: 'p1', title: 'ایرپاد بی‌سیم انکر Soundcore', price: 2400000, rating: 4.5, ratingCount: 320, discount: 20, inStock: true, url: 'https://www.digikala.com/product/dkp-1/', store: 'digikala', storeLabel: 'دیجی‌کالا' },
      { id: 'p2', title: 'ایرپاد بی‌سیم سونی WH-1000', price: 7800000, rating: 4.8, ratingCount: 90, discount: 0, inStock: true, url: 'https://www.digikala.com/product/dkp-2/', store: 'digikala', storeLabel: 'دیجی‌کالا' },
      { id: 'p3', title: 'هندزفری بی‌سیم شیائومی', price: 890000, rating: 4.1, ratingCount: 12, discount: 5, inStock: true, url: 'https://www.digikala.com/product/dkp-3/', store: 'digikala', storeLabel: 'دیجی‌کالا' },
    ],
    meta: { url: 'https://www.digikala.com/search/?q=x', store: 'digikala' },
  },
  SHOPAGENT_ACT: { ok: true, action: 'ADD_TO_CART', method: 'button-text', tier: 5, evidence: { ok: true } },
  SHOPAGENT_STOP: { ok: true },
};

const promise = (v) => Promise.resolve(v);

globalThis.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => (messageListener = fn) },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    sendMessage: (msg) => {
      broadcasts.push(msg);
      return promise();
    },
    lastError: null,
    getManifest: () => ({ version: '1.0.0' }),
  },
  tabs: {
    query: () => promise(TABS.filter((t) => t.active)),
    get: (id) => promise(TABS.find((t) => t.id === id) || null),
    update: (id, patch) => {
      const tab = TABS.find((t) => t.id === id);
      if (tab) Object.assign(tab, patch);
      return promise(tab);
    },
    create: (patch) => {
      const tab = { id: 99, status: 'complete', windowId: 10, active: true, ...patch };
      TABS.push(tab);
      return promise(tab);
    },
    sendMessage: (tabId, msg, cb) => {
      const reply = CONTENT_REPLIES[msg.type] || { ok: false, error: `UNKNOWN_ACTION:${msg.type}` };
      setTimeout(() => cb(reply), 0);
      return true;
    },
  },
  scripting: {
    insertCSS: () => promise(),
    executeScript: () => promise([]),
  },
  storage: {
    local: {
      get: (key) => promise(store.local[key] ?? {}),
      set: (obj) => {
        Object.assign(store.local, obj);
        return promise();
      },
      remove: () => promise(),
    },
    sync: {
      get: (key) => promise({ [key]: store.sync[key] }),
      set: (obj) => {
        Object.assign(store.sync, obj);
        return promise();
      },
      remove: () => promise(),
    },
    onChanged: { addListener: () => {}, removeListener: () => {} },
  },
  action: {
    setBadgeText: () => promise(),
    setBadgeBackgroundColor: () => promise(),
    onClicked: { addListener: () => {} },
  },
  sidePanel: {
    setPanelBehavior: () => promise(),
    open: () => promise(),
  },
  windows: { update: () => promise() },
};

globalThis.importScripts = (...files) => {
  for (const f of files) {
    (0, eval)(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  }
};

/* ------------------------------------------------------------------ *
 * Load the real service worker
 * ------------------------------------------------------------------ */

(0, eval)(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'));

// Keep the test output readable: the worker logs every progress step.
globalThis.ShopAgent.utils.setLogLevel('error');

/** Send a message through the captured listener and await the response. */
function dispatch(msg) {
  return new Promise((resolve) => {
    messageListener(msg, { tab: { id: 1 } }, (res) => resolve(res));
  });
}

/** Send a message straight to the loaded content script (not the worker). */
function dispatchToContent(msg) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const ret = messageListener(msg, { id: TABS[0].id, tab: TABS[0] }, done);
    if (ret && typeof ret.then === 'function') ret.then(done, () => done(undefined));
    setTimeout(() => done(undefined), 4000);
  });
}

/** Wait until a broadcast of `type` (optionally matching `pred`) arrives. */
function waitForBroadcast(type, pred, timeout = 4000) {
  const existing = broadcasts.find((b) => b.type === type && (!pred || pred(b)));
  if (existing) return promise(existing);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const found = broadcasts.find((b) => b.type === type && (!pred || pred(b)));
      if (found) {
        clearInterval(timer);
        resolve(found);
      } else if (Date.now() - started > timeout) {
        clearInterval(timer);
        reject(new Error(`timeout waiting for ${type}`));
      }
    }, 20);
  });
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

(async () => {
  await new Promise((r) => setTimeout(r, 50)); // let the SW boot

  section('message routing');
  {
    const res = await dispatch({ type: 'GET_SETTINGS' });
    ok('GET_SETTINGS returns settings', res.ok === true && res.settings.provider === 'builtin', res);

    const ctx = await dispatch({ type: 'GET_TAB_CONTEXT' });
    ok('GET_TAB_CONTEXT detects the store', ctx.ok === true && ctx.store?.id === 'digikala' && ctx.store?.supported === true, ctx);

    const unknown = await dispatch({ type: 'NOPE' });
    ok('unknown type → UNKNOWN:NOPE', unknown.ok === false && unknown.error === 'UNKNOWN:NOPE', unknown);

    const parsed = await dispatch({ type: 'PARSE_LOCAL', text: 'بهترین ایرپاد تا ۳ میلیون' });
    ok('PARSE_LOCAL works offline', parsed.ok === true && parsed.intent.maxPrice === 3000000, parsed);
  }

  section('OLLAMA_STATUS probe');
  {
    const res = await dispatch({ type: 'OLLAMA_STATUS', settings: { ollama: { baseUrl: 'http://localhost:11434', model: 'llama3.2' } } });
    // No Ollama runs in this sandbox → online:false with a stable error code.
    ok('probe answers with a status object', res.ok === true && typeof res.online === 'boolean', res);
    ok('offline probe is graceful', res.online === false && Boolean(res.error), res);
  }

  section('action gating (Human-in-the-Loop)');
  {
    const blocked = await dispatch({ type: 'EXEC_ACTION', action: 'PAY', params: {} });
    ok('PAY is blocked before any tab work', blocked.ok === false && blocked.error === 'ACTION_BLOCKED', blocked);
    ok('blocked answer carries Persian guidance', typeof blocked.message === 'string' && blocked.message.includes('پرداخت'), blocked);

    const invalid = await dispatch({ type: 'EXEC_ACTION', action: 'LAUNCH_MISSILES', params: {} });
    ok('unknown action is invalid', invalid.ok === false && invalid.error === 'ACTION_INVALID', invalid);

    const confirm = await dispatch({ type: 'EXEC_ACTION', action: 'ADD_TO_CART', params: {}, product: { title: 'ایرپاد انکر', url: 'https://www.digikala.com/product/dkp-1/' } });
    ok('ADD_TO_CART waits for confirmation', confirm.ok === true && confirm.pending === true && Boolean(confirm.confirmId), confirm);

    const request = broadcasts.find((b) => b.type === 'SHOPAGENT_CONFIRM_REQUEST');
    ok('confirmation request was broadcast', Boolean(request) && request.action === 'ADD_TO_CART', request);
    ok('confirmation copy names the product', request?.fa?.body?.includes('ایرپاد انکر'), request?.fa);

    // Decline → nothing executes, the panel is told.
    const declined = await dispatch({ type: 'CONFIRM_ACTION', confirmId: confirm.confirmId, approve: false });
    ok('declining cancels the action', declined.ok === false && declined.error === 'ACTION_UNCONFIRMED', declined);
    const result = broadcasts.find((b) => b.type === 'SHOPAGENT_CONFIRM_RESULT');
    ok('cancel result broadcast', result?.ok === false && result.error === 'ACTION_UNCONFIRMED', result);

    // Approve → the content script's ACT handler runs.
    const again = await dispatch({ type: 'EXEC_ACTION', action: 'ADD_TO_CART', params: {}, product: { title: 'ایرپاد انکر', url: 'https://www.digikala.com/product/dkp-1/' } });
    const approved = await dispatch({ type: 'CONFIRM_ACTION', confirmId: again.confirmId, approve: true });
    ok('approved action executes', approved.ok === true && approved.result?.action === 'ADD_TO_CART', approved);
    ok('approval navigated to the product page', TABS[0].url === 'https://www.digikala.com/product/dkp-1/', TABS[0].url);

    const expired = await dispatch({ type: 'CONFIRM_ACTION', confirmId: 'confirm_nope', approve: true });
    ok('stale confirmation is refused', expired.ok === false && expired.error === 'CONFIRM_EXPIRED', expired);
  }

  section('RUN_TASK end-to-end (builtin provider, scripted page)');
  {
    const started = await dispatch({ type: 'RUN_TASK', text: 'بهترین ایرپاد تا ۳ میلیون تومان', store: 'digikala' });
    ok('RUN_TASK answers immediately with a taskId', started.ok === true && typeof started.taskId === 'string', started);

    const result = await waitForBroadcast('SHOPAGENT_RESULT', (b) => b.taskId === started.taskId);
    ok('a result was broadcast', Boolean(result.result), result);

    const r = result.result;
    ok('run succeeded', r.ok === true, r.error);
    ok('intent parsed offline (builtin)', r.intent?.source === 'builtin' && r.intent?.maxPrice === 3000000, r.intent);
    ok('products ranked', Array.isArray(r.products) && r.products.length >= 1, r.products?.length);
    ok('in-budget pick ranks first', r.products?.[0]?.price <= 3000000, r.products?.[0]?.price);
    ok('every pick carries a reason', r.products?.every((p) => typeof p.why === 'string' && p.why.length > 0), r.products?.map((p) => p.why));
    ok('run was persisted as lastRun', store.local.lastRun?.ok === true, Object.keys(store.local));

    const statuses = broadcasts.filter((b) => b.type === 'SHOPAGENT_PROGRESS' && b.taskId === started.taskId).map((b) => b.status);
    ok('pipeline walked the expected stages', ['thinking', 'navigating', 'typing', 'analyzing', 'ranking', 'ready'].every((s) => statuses.includes(s)), statuses);
  }

  section('question intent → streamed answer');
  {
    // The builtin provider cannot stream; the run must fail GRACEFULLY.
    const started = await dispatch({ type: 'RUN_TASK', text: 'اگه ایرپاد ارزان‌تر بخرم چیا از دست می‌دم؟', store: 'digikala' });
    const result = await waitForBroadcast('SHOPAGENT_RESULT', (b) => b.taskId === started.taskId);
    ok('question run answers (even if it cannot stream)', result.result?.ok === true || result.result?.error === 'STREAM_UNSUPPORTED', result.result);
  }

  section('question intent → live token stream (patched provider)');
  {
    const llm = globalThis.ShopAgent.llm;
    const originalParse = llm.parseIntent;
    const originalStream = llm.streamChat;
    llm.parseIntent = async () => ({ ...llm.EMPTY_INTENT, intent: 'question', query: 'اگه ایرپاد ارزان‌تر بخرم؟', explanation: 'سؤال', source: 'ollama' });
    llm.streamChat = async (_settings, { onDelta }) => {
      for (const piece of ['سلام', ' خوب', ' باشی']) {
        onDelta?.(piece, undefined);
        await new Promise((r) => setTimeout(r, 5));
      }
      return { ok: true, text: 'سلام خوب باشی', provider: 'ollama', model: 'llama3.2' };
    };

    const before = broadcasts.length;
    const started = await dispatch({ type: 'RUN_TASK', text: 'اگه ایرپاد ارزان‌تر بخرم چیا از دست می‌دم؟', store: 'digikala' });
    const result = await waitForBroadcast('SHOPAGENT_RESULT', (b) => b.taskId === started.taskId);

    const deltas = broadcasts.slice(before).filter((b) => b.type === 'SHOPAGENT_STREAM' && b.kind === 'delta');
    const done = broadcasts.slice(before).find((b) => b.type === 'SHOPAGENT_STREAM' && b.kind === 'done');
    ok('tokens were streamed to the panel', deltas.length === 3, deltas.map((d) => d.text));
    ok('final stream message is complete', done?.text === 'سلام خوب باشی', done);
    ok('result is the streamed answer', result.result?.ok === true && result.result?.question === true && result.result?.answer === 'سلام خوب باشی', result.result);
    ok('no scraping happened for a question', !broadcasts.slice(before).some((b) => b.type === 'SHOPAGENT_PROGRESS' && b.status === 'analyzing'), null);

    llm.parseIntent = originalParse;
    llm.streamChat = originalStream;
  }

  section('content scripts register in manifest order');
  {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    const listenerBefore = messageListener;

    // Minimal page globals: the content scripts are classic page scripts.
    globalThis.window = globalThis;
    globalThis.self = globalThis;
    globalThis.location = { href: 'https://www.digikala.com/', hostname: 'www.digikala.com', pathname: '/', search: '' };
    const fakeEl = () => ({
      style: {},
      textContent: '',
      children: [],
      classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
      dataset: {},
      setAttribute: () => {},
      getAttribute: () => null,
      removeAttribute: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      appendChild: (c) => c,
      removeChild: (c) => c,
      contains: () => false,
      remove: () => {},
      querySelector: () => fakeEl(),
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
      closest: () => null,
      scrollIntoView: () => {},
      focus: () => {},
      click: () => {},
    });
    globalThis.document = {
      readyState: 'complete',
      location: globalThis.location,
      addEventListener: () => {},
      removeEventListener: () => {},
      documentElement: fakeEl(),
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: fakeEl,
      createTextNode: () => fakeEl(),
      body: fakeEl(),
      head: fakeEl(),
    };
    for (const file of manifest.content_scripts[0].js) {
      (0, eval)(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    }
    const SA = globalThis.ShopAgent;
    ok('content.js registered its message listener', typeof messageListener === 'function' && messageListener !== listenerBefore, typeof messageListener);
    ok('action modules attached to ShopAgent.actions', ['dom', 'interact', 'extract', 'hud'].every((k) => typeof SA.actions?.[k] === 'object'), Object.keys(SA.actions || {}));
    ok('adapter discovery is available in the page', typeof SA.adapters?.findBuyButton === 'function' && typeof SA.adapters?.detectInCart === 'function', null);
    ok('site registry is available in the page', typeof SA.sites?.detect === 'function', null);
    ok('action validator is available in the page', typeof SA.act?.validate === 'function', null);

    const ping = await dispatchToContent({ type: 'SHOPAGENT_PING' });
    ok('content listener answers PING', ping?.ok === true && ping.store === 'digikala', ping);

    // A compromised/outdated message must not be able to pay in-page.
    const blocked = await dispatchToContent({ type: 'SHOPAGENT_ACT', payload: { action: 'PAY', params: {} } });
    ok('content listener refuses blocked actions', blocked?.ok === false && blocked.error === 'ACTION_BLOCKED', blocked);
    const bogus = await dispatchToContent({ type: 'SHOPAGENT_ACT', payload: { action: 'NOPE_ACTION', params: {} } });
    ok('content listener rejects unknown actions', bogus?.ok === false && bogus.error === 'ACTION_INVALID', bogus);
  }

  console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
  if (failed) {
    console.log('\x1b[31mfailed:\x1b[0m\n - ' + failures.join('\n - '));
    process.exit(1);
  }
  console.log('\x1b[32mAll protocol integration tests passed.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error('\x1b[31mFATAL:\x1b[0m', err);
  process.exit(1);
});
