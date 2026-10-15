/**
 * ShopAgent — sidepanel/sidepanel.js
 * ------------------------------------------------------------------
 * The UI controller. It renders the conversation, drives the run
 * pipeline through the service worker, and owns the settings + compare
 * drawers.
 *
 * Security note: every string that comes from a web page (product title,
 * seller, URL) is inserted with `textContent` / `setAttribute`, never
 * with innerHTML, so scraped markup can never execute here.
 * ------------------------------------------------------------------
 */
(function () {
  'use strict';

  const SA = globalThis.ShopAgent;
  const { utils, i18n, store, llm, sites } = SA;
  const { t } = i18n;
  const log = utils.logger('ui');

  const $ = (sel, scope = document) => scope.querySelector(sel);
  const $$ = (sel, scope = document) => Array.from(scope.querySelectorAll(sel));

  /** Ordered pipeline shown in the live step timeline. */
  const PIPELINE = ['thinking', 'navigating', 'typing', 'scrolling', 'filtering', 'analyzing', 'ranking', 'ready'];

  const state = {
    settings: null,
    taskId: null,
    running: false,
    store: 'digikala',
    tabContext: null,
    lastResult: null,
    compare: new Map(), // id → product
    stepsEl: null,
    modelsCache: { ollama: null, groq: null, gemini: null },
    bannerTimer: null,
    streamText: '',
    streamBubble: null,
    expectChat: false,
  };

  /* ================================================================== *
   * Provider status banner (Ollama / Groq / Gemini health)
   * ================================================================== */

  async function refreshBanner() {
    const banner = $('#providerBanner');
    const text = $('#providerBannerText');
    if (!banner || !state.settings) return;
    const s = state.settings;
    const provider = s.provider || 'ollama';
    const lang = i18n.getLang();

    banner.dataset.state = 'checking';
    text.textContent = t('banner.checking');

    if (provider === 'builtin') {
      banner.dataset.state = 'ok';
      text.textContent = t('banner.ok.builtin');
      return;
    }

    // No key configured → say so without a doomed network round-trip.
    const needsKey = provider === 'groq' || provider === 'gemini';
    if (needsKey && !s[provider]?.apiKey) {
      banner.dataset.state = 'nokey';
      text.textContent = t('banner.nokey');
      return;
    }

    const res = await send('GET_PROVIDER_HEALTH', { settings: s });
    const r = res?.result || {};
    if (res.ok && r.ok) {
      banner.dataset.state = 'ok';
      text.textContent = t(`banner.ok.${provider}`, { ms: num(r.latencyMs ?? 0) });
      if (Array.isArray(r.models) && r.models.length) {
        state.modelsCache[provider] = r.models;
        fillModelList(provider, r.models);
      }
    } else {
      const reason = String(r.message || res?.error || 'unknown');
      banner.dataset.state = r.message === 'NO_KEY' ? 'nokey' : 'down';
      if (r.message === 'NO_KEY') {
        text.textContent = t('banner.nokey');
      } else {
        const downKey = t(`banner.down.${provider}`);
        text.textContent = downKey !== `banner.down.${provider}` ? downKey : SA.errors.friendly({ message: reason }, { lang, provider }).message;
      }
    }
  }

  function startBannerLoop() {
    clearInterval(state.bannerTimer);
    refreshBanner();
    state.bannerTimer = setInterval(refreshBanner, 45000);
  }

  /* ================================================================== *
   * Messaging bridge
   * ================================================================== */

  function send(type, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, ...(payload || {}) }, (res) => {
          if (chrome.runtime.lastError) {
            log.warn('sendMessage failed', type, chrome.runtime.lastError.message);
            return resolve({ ok: false, error: chrome.runtime.lastError.message });
          }
          resolve(res || { ok: false, error: 'NO_RESPONSE' });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e?.message || e) });
      }
    });
  }

  /* ================================================================== *
   * Theming & language
   * ================================================================== */

  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  function applyTheme(theme) {
    const resolved = theme === 'auto' ? (darkQuery.matches ? 'dark' : 'light') : theme;
    document.documentElement.dataset.theme = resolved;
    const btn = $('#btnTheme');
    if (btn) btn.innerHTML = `<svg><use href="#i-${resolved === 'dark' ? 'sun' : 'moon'}" /></svg>`;
  }

  function applyLang(lang) {
    i18n.setLang(lang);
    $('#langTag').textContent = lang === 'fa' ? 'FA' : 'EN';
    document.title = t('app.name') + ' — ShopAgent';
    $$('#langPicker button').forEach((b) => b.classList.toggle('on', b.dataset.lang === lang));
    renderChips();
    renderEngineStrip();
    renderCompare();
    if (state.settings) refreshBanner();
    if (state.lastResult) refreshWhyLanguage();
  }

  function cycleTheme() {
    const order = ['light', 'dark', 'auto'];
    const next = order[(order.indexOf(state.settings.theme) + 1) % order.length];
    state.settings.theme = next;
    applyTheme(next);
    $$('#themePicker button').forEach((b) => b.classList.toggle('on', b.dataset.themeValue === next));
    persist();
  }

  function toggleLang() {
    const next = i18n.getLang() === 'fa' ? 'en' : 'fa';
    state.settings.language = next;
    applyLang(next);
    persist();
  }

  /* ================================================================== *
   * Persistence
   * ================================================================== */

  let persistTimer = null;
  function persist(patch) {
    const next = patch ? { ...state.settings, ...patch } : state.settings;
    state.settings = next;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      store.saveSettings(next).catch((e) => log.warn('save failed', e));
    }, 180);
  }

  /* ================================================================== *
   * Toasts
   * ================================================================== */

  function toast(message, kind = 'ok', ms = 2400) {
    const host = $('#toasts');
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.innerHTML = `<use href="#i-${kind === 'err' ? 'alert' : 'check'}" />`;
    el.appendChild(icon);
    const span = document.createElement('span');
    span.textContent = message;
    el.appendChild(span);
    host.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 300);
    }, ms);
  }

  /* ================================================================== *
   * Human-in-the-Loop confirmation cards
   * ================================================================== */

  /**
   * The content script wants permission for a risky action (e.g. add to
   * cart). Render a chat-level card with explicit تایید/لغو buttons and
   * answer the worker; no timeout-expired request stays actionable.
   */
  function showConfirmCard(msg) {
    clearEmpty();
    const card = document.createElement('div');
    card.className = 'confirm-card';
    card.dataset.state = 'waiting';

    const head = document.createElement('div');
    head.className = 'confirm-head';
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.innerHTML = '<use href="#i-shield" />';
    const title = document.createElement('strong');
    title.textContent = t('confirm.title');
    head.append(icon, title);

    const body = document.createElement('div');
    body.className = 'confirm-body';
    const action = document.createElement('div');
    action.className = 'confirm-action';
    action.textContent = msg.title || '—';
    const detail = document.createElement('div');
    detail.className = 'confirm-detail';
    detail.textContent = msg.detail || '';
    body.append(action);
    if (msg.detail) body.appendChild(detail);
    if (msg.url) {
      const url = document.createElement('code');
      url.className = 'confirm-url';
      url.textContent = msg.url.slice(0, 90);
      body.appendChild(url);
    }

    const actions = document.createElement('div');
    actions.className = 'confirm-actions';
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'btn-confirm-ok';
    okBtn.textContent = t('confirm.approve');
    const noBtn = document.createElement('button');
    noBtn.type = 'button';
    noBtn.className = 'btn-confirm-no';
    noBtn.textContent = t('confirm.deny');
    actions.append(okBtn, noBtn);

    const settle = (approved) => {
      if (card.dataset.state !== 'waiting') return;
      card.dataset.state = approved ? 'approved' : 'denied';
      okBtn.disabled = true;
      noBtn.disabled = true;
      const note = document.createElement('div');
      note.className = 'confirm-note';
      note.textContent = approved ? t('confirm.approved') : t('confirm.denied');
      card.appendChild(note);
      send('SHOPAGENT_CONFIRM_RESPONSE', { requestId: msg.requestId, approved });
    };

    okBtn.addEventListener('click', () => settle(true));
    noBtn.addEventListener('click', () => settle(false));

    card.append(head, body, actions);
    $('#stream').appendChild(card);
    scrollToEnd();
  }

  /* ================================================================== *
   * Token streaming (live model output)
   * ================================================================== */

  function ensureStreamBubble() {
    if (state.streamBubble && document.body.contains(state.streamBubble)) return state.streamBubble;
    clearEmpty();
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-bot';
    const bubble = document.createElement('div');
    bubble.className = 'bubble bubble-streaming';
    bubble.textContent = state.streamText || '…';
    wrap.appendChild(bubble);
    $('#stream').appendChild(wrap);
    scrollToEnd();
    state.streamBubble = bubble;
    return bubble;
  }

  function handleStream(msg) {
    if (msg.taskId && state.taskId && msg.taskId !== state.taskId) return;
    state.streamText = msg.full || '';

    // First token latency — the whole point of streaming is seeing this fast.
    if (msg.firstTokenMs != null && !state._firstTokenShown) {
      state._firstTokenShown = true;
      updateStep('thinking', t('stream.firstToken', { ms: num(msg.firstTokenMs) }), 'active');
    }
    if (state.expectChat) {
      const bubble = ensureStreamBubble();
      bubble.textContent = state.streamText || '…';
      scrollToEnd(false);
    }
  }

  /* ================================================================== *
   * Stream rendering
   * ================================================================== */

  function clearEmpty() {
    $('#emptyState')?.remove();
  }

  function scrollToEnd(smooth = true) {
    const stream = $('#stream');
    stream.scrollTo({ top: stream.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  function addUserMessage(text) {
    clearEmpty();
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-user';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.textContent = new Date().toLocaleTimeString(i18n.getLang() === 'fa' ? 'fa-IR' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
    wrap.append(bubble, meta);
    $('#stream').appendChild(wrap);
    scrollToEnd();
    return wrap;
  }

  function addBotMessage(text, cls = '') {
    clearEmpty();
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-bot';
    const bubble = document.createElement('div');
    bubble.className = `bubble ${cls}`;
    bubble.textContent = text;
    wrap.appendChild(bubble);
    $('#stream').appendChild(wrap);
    scrollToEnd();
    return wrap;
  }

  function addAlert(text, kind = 'err', codeLine) {
    clearEmpty();
    const el = document.createElement('div');
    el.className = `alert ${kind === 'warn' ? 'warn' : ''}`;
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.innerHTML = `<use href="#i-alert" />`;
    const body = document.createElement('div');
    const p = document.createElement('div');
    p.textContent = text;
    body.appendChild(p);
    if (codeLine) {
      const code = document.createElement('code');
      code.textContent = codeLine;
      body.appendChild(code);
    }
    el.append(icon, body);
    $('#stream').appendChild(el);
    scrollToEnd();
    return el;
  }

  /* ---------- Step timeline ---------- */

  function createSteps() {
    clearEmpty();
    const box = document.createElement('div');
    box.className = 'steps';
    const h = document.createElement('div');
    h.className = 'steps-h';
    h.innerHTML = `<svg><use href="#i-spark" /></svg>`;
    const ht = document.createElement('span');
    ht.textContent = t('steps.title');
    h.appendChild(ht);
    box.appendChild(h);

    const list = document.createElement('div');
    list.className = 'steps-list';
    box.appendChild(list);
    $('#stream').appendChild(box);
    state.stepsEl = { box, list, map: new Map() };
    scrollToEnd();
    return state.stepsEl;
  }

  function updateStep(status, detail, kind = 'active') {
    if (!state.stepsEl) createSteps();
    const { list, map } = state.stepsEl;
    const idx = PIPELINE.indexOf(status);

    // Mark everything before the current stage as done.
    if (idx > 0) {
      PIPELINE.slice(0, idx).forEach((s) => {
        const row = map.get(s);
        if (row && row.dataset.state !== 'error') row.dataset.state = 'done';
      });
    }

    let row = map.get(status);
    if (!row) {
      row = document.createElement('div');
      row.className = 'step';
      const ico = document.createElement('span');
      ico.className = 'step-ico';
      const body = document.createElement('div');
      body.className = 'step-body';
      const strong = document.createElement('strong');
      strong.textContent = t(`status.${status}`);
      const span = document.createElement('span');
      body.append(strong, span);
      row.append(ico, body);
      list.appendChild(row);
      map.set(status, row);
    }

    row.dataset.state = kind;
    const span = row.querySelector('.step-body span');
    if (detail) span.textContent = detail;
    else if (!span.textContent) span.textContent = '';

    if (kind === 'done') row.querySelector('.step-ico').setAttribute('aria-hidden', 'true');
    scrollToEnd();
  }

  function finishSteps(kind = 'done') {
    if (!state.stepsEl) return;
    $$('.step', state.stepsEl.list).forEach((r) => {
      if (r.dataset.state === 'active') r.dataset.state = kind;
    });
    if (kind === 'done') PIPELINE.forEach((s) => state.stepsEl.map.get(s) && (state.stepsEl.map.get(s).dataset.state = 'done'));
  }

  /* ---------- Skeletons ---------- */

  function addSkeletons(n = 3) {
    const host = document.createElement('div');
    host.className = 'skeletons';
    host.style.display = 'flex';
    host.style.flexDirection = 'column';
    host.style.gap = '10px';
    for (let i = 0; i < n; i++) {
      const c = document.createElement('div');
      c.className = 'sk-card';
      c.innerHTML = `<div class="sk sk-img"></div><div class="sk-lines"><div class="sk sk-l1"></div><div class="sk sk-l2"></div><div class="sk sk-l3"></div></div>`;
      host.appendChild(c);
    }
    $('#stream').appendChild(host);
    scrollToEnd();
    return host;
  }

  /* ---------- Product cards ---------- */

  function safeImage(src) {
    if (!src) return null;
    try {
      const u = new URL(src);
      return ['http:', 'https:', 'data:'].includes(u.protocol) ? u.href : null;
    } catch {
      return null;
    }
  }

  function money(value) {
    return utils.formatMoney(value, { digits: i18n.getLang() === 'fa' ? 'fa' : 'en' });
  }

  function num(value) {
    return i18n.getLang() === 'fa' ? utils.toPersianDigits(value) : String(value);
  }

  function productCard(p, rank) {
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.id = p.id;
    card.dataset.top = String(rank);

    const rankEl = document.createElement('span');
    rankEl.className = 'card-rank';
    rankEl.textContent = num(rank);
    card.appendChild(rankEl);

    // Image
    const imgBox = document.createElement('div');
    imgBox.className = 'card-img';
    const src = safeImage(p.image);
    if (src && !src.startsWith('data:image/svg')) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.alt = '';
      img.src = src;
      img.addEventListener('error', () => {
        img.remove();
        imgBox.appendChild(fallbackIcon());
      });
      imgBox.appendChild(img);
    } else {
      imgBox.appendChild(fallbackIcon());
    }
    if (p.discount > 0) {
      const off = document.createElement('span');
      off.className = 'card-off';
      off.textContent = `${num(p.discount)}٪`;
      imgBox.appendChild(off);
    }
    card.appendChild(imgBox);

    // Body
    const main = document.createElement('div');
    main.className = 'card-main';

    const title = document.createElement('a');
    title.className = 'card-title';
    title.textContent = p.title;
    title.target = '_blank';
    title.rel = 'noopener noreferrer';
    if (p.url) {
      title.href = p.url;
      title.addEventListener('click', (e) => {
        e.preventDefault();
        send('OPEN_URL', { url: p.url });
      });
    } else {
      title.removeAttribute('href');
    }
    main.appendChild(title);

    // Facts
    const facts = document.createElement('div');
    facts.className = 'card-facts';
    if (p.rating) {
      const f = document.createElement('span');
      f.className = 'fact fact-rating';
      f.innerHTML = `<svg><use href="#i-star" /></svg>`;
      const s = document.createElement('span');
      s.textContent = `${num(Number(p.rating).toFixed(1))}${p.ratingCount ? ` (${num(p.ratingCount)})` : ''}`;
      f.appendChild(s);
      facts.appendChild(f);
    }
    if (p.seller) {
      const f = document.createElement('span');
      f.className = 'fact';
      f.textContent = p.seller.slice(0, 26);
      facts.appendChild(f);
    }
    if (p.storeLabel) {
      const f = document.createElement('span');
      f.className = 'fact';
      f.textContent = p.storeLabel;
      facts.appendChild(f);
    }
    if (facts.childElementCount) main.appendChild(facts);

    // Price
    const priceRow = document.createElement('div');
    priceRow.className = 'card-price';
    const now = document.createElement('span');
    now.className = 'price-now';
    now.textContent = money(p.price);
    priceRow.appendChild(now);
    if (p.originalPrice && p.originalPrice > p.price) {
      const was = document.createElement('span');
      was.className = 'price-was';
      was.textContent = money(p.originalPrice);
      priceRow.appendChild(was);
    }
    main.appendChild(priceRow);

    // Why
    const why = document.createElement('div');
    why.className = 'card-why';
    why.dataset.why = '1';
    why.textContent = p.why || (p.reasons || []).join(' · ');
    main.appendChild(why);

    // Score
    const score = document.createElement('div');
    score.className = 'card-score';
    const track = document.createElement('div');
    track.className = 'score-track';
    const bar = document.createElement('div');
    bar.className = 'score-bar';
    track.appendChild(bar);
    const scoreNum = document.createElement('span');
    scoreNum.className = 'score-num';
    scoreNum.title = t('results.score');
    scoreNum.textContent = `${num(p.score ?? 0)}/${num(100)}`;
    score.append(track, scoreNum);
    main.appendChild(score);
    requestAnimationFrame(() => {
      setTimeout(() => (bar.style.width = `${utils.clamp(p.score ?? 0, 0, 100)}%`), 60);
    });

    // Actions
    const actions = document.createElement('div');
    actions.className = 'card-actions';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'btn-tiny';
    openBtn.innerHTML = `<svg><use href="#i-external" /></svg>`;
    const openLabel = document.createElement('span');
    openLabel.textContent = t('results.open');
    openBtn.appendChild(openLabel);
    openBtn.disabled = !p.url;
    openBtn.addEventListener('click', () => p.url && send('OPEN_URL', { url: p.url }));
    actions.appendChild(openBtn);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn-tiny';
    copyBtn.innerHTML = `<svg><use href="#i-copy" /></svg>`;
    copyBtn.title = t('results.copy');
    copyBtn.disabled = !p.url;
    copyBtn.addEventListener('click', async () => {
      if (!p.url) return;
      try {
        await navigator.clipboard.writeText(p.url);
        toast(t('results.copied'), 'ok', 1600);
      } catch {
        toast('clipboard blocked', 'err', 1600);
      }
    });
    actions.appendChild(copyBtn);

    const cmpBtn = document.createElement('button');
    cmpBtn.type = 'button';
    cmpBtn.className = 'btn-tiny cmp-toggle';
    cmpBtn.innerHTML = `<svg><use href="#i-scales" /></svg>`;
    const cmpLabel = document.createElement('span');
    cmpLabel.textContent = t('results.compare');
    cmpBtn.appendChild(cmpLabel);
    cmpBtn.classList.toggle('on', state.compare.has(p.id));
    cmpBtn.addEventListener('click', () => {
      if (state.compare.has(p.id)) {
        state.compare.delete(p.id);
        cmpBtn.classList.remove('on');
      } else {
        if (state.compare.size >= 3) {
          toast(t('results.compareHint'), 'err', 2600);
          return;
        }
        state.compare.set(p.id, p);
        cmpBtn.classList.add('on');
      }
      renderCompare();
      if (state.compare.size >= 2) openDrawer('#drawerCompare');
    });
    actions.appendChild(cmpBtn);

    // Guarded add-to-cart (HITL: a confirmation card appears first).
    const cartBtn = document.createElement('button');
    cartBtn.type = 'button';
    cartBtn.className = 'btn-tiny';
    cartBtn.innerHTML = `<svg><use href="#i-cart" /></svg>`;
    const cartLabel = document.createElement('span');
    cartLabel.textContent = t('results.addToCart');
    cartBtn.appendChild(cartLabel);
    cartBtn.disabled = !p.url;
    cartBtn.addEventListener('click', async () => {
      cartBtn.disabled = true;
      toast(t('confirm.waiting'), 'ok', 2000);
      const res = await send('ADD_TO_CART', { url: p.url });
      cartBtn.disabled = false;
      const r = res?.result || {};
      const mapMsg = {
        ADDED: t('cart.added'),
        CLICKED_UNVERIFIED: t('cart.clickedUnverified'),
        DENIED_BY_USER: t('cart.denied'),
        NOT_PRODUCT_PAGE: t('cart.notProduct'),
        CART_BUTTON_NOT_FOUND: t('cart.notFound'),
        BLOCKED_ACTION: t('cart.blocked'),
      };
      const msg = mapMsg[r.reason] || t('cart.failed', { msg: r.error || r.detail || '?' });
      toast(msg, r.ok ? 'ok' : 'err', 3000);
    });
    actions.appendChild(cartBtn);

    main.appendChild(actions);
    card.appendChild(main);
    return card;
  }

  function fallbackIcon() {
    const el = document.createElement('span');
    el.className = 'img-fallback';
    el.innerHTML = `<svg><use href="#i-box" /></svg>`;
    return el;
  }

  function renderResults(result) {
    clearEmpty();
    const products = result.products || [];

    const head = document.createElement('div');
    head.className = 'results-h';
    const strong = document.createElement('strong');
    strong.textContent = products.length ? t('results.top') : t('results.noResult');
    head.appendChild(strong);
    const meta = document.createElement('span');
    const bits = [];
    if (result.allCount) bits.push(t('results.count', { n: num(result.allCount) }));
    if (result.meta?.durationMs) bits.push(`${(result.meta.durationMs / 1000).toFixed(1)}s`);
    if (result.meta?.engine) bits.push(result.meta.engine);
    meta.textContent = bits.join(' · ');
    head.appendChild(meta);
    $('#stream').appendChild(head);

    if (!products.length) {
      addAlert(t('results.noResult'), 'warn');
      return;
    }

    const host = document.createElement('div');
    host.className = 'results';
    host.style.display = 'flex';
    host.style.flexDirection = 'column';
    host.style.gap = '10px';
    products.forEach((p, i) => host.appendChild(productCard(p, i + 1)));
    $('#stream').appendChild(host);

    // Budget warning
    const intent = result.intent || {};
    if (intent.maxPrice) {
      const over = products.filter((p) => p.price > intent.maxPrice);
      if (over.length) {
        addAlert(
          i18n.getLang() === 'fa'
            ? `${num(over.length)} مورد بالاتر از سقف بودجه شما (${money(intent.maxPrice)}) هستند و فقط برای مقایسه نمایش داده شده‌اند.`
            : `${over.length} item(s) exceed your ${money(intent.maxPrice)} ceiling and are shown for comparison only.`,
          'warn'
        );
      }
    }

    // Relevance sanity check — never silently show unrelated products.
    const q = (intent && intent.query) || '';
    if (q && products.length) {
      const avg = products.reduce((a, p) => a + utils.similarity(p.title || '', q), 0) / products.length;
      log.debug('avg title/query similarity:', avg.toFixed(2));
      if (avg < 0.1) {
        addAlert(
          i18n.getLang() === 'fa'
            ? 'هشدار: عنوان این کالاها شباهت بسیار کمی به درخواست تو دارد. عبارت جستجو را دقیق‌تر بنویس (مثلاً نام کالا) یا فروشگاه را عوض کن.'
            : 'Warning: these titles barely match your query. Make the search phrase more specific (e.g. the product name) or switch store.',
          'warn'
        );
      }
    }
    scrollToEnd();
  }

  function refreshWhyLanguage() {
    // The "why" sentences are produced by the model in the run language;
    // re-rendering from the local scorer keeps them consistent after a switch.
    if (!state.lastResult?.products?.length) return;
    const lang = i18n.getLang();
    const cards = $$('.card');
    cards.forEach((card) => {
      const p = state.lastResult.products.find((x) => x.id === card.dataset.id);
      if (!p) return;
      const whyEl = card.querySelector('[data-why]');
      if (!whyEl) return;
      if (p.aiRanked && p.why) {
        whyEl.textContent = p.why;
      } else {
        const { reasons } = llm.localScore(p, state.lastResult.intent || {}, lang);
        whyEl.textContent = reasons.join(' · ') || whyEl.textContent;
      }
    });
  }

  /* ================================================================== *
   * Run control
   * ================================================================== */

  function setRunning(on) {
    state.running = on;
    $('#btnSend').classList.toggle('hidden', on);
    $('#btnSend').disabled = on;
    $('#btnStop').classList.toggle('hidden', !on);
    $('#command').disabled = false;
    document.body.classList.toggle('is-running', on);
  }

  async function run(text) {
    if (!text.trim() || state.running) return;
    addUserMessage(text.trim());
    createSteps();
    updateStep('thinking', i18n.getLang() === 'fa' ? 'دستورت رو تحلیل می‌کنم…' : 'Understanding your request…');
    setRunning(true);
    state.compare.clear();
    renderCompare();

    // Reset the live-streaming trackers for this run.
    state.streamText = '';
    state.streamBubble = null;
    state.expectChat = false;
    state._firstTokenShown = false;

    const res = await send('RUN_TASK', { text: text.trim(), store: state.store });
    if (!res.ok) {
      finishSteps('error');
      setRunning(false);
      addAlert(t('err.llm', { msg: res.error || 'unknown' }), 'err');
      return;
    }
    state.taskId = res.taskId;
    // The result arrives asynchronously via SHOPAGENT_RESULT.
  }

  async function stop() {
    if (!state.taskId) return;
    await send('STOP_TASK', { taskId: state.taskId, tabId: state.tabContext?.tab?.id });
    setRunning(false);
    finishSteps('error');
    addBotMessage(t('status.stopped'));
  }

  /* ================================================================== *
   * Engine strip
   * ================================================================== */

  function renderEngineStrip() {
    const s = state.settings;
    if (!s) return;
    const meta = llm.PROVIDER_META[s.provider] || {};
    const name =
      s.provider === 'ollama'
        ? 'Ollama'
        : s.provider === 'groq'
        ? 'Groq'
        : s.provider === 'gemini'
        ? 'Gemini'
        : t('conn.builtin');
    const model = s[s.provider]?.model || meta.defaultModel || '';
    $('#engineName').textContent = name;
    $('#engineModel').textContent = model;
    $('#engineDot').dataset.state = s.provider === 'builtin' ? 'local' : 'idle';
    $('#btnTestConn').textContent = t('settings.test');
  }

  async function testConnection({ fromButton = false } = {}) {
    const btn = $('#btnTestConn');
    const dot = $('#engineDot');
    btn.disabled = true;
    dot.dataset.state = 'busy';
    btn.textContent = t('conn.checking');

    const res = await send('TEST_CONNECTION', { settings: state.settings });
    const r = res.result || {};
    btn.disabled = false;

    if (res.ok && r.ok) {
      dot.dataset.state = r.provider === 'ollama' || r.provider === 'builtin' ? 'local' : 'ok';
      const msg = t('test.ok', { ms: num(r.latencyMs ?? 0) });
      btn.textContent = t('settings.test');
      if (fromButton) toast(msg, 'ok');
      if (Array.isArray(r.models) && r.models.length) {
        state.modelsCache[r.provider] = r.models;
        fillModelList(r.provider, r.models);
      }
      if (r.message && String(r.message).startsWith('MODEL_MISSING') && fromButton) {
        const missing = String(r.message).split(':')[1];
        addAlert(
          i18n.getLang() === 'fa'
            ? `مدل «${missing}» روی Ollama نصب نیست. در ترمینال بزن: ollama pull ${missing}`
            : `Model "${missing}" is not installed in Ollama. Run: ollama pull ${missing}`,
          'warn',
          `ollama pull ${missing}`
        );
      }
      return true;
    }

    dot.dataset.state = 'error';
    btn.textContent = t('settings.test');
    const reason = String(r.message || res.error || 'unknown');
    const friendly =
      r.provider === 'ollama'
        ? t('test.ollamaHint')
        : reason === 'NO_KEY'
        ? i18n.getLang() === 'fa'
          ? 'کلید API وارد نشده است.'
          : 'No API key configured.'
        : reason;
    if (fromButton) {
      toast(t('test.fail', { msg: reason }), 'err', 3600);
      showConnResult(false, friendly, reason);
    } else {
      log.info('silent connection check failed:', reason);
    }
    return false;
  }

  function showConnResult(ok, message, code) {
    const box = $('#connResult');
    box.hidden = false;
    box.className = `conn-result ${ok ? 'ok' : 'err'}`;
    box.textContent = '';
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.innerHTML = `<use href="#i-${ok ? 'check' : 'alert'}" />`;
    const body = document.createElement('div');
    const p = document.createElement('div');
    p.textContent = message;
    body.appendChild(p);
    if (code) {
      const c = document.createElement('code');
      c.textContent = code;
      body.appendChild(c);
    }
    box.append(icon, body);
  }

  function fillModelList(provider, models) {
    const dl = $(`#${provider}ModelList`);
    if (!dl) return;
    dl.textContent = '';
    models.slice(0, 60).forEach((m) => {
      const o = document.createElement('option');
      o.value = m;
      dl.appendChild(o);
    });
    const hint = $('#ollamaModelsHint');
    if (hint && provider === 'ollama') {
      hint.textContent = models.length
        ? `${t('settings.model.detected')}: ${models.slice(0, 6).join('، ')}${models.length > 6 ? ' …' : ''}`
        : '';
    }
  }

  /* ================================================================== *
   * Chips
   * ================================================================== */

  function renderChips() {
    const host = $('#chips');
    host.textContent = '';
    for (let i = 1; i <= 4; i++) {
      const key = `chip.${i}`;
      const label = t(key);
      if (label === key) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = label;
      b.addEventListener('click', () => {
        const ta = $('#command');
        ta.value = label;
        autoGrow(ta);
        ta.focus();
      });
      host.appendChild(b);
    }
  }

  /* ================================================================== *
   * Drawers
   * ================================================================== */

  function openDrawer(sel) {
    const d = $(sel);
    d.classList.add('open');
    d.setAttribute('aria-hidden', 'false');
    $('#scrim').hidden = false;
    requestAnimationFrame(() => $('#scrim').classList.add('on'));
    const focusable = d.querySelector('input:not([type=hidden]),button,select,textarea');
    setTimeout(() => focusable?.focus(), 260);
    d._escHandler = (e) => {
      if (e.key === 'Escape') closeDrawers();
    };
    document.addEventListener('keydown', d._escHandler);
  }

  function closeDrawers() {
    $$('.drawer').forEach((d) => {
      d.classList.remove('open');
      d.setAttribute('aria-hidden', 'true');
      if (d._escHandler) document.removeEventListener('keydown', d._escHandler);
    });
    $('#scrim').classList.remove('on');
    setTimeout(() => ($('#scrim').hidden = true), 280);
  }

  /* ================================================================== *
   * Compare
   * ================================================================== */

  function renderCompare() {
    const body = $('#compareBody');
    if (!body) return;
    $('#compareCount').textContent = state.compare.size ? `${num(state.compare.size)}/3` : '';
    body.textContent = '';

    const items = [...state.compare.values()];
    $$('.cmp-toggle').forEach((btn) => {
      const card = btn.closest('.card');
      if (card) btn.classList.toggle('on', state.compare.has(card.dataset.id));
    });

    if (items.length < 2) {
      const empty = document.createElement('div');
      empty.className = 'cmp-empty';
      empty.textContent = t('results.compareHint');
      body.appendChild(empty);
      return;
    }

    const scroll = document.createElement('div');
    scroll.className = 'compare-scroll';
    const table = document.createElement('table');
    table.className = 'compare-table';

    const rows = [
      { key: 'image', label: '' },
      { key: 'title', label: t('results.price') === '' ? '' : 'کالا' },
      { key: 'price', label: t('results.price') },
      { key: 'discount', label: t('results.discount') },
      { key: 'rating', label: t('results.rating') },
      { key: 'seller', label: t('results.seller') },
      { key: 'score', label: t('results.score') },
    ];

    const lowest = Math.min(...items.map((i) => Number(i.price) || Infinity));
    const bestRating = Math.max(...items.map((i) => Number(i.rating) || 0));
    const bestScore = Math.max(...items.map((i) => Number(i.score) || 0));

    for (const row of rows) {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.textContent = row.label;
      tr.appendChild(th);

      for (const p of items) {
        const td = document.createElement('td');
        switch (row.key) {
          case 'image': {
            const src = safeImage(p.image);
            if (src) {
              const img = document.createElement('img');
              img.className = 'cmp-img';
              img.src = src;
              img.alt = '';
              img.loading = 'lazy';
              td.appendChild(img);
            }
            break;
          }
          case 'title': {
            const s = document.createElement('span');
            s.className = 'cmp-title';
            s.textContent = p.title;
            td.appendChild(s);
            break;
          }
          case 'price': {
            td.textContent = money(p.price);
            if (Number(p.price) === lowest) td.classList.add('cmp-best');
            break;
          }
          case 'discount': {
            td.textContent = p.discount ? `${num(p.discount)}٪` : '—';
            break;
          }
          case 'rating': {
            td.textContent = p.rating ? num(Number(p.rating).toFixed(1)) : '—';
            if (Number(p.rating) === bestRating && p.rating) td.classList.add('cmp-best');
            break;
          }
          case 'seller': {
            td.textContent = p.seller || '—';
            break;
          }
          case 'score': {
            td.textContent = `${num(p.score ?? 0)}/100`;
            if (Number(p.score) === bestScore) td.classList.add('cmp-best');
            break;
          }
        }
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }

    // Action row
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    tr.appendChild(th);
    for (const p of items) {
      const td = document.createElement('td');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-tiny';
      btn.innerHTML = `<svg><use href="#i-external" /></svg>`;
      const lbl = document.createElement('span');
      lbl.textContent = t('results.open');
      btn.appendChild(lbl);
      btn.disabled = !p.url;
      btn.addEventListener('click', () => p.url && send('OPEN_URL', { url: p.url }));
      td.appendChild(btn);
      tr.appendChild(td);
    }
    table.appendChild(tr);

    scroll.appendChild(table);
    body.appendChild(scroll);
  }

  /* ================================================================== *
   * Settings form
   * ================================================================== */

  function hydrateSettings() {
    const s = state.settings;
    $$('input[name="provider"]').forEach((r) => (r.checked = r.value === s.provider));
    $$('.provider-fields').forEach((f) => f.classList.toggle('on', f.dataset.for === s.provider));

    $('#ollamaUrl').value = s.ollama.baseUrl;
    $('#ollamaModel').value = s.ollama.model;
    $('#groqKey').value = s.groq.apiKey || '';
    $('#groqModel').value = s.groq.model;
    $('#geminiKey').value = s.gemini.apiKey || '';
    $('#geminiModel').value = s.gemini.model;

    $('#temperature').value = s.temperature;
    $('#temperatureOut').textContent = s.temperature;
    $('#maxResults').value = s.maxResults;
    $('#typingSpeed').value = s.typingSpeed;
    $('#liveHud').checked = s.liveHud !== false;
    $('#autoScroll').checked = s.autoScroll !== false;
    $('#debugLogs').checked = Boolean(s.debugLogs);

    $$('#langPicker button').forEach((b) => b.classList.toggle('on', b.dataset.lang === s.language));
    $$('#themePicker button').forEach((b) => b.classList.toggle('on', b.dataset.themeValue === s.theme));

    // Static model suggestions as datalist fallbacks.
    for (const [p, meta] of Object.entries(llm.PROVIDER_META)) {
      if (!meta.suggestedModels) continue;
      fillModelList(p, state.modelsCache[p] || meta.suggestedModels);
    }

    $('#versionTag').textContent = `v${chrome.runtime.getManifest().version}`;
    $('#aboutNote').textContent =
      i18n.getLang() === 'fa'
        ? 'کلیدها و تنظیمات فقط در همین مرورگر ذخیره می‌شوند. هیچ داده‌ای به سرور شخص ثالث (به‌جز ارائه‌دهنده‌ای که خودت انتخاب کرده‌ای) ارسال نمی‌شود.'
        : 'Keys and settings stay in this browser only. Nothing is sent to any third party except the provider you selected.';

    utils.setLogLevel(s.debugLogs ? 'debug' : 'info');
  }

  function readSettingsForm() {
    const provider = $$('input[name="provider"]').find((r) => r.checked)?.value || 'ollama';
    return {
      provider,
      ollama: {
        baseUrl: $('#ollamaUrl').value.trim().replace(/\/+$/, '') || 'http://localhost:11434',
        model: $('#ollamaModel').value.trim() || 'llama3.2',
      },
      groq: { apiKey: $('#groqKey').value.trim(), model: $('#groqModel').value.trim() || 'llama-3.3-70b-versatile' },
      gemini: { apiKey: $('#geminiKey').value.trim(), model: $('#geminiModel').value.trim() || 'gemini-2.0-flash' },
      temperature: Number($('#temperature').value) || 0.2,
      maxResults: utils.clamp(parseInt($('#maxResults').value, 10) || 6, 1, 24),
      typingSpeed: $('#typingSpeed').value,
      liveHud: $('#liveHud').checked,
      autoScroll: $('#autoScroll').checked,
      debugLogs: $('#debugLogs').checked,
      language: i18n.getLang(),
      theme: state.settings.theme,
      preferredStore: state.store,
    };
  }

  async function saveSettingsForm() {
    const next = readSettingsForm();
    state.settings = await store.saveSettings(next);
    utils.setLogLevel(state.settings.debugLogs ? 'debug' : 'info');
    applyTheme(state.settings.theme);
    renderEngineStrip();
    refreshBanner();
    toast(t('settings.saved'), 'ok', 1700);
    log.debug('settings saved', store.redact(state.settings));
  }

  /* ================================================================== *
   * Events
   * ================================================================== */

  function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 132) + 'px';
  }

  function bindEvents() {
    // Header
    $('#btnTheme').addEventListener('click', cycleTheme);
    $('#btnLang').addEventListener('click', toggleLang);
    $('#btnSettings').addEventListener('click', () => {
      hydrateSettings();
      openDrawer('#drawerSettings');
    });
    $('#btnCloseSettings').addEventListener('click', closeDrawers);
    $('#btnCloseCompare').addEventListener('click', closeDrawers);
    $('#scrim').addEventListener('click', closeDrawers);

    // Engine
    $('#engineMain').addEventListener('click', () => {
      hydrateSettings();
      openDrawer('#drawerSettings');
    });
    $('#btnTestConn').addEventListener('click', () => testConnection({ fromButton: true }));
    $('#btnBannerRetry').addEventListener('click', refreshBanner);

    // Store picker
    $$('#storePicker button').forEach((b) => {
      b.addEventListener('click', () => {
        $$('#storePicker button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
        state.store = b.dataset.store;
        persist({ preferredStore: state.store });
      });
    });

    // Composer
    const ta = $('#command');
    ta.addEventListener('input', () => autoGrow(ta));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        $('#composerForm').requestSubmit();
      }
    });
    $('#composerForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const value = ta.value;
      ta.value = '';
      autoGrow(ta);
      run(value);
    });
    $('#btnStop').addEventListener('click', stop);

    $('#btnClear').addEventListener('click', () => {
      $('#stream').textContent = '';
      state.stepsEl = null;
      state.compare.clear();
      renderCompare();
      const empty = buildEmptyState();
      $('#stream').appendChild(empty);
    });

    // Settings form
    $$('input[name="provider"]').forEach((r) =>
      r.addEventListener('change', () => {
        $$('.provider-fields').forEach((f) => f.classList.toggle('on', f.dataset.for === r.value));
        $('#connResult').hidden = true;
      })
    );
    $('#temperature').addEventListener('input', (e) => ($('#temperatureOut').textContent = e.target.value));
    $$('#langPicker button').forEach((b) =>
      b.addEventListener('click', () => {
        applyLang(b.dataset.lang);
        hydrateSettings();
        persist({ language: b.dataset.lang });
      })
    );
    $$('#themePicker button').forEach((b) =>
      b.addEventListener('click', () => {
        $$('#themePicker button').forEach((x) => x.classList.toggle('on', x === b));
        state.settings.theme = b.dataset.themeValue;
        applyTheme(b.dataset.themeValue);
        persist({ theme: b.dataset.themeValue });
      })
    );
    $('#btnSaveSettings').addEventListener('click', async () => {
      await saveSettingsForm();
      closeDrawers();
    });
    $('#btnLoadOllamaModels').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      await saveSettingsForm();
      await testConnection({ fromButton: true });
      btn.disabled = false;
    });
    $('#btnGroqKey').addEventListener('click', () => window.open('https://console.groq.com/keys', '_blank', 'noopener'));
    $('#btnGeminiKey').addEventListener('click', () => window.open('https://aistudio.google.com/app/apikey', '_blank', 'noopener'));
    $('#btnDocs').addEventListener('click', () => send('OPEN_DOCS', {}));
    $('#btnReset').addEventListener('click', async () => {
      if (!window.confirm(t('settings.resetConfirm'))) return;
      await store.resetAll();
      state.settings = await store.getSettings();
      applyTheme(state.settings.theme);
      applyLang(state.settings.language);
      hydrateSettings();
      renderEngineStrip();
      toast(t('settings.saved'), 'ok');
    });

    // Auto-save on blur for text-ish fields (feels instant, no lost keys).
    ['#ollamaUrl', '#ollamaModel', '#groqKey', '#groqModel', '#geminiKey', '#geminiModel', '#maxResults'].forEach((sel) => {
      $(sel)?.addEventListener('change', () => {
        if ($('#drawerSettings').classList.contains('open')) saveSettingsForm();
      });
    });
    ['#liveHud', '#autoScroll', '#debugLogs'].forEach((sel) => {
      $(sel)?.addEventListener('change', () => {
        if ($('#drawerSettings').classList.contains('open')) saveSettingsForm();
      });
    });

    // Global keys
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        closeDrawers();
        $('#command').focus();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        hydrateSettings();
        openDrawer('#drawerSettings');
      }
    });

    darkQuery.addEventListener?.('change', () => {
      if (state.settings?.theme === 'auto') applyTheme('auto');
    });

    // Incoming messages from the service worker.
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || !msg.type) return;

      if (msg.type === 'SHOPAGENT_CONFIRM_SHOW') {
        showConfirmCard(msg);
        return;
      }

      if (msg.type === 'SHOPAGENT_STREAM') {
        handleStream(msg);
        return;
      }

      if (msg.type === 'SHOPAGENT_PROGRESS') {
        if (msg.taskId && state.taskId && msg.taskId !== state.taskId) return;
        const status = msg.status;
        const detail = msg.detail || '';
        if (msg.intent?.intent === 'question') state.expectChat = true;
        if (status === 'error') {
          finishSteps('error');
          updateStep(status, detail, 'error');
        } else if (status === 'ready') {
          updateStep(status, detail, 'done');
          finishSteps('done');
        } else if (status === 'stopped') {
          finishSteps('error');
        } else if (PIPELINE.includes(status)) {
          updateStep(status, detail, 'active');
          if (status === 'analyzing' || status === 'ranking') {
            if (!$('.skeletons')) addSkeletons(3);
          }
        } else {
          updateStep('analyzing', detail, 'active');
        }
        return;
      }

      if (msg.type === 'SHOPAGENT_RESULT') {
        $('.skeletons')?.remove();
        setRunning(false);
        const result = msg.result || {};

        // Streamed free-form answer (question intents).
        if (result.ok && result.chat) {
          finishSteps('done');
          const bubble = ensureStreamBubble();
          bubble.classList.remove('bubble-streaming');
          bubble.textContent = result.answer || state.streamText || '';
          scrollToEnd();
          return;
        }
        if (result.chat) {
          // Failed chat: surface the friendly Persian message.
          finishSteps('error');
          state.streamBubble?.classList.remove('bubble-streaming');
          addAlert(result.friendly?.message || result.error || t('err.llm', { msg: '?' }), 'err', result.error);
          return;
        }
        // The search stream was raw JSON — drop the bubble if one existed.
        state.streamBubble?.remove();
        state.streamBubble = null;

        if (!result.ok) {
          finishSteps('error');
          if (!result.aborted) {
            const map = {
              NO_SEARCH_PATH: t('err.unsupported'),
              NOT_ON_RESULTS_PAGE:
                i18n.getLang() === 'fa'
                  ? 'صفحهٔ نتایج جستجو تشخیص داده نشد. یک بار صفحهٔ فروشگاه را رفرش کن و دوباره امتحان کن.'
                  : 'The search-results page could not be detected. Reload the store page once and try again.',
              CONTENT_UNREACHABLE: t('err.inject'),
              NO_TAB: t('err.noTab'),
              EMPTY_QUERY: i18n.getLang() === 'fa' ? 'نتونستم بفهمم دنبال چه کالایی هستی. واضح‌تر بگو مثلاً «ایرپاد تا ۳ میلیون».' : 'I could not identify a product. Try something like "AirPods under 3M Tomans".',
              BLOCKED_ACTION: t('cart.blocked'),
            };
            const key = String(result.error || '').split(':')[0];
            // Prefer the pre-formatted Persian message from the worker.
            addAlert(result.friendly?.message || map[key] || result.error || t('err.llm', { msg: 'unknown' }), 'err', result.friendly?.code || result.error);
            // Provider died mid-run? Refresh the status banner immediately.
            if (['OLLAMA_DOWN', 'TIMEOUT', 'NETWORK', 'RATE_LIMIT', 'AUTH'].includes(result.friendly?.kind)) refreshBanner();
          }
          return;
        }
        state.lastResult = result;
        renderResults(result);
        return;
      }

      if (msg.type === 'SHOPAGENT_LIVE_EVENT') {
        const { event, data } = msg;
        if (event === 'typing' && data?.total) {
          const pct = Math.round((data.typed / data.total) * 100);
          if (pct % 20 === 0) updateStep('typing', `${num(pct)}٪`, 'active');
        }
        if (event === 'extracted') {
          updateStep('analyzing', i18n.getLang() === 'fa' ? `${num(data.count)} کالا خوانده شد` : `${data.count} products read`, 'active');
        }
        return;
      }

      if (msg.type === 'SHOPAGENT_SETTINGS_CHANGED') {
        // Another surface changed settings — resync without clobbering edits.
        if (!$('#drawerSettings').classList.contains('open')) {
          store.getSettings().then((s) => {
            state.settings = s;
            applyTheme(s.theme);
            renderEngineStrip();
          });
        }
        return;
      }
    });
  }

  function buildEmptyState() {
    const el = document.createElement('div');
    el.className = 'empty';
    el.id = 'emptyState';
    el.innerHTML = `
      <div class="empty-art" aria-hidden="true">
        <svg viewBox="0 0 120 96">
          <rect x="8" y="14" width="104" height="70" rx="12" class="ea-panel" />
          <rect x="20" y="26" width="46" height="7" rx="3.5" class="ea-line" />
          <rect x="20" y="40" width="80" height="5" rx="2.5" class="ea-line soft" />
          <rect x="20" y="51" width="64" height="5" rx="2.5" class="ea-line soft" />
          <rect x="20" y="64" width="30" height="9" rx="4.5" class="ea-pill" />
          <circle cx="94" cy="30" r="9" class="ea-spark" />
          <path d="M94 24.6l1.5 4 4 1.5-4 1.5-1.5 4-1.5-4-4-1.5 4-1.5z" class="ea-star" />
        </svg>
      </div>
      <h2 data-i18n="empty.title"></h2>
      <p data-i18n="empty.body"></p>
      <p class="empty-note" data-i18n="empty.note"></p>`;
    i18n.apply(el);
    return el;
  }

  /* ================================================================== *
   * Boot
   * ================================================================== */

  async function init() {
    state.settings = await store.getSettings();
    utils.setLogLevel(state.settings.debugLogs ? 'debug' : 'info');

    applyTheme(state.settings.theme);
    applyLang(state.settings.language || i18n.detectLang());
    i18n.apply(document);
    hydrateSettings();
    renderChips();
    renderCompare();
    renderEngineStrip();
    startBannerLoop();
    bindEvents();

    // Reflect the active tab in the store picker.
    const ctx = await send('GET_TAB_CONTEXT');
    if (ctx.ok) {
      state.tabContext = ctx;
      if (ctx.store?.supported) {
        state.store = 'current';
        $$('#storePicker button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.store === 'current')));
        const note = i18n.getLang() === 'fa' ? `تب فعال: ${ctx.store.label}` : `Active tab: ${ctx.store.label}`;
        log.info(note);
      } else {
        state.store = state.settings.preferredStore || 'digikala';
        $$('#storePicker button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.store === state.store)));
      }
    }

    // Restore the previous run so reopening the panel is not a blank slate.
    const last = await send('GET_LAST_RUN');
    if (last.ok && last.lastRun?.products?.length) {
      state.lastResult = last.lastRun;
      addBotMessage(i18n.getLang() === 'fa' ? 'نتایج آخرین جستجو:' : 'Results from your last search:');
      renderResults(last.lastRun);
    }

    // Silent health check so the engine dot is truthful on open.
    testConnection({ fromButton: false });

    $('#command').focus();
    log.info('side panel ready');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
