/**
 * ShopAgent — shared/storage.js
 * ------------------------------------------------------------------
 * Single source of truth for persisted settings. Keys that may hold a
 * secret (API keys) live in `chrome.storage.local`; UI preferences live
 * in `chrome.storage.sync` so they follow the user across devices.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});

  /** Provider identifiers understood by shared/llm.js */
  const PROVIDERS = {
    OLLAMA: 'ollama',
    GROQ: 'groq',
    GEMINI: 'gemini',
    BUILTIN: 'builtin',
  };

  const DEFAULT_SETTINGS = {
    provider: PROVIDERS.OLLAMA,
    ollama: {
      baseUrl: 'http://localhost:11434',
      model: 'llama3.2',
      keepAlive: '10m',
    },
    groq: {
      model: 'llama-3.3-70b-versatile',
      apiKey: '',
    },
    gemini: {
      model: 'gemini-2.0-flash',
      apiKey: '',
    },
    temperature: 0.2,
    maxResults: 6,
    language: 'fa',
    theme: 'auto',
    typingSpeed: 'normal', // slow | normal | fast
    liveHud: true,
    autoScroll: true,
    debugLogs: false,
    preferredStore: 'digikala', // digikala | basalam | current
    sound: false,
  };

  /** Fields mirrored into chrome.storage.local (never synced). */
  const SECRET_KEYS = ['groq.apiKey', 'gemini.apiKey'];

  const SYNC_KEY = 'settings';
  const LOCAL_KEY = 'settings_local';
  const HISTORY_KEY = 'history';

  const storageAvailable =
    typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

  const memory = new Map();

  function getPath(obj, path) {
    return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
  }
  function setPath(obj, path, value) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
    return obj;
  }

  /** Deep-merge `patch` onto `base` without mutating either. */
  function deepMerge(base, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
    const out = { ...base };
    for (const [k, v] of Object.entries(patch)) {
      out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base?.[k] ?? {}, v) : v;
    }
    return out;
  }

  /** Read the full settings object (sync + local secrets merged). */
  async function getSettings() {
    if (!storageAvailable) {
      return memory.get(SYNC_KEY) ? deepMerge(DEFAULT_SETTINGS, memory.get(SYNC_KEY)) : { ...DEFAULT_SETTINGS };
    }
    const [synced, local] = await Promise.all([
      chrome.storage.sync.get(SYNC_KEY).catch(() => ({})),
      chrome.storage.local.get(LOCAL_KEY).catch(() => ({})),
    ]);
    const merged = deepMerge(DEFAULT_SETTINGS, synced[SYNC_KEY] || {});
    const secrets = local[LOCAL_KEY] || {};
    for (const path of SECRET_KEYS) {
      const v = getPath(secrets, path);
      if (v !== undefined) setPath(merged, path, v);
    }
    return merged;
  }

  /**
   * Persist settings. Secrets are split out into local storage and are
   * masked in the returned object so they can safely be logged.
   */
  async function saveSettings(next) {
    const current = await getSettings();
    const merged = deepMerge(current, next || {});

    const secrets = {};
    for (const path of SECRET_KEYS) secrets[path] = getPath(merged, path) ?? '';

    // Build a sync-safe copy (strip secrets before they reach sync).
    const publicCopy = deepMerge({}, merged);
    for (const path of SECRET_KEYS) setPath(publicCopy, path, '');

    if (!storageAvailable) {
      memory.set(SYNC_KEY, publicCopy);
      memory.set(LOCAL_KEY, secrets);
      return merged;
    }

    await Promise.all([
      chrome.storage.sync.set({ [SYNC_KEY]: publicCopy }).catch(async () => {
        // Sync can be unavailable (quota / no profile) → fall back to local.
        await chrome.storage.local.set({ [SYNC_KEY]: publicCopy }).catch(() => {});
      }),
      chrome.storage.local.set({ [LOCAL_KEY]: secrets }),
    ]);

    broadcast(merged);
    return merged;
  }

  /** Redacted copy safe for logging / messaging. */
  function redact(settings) {
    const copy = deepMerge({}, settings);
    for (const path of SECRET_KEYS) {
      const v = getPath(copy, path);
      setPath(copy, path, v ? `${'*'.repeat(6)}${String(v).slice(-4)}` : '');
    }
    return copy;
  }

  async function getHistory(limit = 30) {
    if (!storageAvailable) return memory.get(HISTORY_KEY) || [];
    const res = await chrome.storage.local.get(HISTORY_KEY).catch(() => ({}));
    const list = res[HISTORY_KEY] || [];
    return limit ? list.slice(-limit) : list;
  }

  async function pushHistory(entry) {
    const list = await getHistory(0);
    list.push({ id: ShopAgent.utils.uid('h'), at: Date.now(), ...entry });
    const trimmed = list.slice(-60);
    if (storageAvailable) await chrome.storage.local.set({ [HISTORY_KEY]: trimmed }).catch(() => {});
    else memory.set(HISTORY_KEY, trimmed);
    return trimmed;
  }

  async function clearHistory() {
    if (storageAvailable) await chrome.storage.local.remove(HISTORY_KEY).catch(() => {});
    else memory.delete(HISTORY_KEY);
  }

  async function resetAll() {
    if (storageAvailable) {
      await Promise.all([
        chrome.storage.sync.remove(SYNC_KEY).catch(() => {}),
        chrome.storage.local.remove([LOCAL_KEY, HISTORY_KEY, 'modelCache']).catch(() => {}),
      ]);
    } else {
      memory.clear();
    }
    broadcast({ ...DEFAULT_SETTINGS });
  }

  /** Notify every live context (side panel + service worker) of changes. */
  function broadcast(settings) {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime
        .sendMessage({ type: 'SHOPAGENT_SETTINGS_CHANGED', settings: redact(settings) })
        .catch(() => {});
    }
  }

  /** Observe settings changes (used by the side panel to stay in sync). */
  function onChange(cb) {
    if (!storageAvailable) return () => {};
    const handler = (changes, area) => {
      if (area === 'sync' && changes[SYNC_KEY]) getSettings().then(cb);
      if (area === 'local' && (changes[LOCAL_KEY] || changes[SYNC_KEY])) getSettings().then(cb);
    };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }

  ShopAgent.store = {
    DEFAULT_SETTINGS,
    PROVIDERS,
    getSettings,
    saveSettings,
    redact,
    getHistory,
    pushHistory,
    clearHistory,
    resetAll,
    onChange,
    deepMerge,
  };
})(globalThis);
