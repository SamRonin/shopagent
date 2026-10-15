/**
 * ShopAgent — background.js (MV3 service worker)
 * ------------------------------------------------------------------
 * Thin composition root. It wires the modules together:
 *
 *   background/core.js       tasks, progress, badge, keep-alive, stream relay
 *   background/tabs.js       tab lifecycle + the results-page hard gate
 *   background/pipeline.js   the intent→…→rank pipeline, chat, add-to-cart
 *   background/providers/*   Ollama / Groq / Gemini (uniform interface)
 *
 * What stays here: the confirm (HITL) relay and the message router.
 * Loaded as a classic worker; modules come in via importScripts.
 * ------------------------------------------------------------------
 */

importScripts(
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
  'background/providers/ollama.js',
  'background/providers/groq.js',
  'background/providers/gemini.js',
  'background/providers/index.js',
  'shared/llm.js',
  'background/core.js',
  'background/tabs.js',
  'background/pipeline.js'
);

const SA = globalThis.ShopAgent;
const bg = SA.bg;
const log = SA.utils.logger('background');

/* ================================================================== *
 * Human-in-the-Loop confirmation relay (content ⇄ background ⇄ panel)
 * ================================================================== */

const pendingConfirms = new Map(); // requestId → resolve

function relayConfirm(msg) {
  const requestId = msg.requestId || SA.utils.uid('cf');
  return new Promise((resolve) => {
    pendingConfirms.set(requestId, resolve);
    // 90 s of silence counts as a "no" — never leave the page hanging.
    setTimeout(() => {
      if (pendingConfirms.has(requestId)) {
        pendingConfirms.delete(requestId);
        resolve({ approved: false, timeout: true });
      }
    }, 90000);
    chrome.runtime
      .sendMessage({
        type: 'SHOPAGENT_CONFIRM_SHOW',
        requestId,
        title: msg.title || '',
        detail: msg.detail || '',
        risk: msg.risk || 'confirm',
        url: msg.url || '',
        matched: msg.matched || '',
      })
      .catch(() => {
        pendingConfirms.delete(requestId);
        resolve({ approved: false, reason: 'NO_PANEL' });
      });
  });
}

function resolveConfirm(msg) {
  const resolve = pendingConfirms.get(msg.requestId);
  if (resolve) {
    pendingConfirms.delete(msg.requestId);
    resolve({ approved: Boolean(msg.approved) });
  }
}

/* ================================================================== *
 * Message routing
 * ================================================================== */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;

  // Content scripts relay their own live events straight to the UI.
  if (msg.type === 'SHOPAGENT_EVENT') {
    chrome.runtime.sendMessage({ type: 'SHOPAGENT_LIVE_EVENT', ...msg, tabId: sender.tab?.id }).catch(() => {});
    return false;
  }

  // HITL: content asked the user to approve an action.
  if (msg.type === 'SHOPAGENT_CONFIRM_REQUEST') {
    relayConfirm(msg).then(sendResponse);
    return true; // async
  }

  (async () => {
    try {
      switch (msg.type) {
        case 'GET_SETTINGS':
          sendResponse({ ok: true, settings: await SA.store.getSettings() });
          break;

        case 'SAVE_SETTINGS':
          sendResponse({ ok: true, settings: await SA.store.saveSettings(msg.settings || {}) });
          break;

        case 'RESET_SETTINGS':
          await SA.store.resetAll();
          sendResponse({ ok: true, settings: await SA.store.getSettings() });
          break;

        case 'GET_HISTORY':
          sendResponse({ ok: true, history: await SA.store.getHistory(20) });
          break;

        case 'CLEAR_HISTORY':
          await SA.store.clearHistory();
          sendResponse({ ok: true });
          break;

        case 'TEST_CONNECTION':
        case 'LIST_MODELS': {
          const settings = msg.settings || (await SA.store.getSettings());
          const result = await SA.llm.testConnection(settings);
          sendResponse({ ok: result.ok, result });
          break;
        }

        /** Fast health probe for the side-panel status banner. */
        case 'GET_PROVIDER_HEALTH': {
          const settings = msg.settings || (await SA.store.getSettings());
          const result = await SA.providers.health(settings.provider || 'ollama', settings);
          sendResponse({ ok: true, result });
          break;
        }

        case 'PARSE_LOCAL': {
          // Instant, offline preview of what the rule-based parser sees.
          const settings = await SA.store.getSettings();
          sendResponse({ ok: true, intent: SA.llm.builtinParseIntent(msg.text || '', settings) });
          break;
        }

        case 'GET_TAB_CONTEXT': {
          const tab = await bg.tabs.activeTab();
          const supported = bg.tabs.isSupported(tab?.url || '');
          const storeMeta = SA.sites.list().find((s) => s.id === (tab ? SA.sites.detect(tab.url).id : null)) || null;
          sendResponse({
            ok: true,
            tab: tab ? { id: tab.id, url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl, status: tab.status } : null,
            store: storeMeta ? { id: storeMeta.id, label: storeMeta.label, supported } : null,
            stores: SA.sites.list(),
          });
          break;
        }

        case 'RUN_TASK': {
          const settings = await SA.store.getSettings();
          const taskId = bg.core.newTask();
          sendResponse({ ok: true, taskId });
          // Fire and forget — progress arrives via SHOPAGENT_PROGRESS.
          bg.pipeline
            .runTask(taskId, {
              text: msg.text,
              store: msg.store || settings.preferredStore,
              tabId: msg.tabId,
              settings,
            })
            .then((result) => {
              chrome.runtime.sendMessage({ type: 'SHOPAGENT_RESULT', taskId, result }).catch(() => {});
            });
          break;
        }

        case 'STOP_TASK': {
          const task = bg.core.getTask(msg.taskId) || [...bg.core.tasks.values()].pop();
          if (task) {
            task.abort.abort(new Error('STOPPED'));
            if (msg.tabId) await bg.tabs.sendToContent(msg.tabId, 'STOP').catch(() => {});
          }
          sendResponse({ ok: true });
          break;
        }

        case 'GET_LAST_RUN': {
          const res = await chrome.storage.local.get('lastRun').catch(() => ({}));
          sendResponse({ ok: true, lastRun: res.lastRun || null });
          break;
        }

        case 'OPEN_URL': {
          if (msg.tabId) await chrome.tabs.update(msg.tabId, { url: msg.url, active: true }).catch(() => {});
          else await chrome.tabs.create({ url: msg.url, active: msg.active !== false });
          sendResponse({ ok: true });
          break;
        }

        case 'ADD_TO_CART': {
          const result = await bg.pipeline.runAddToCart({ url: msg.url, tabId: msg.tabId });
          if (result?.ok) bg.core.setBadge('cart');
          sendResponse({ ok: Boolean(result?.ok), result: result || { ok: false, error: 'UNKNOWN' } });
          break;
        }

        case 'SHOPAGENT_CONFIRM_RESPONSE':
          resolveConfirm(msg);
          sendResponse({ ok: true });
          break;

        case 'OPEN_DOCS':
          await chrome.tabs.create({ url: msg.url || 'https://github.com/SamRonin/shopagent#ollama--راه‌اندازی-مدل-لوکال' });
          sendResponse({ ok: true });
          break;

        case 'SHOPAGENT_SETTINGS_CHANGED':
          // Emitted by shared/storage.js whenever another surface saves.
          log.debug('settings changed elsewhere');
          sendResponse({ ok: true });
          break;

        default:
          sendResponse({ ok: false, error: `UNKNOWN:${msg.type}` });
      }
    } catch (err) {
      log.error('router error', msg?.type, err);
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();

  return true; // async response
});

/* ================================================================== *
 * Lifecycle
 * ================================================================== */

chrome.runtime.onInstalled.addListener(async (details) => {
  log.info('installed', details.reason);
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (e) {
    log.debug('sidePanel behaviour not available', e?.message);
  }
  const settings = await SA.store.getSettings();
  if (!settings.ollama?.baseUrl) await SA.store.saveSettings({ ollama: { baseUrl: 'http://localhost:11434' } });
  bg.core.setBadge('idle');
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {}
});

// Make the toolbar icon open the side panel (belt & braces with the above).
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (e) {
    log.debug('sidePanel.open failed', e?.message);
  }
});

// NOTE: no `webNavigation` listener on purpose. The declarative
// `content_scripts` entry in manifest.json covers every store navigation,
// and ensureContent() re-injects programmatically whenever a PING fails.
// This keeps the permission set minimal: activeTab, scripting, storage,
// sidePanel, tabs.

bg.core.setBadge('idle');
log.info('service worker booted');
