/**
 * ShopAgent — background/core.js
 * ------------------------------------------------------------------
 * Task registry, progress broadcasting, toolbar badge, keep-alive and
 * the throttled token-stream relay. Everything the pipeline and the
 * router share lives here so no module reaches into another's state.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});
  const bg = (ShopAgent.bg = ShopAgent.bg || {});
  const log = ShopAgent.utils.logger('bg.core');

  /* ---------------- task registry ---------------- */

  const tasks = new Map(); // taskId → { id, status, abort, startedAt, steps }

  function newTask() {
    const id = ShopAgent.utils.uid('task');
    const abort = new AbortController();
    tasks.set(id, { id, status: 'idle', abort, startedAt: Date.now(), steps: [] });
    return id;
  }

  const getTask = (id) => tasks.get(id);

  function pruneTasks() {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [id, t] of tasks) if (t.startedAt < cutoff) tasks.delete(id);
  }

  /* ---------------- progress + badge ---------------- */

  const BADGE = {
    idle: { text: '', color: '#0f766e' },
    thinking: { text: '···', color: '#0ea5e9' },
    navigating: { text: '→', color: '#8b5cf6' },
    typing: { text: '⌨', color: '#38bdf8' },
    scrolling: { text: '⇕', color: '#a78bfa' },
    analyzing: { text: '◎', color: '#f59e0b' },
    filtering: { text: '⚙', color: '#ec4899' },
    ranking: { text: '★', color: '#22c55e' },
    cart: { text: '🛒', color: '#f97316' },
    ready: { text: '✓', color: '#16a34a' },
    error: { text: '!', color: '#ef4444' },
    stopped: { text: '■', color: '#64748b' },
  };

  function setBadge(status) {
    const b = BADGE[status] || BADGE.idle;
    try {
      chrome.action.setBadgeText({ text: b.text }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ color: b.color }).catch(() => {});
    } catch {}
  }

  /** Broadcast a progress event to every listening extension surface. */
  function emitProgress(taskId, status, detail, extra = {}) {
    const task = getTask(taskId);
    if (task) {
      task.status = status;
      task.steps.push({ status, detail, at: Date.now() });
      if (task.steps.length > 60) task.steps.shift();
    }
    chrome.runtime.sendMessage({ type: 'SHOPAGENT_PROGRESS', taskId, status, detail, at: Date.now(), ...extra }).catch(() => {});
    setBadge(status);
    log.info(`[${taskId}] ${status}${detail ? ` — ${detail}` : ''}`);
  }

  /* ---------------- keep-alive (MV3 worker lifetime) ---------------- */

  let keepAliveTimer = null;

  function startKeepAlive() {
    if (keepAliveTimer) return;
    keepAliveTimer = setInterval(() => {
      chrome.storage.local.get('__ka').catch(() => {});
      if (!tasks.size) stopKeepAlive();
    }, 20000);
    pruneTasks();
  }

  function stopKeepAlive() {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  }

  /* ---------------- throttled token-stream relay ---------------- */

  /**
   * Forward model tokens to the side panel (SHOPAGENT_STREAM) without
   * flooding it: ~8 updates/sec, payload bounded to the latest 700 chars.
   */
  function makeStreamRelay(taskId) {
    let last = 0;
    return (delta, info) => {
      const now = Date.now();
      if (now - last < 120 && !(info && info.firstTokenMs != null)) return;
      last = now;
      chrome.runtime
        .sendMessage({
          type: 'SHOPAGENT_STREAM',
          taskId,
          full: String(info?.full || delta || '').slice(-700),
          firstTokenMs: info?.firstTokenMs ?? null,
        })
        .catch(() => {});
    };
  }

  bg.core = { tasks, newTask, getTask, pruneTasks, emitProgress, setBadge, BADGE, startKeepAlive, stopKeepAlive, makeStreamRelay };
})(globalThis);
