#!/usr/bin/env node
/**
 * validate.js — cross-file consistency checks (no browser needed).
 *
 *   1. manifest.json references files that actually exist
 *   2. every <script>/<link>/font path in the HTML & CSS exists on disk
 *   3. every data-i18n* key in sidepanel.html exists in shared/locales.js
 *      for BOTH languages
 *   4. every $('#id') used by sidepanel.js exists in sidepanel.html
 *   5. every t('key') used by JS exists in both locales
 *   6. message-type contract (background ⇄ panel ⇄ content)
 *   7. every JS file compiles (syntax guard) + utils destructures cover
 *      bare calls in every content module
 *
 * Usage: node scripts/validate.js   → exit 0 when clean
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

let problems = 0;
const bad = (msg) => {
  problems++;
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
};
const good = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);

/* ---------------------------------------------------------------- 1 */
console.log('\n\x1b[36m▸ manifest file references\x1b[0m');
const manifest = JSON.parse(read('manifest.json'));
const manifestFiles = [
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  ...(manifest.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])]),
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
].filter(Boolean);
for (const f of [...new Set(manifestFiles)]) {
  exists(f) ? good(f) : bad(`missing file referenced by manifest: ${f}`);
}
if (manifest.default_locale) {
  for (const loc of ['fa', 'en']) {
    const p = `_locales/${loc}/messages.json`;
    if (!exists(p)) bad(`missing locale: ${p}`);
    else {
      const msgs = JSON.parse(read(p));
      for (const key of Object.keys(msgs)) {
        if (!/^[a-zA-Z0-9_]+$/.test(key)) bad(`bad message name in ${p}: ${key}`);
      }
      const used = JSON.stringify(manifest).match(/__MSG_([a-zA-Z0-9_]+)__/g) || [];
      for (const u of [...new Set(used)]) {
        const name = u.replace(/__MSG_|__/g, '');
        if (!msgs[name]) bad(`${p} missing message: ${name}`);
      }
      good(`${p} covers manifest strings`);
    }
  }
}

/* ---------------------------------------------------------------- 2 */
console.log('\n\x1b[36m▸ html / css asset paths\x1b[0m');
const html = read('sidepanel.html');
for (const m of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
  const p = m[1];
  if (/^https?:/.test(p)) continue;
  exists(p) ? good(p) : bad(`missing asset in sidepanel.html: ${p}`);
}
const css = read('sidepanel/sidepanel.css');
for (const m of css.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)) {
  const raw = m[1];
  if (/^data:|^https?:/.test(raw)) continue;
  const resolved = path.posix.normalize(path.posix.join('sidepanel', raw));
  exists(resolved) ? good(resolved) : bad(`missing asset in sidepanel.css: ${raw} → ${resolved}`);
}

/* ---------------------------------------------------------------- 3 */
console.log('\n\x1b[36m▸ i18n keys used in HTML exist in both locales\x1b[0m');
(0, eval)(read('shared/utils.js'));
(0, eval)(read('shared/locales.js'));
const FA = globalThis.ShopAgent.LOCALES.fa;
const EN = globalThis.ShopAgent.LOCALES.en;
const faSet = new Set(Object.keys(FA));
const enSet = new Set(Object.keys(EN));

const parity = [...faSet].filter((k) => !enSet.has(k)).concat([...enSet].filter((k) => !faSet.has(k)));
parity.length ? bad(`locale key parity: ${parity.join(', ')}`) : good(`fa/en have identical keys (${faSet.size})`);

const htmlKeys = new Set();
for (const m of html.matchAll(/data-i18n(?:-placeholder|-title|-aria)?="([^"]+)"/g)) htmlKeys.add(m[1]);
const missingHtml = [...htmlKeys].filter((k) => !faSet.has(k) || !enSet.has(k));
missingHtml.length ? bad(`HTML uses undefined keys: ${missingHtml.join(', ')}`) : good(`all ${htmlKeys.size} HTML i18n keys defined`);

/* ---------------------------------------------------------------- 4 */
console.log('\n\x1b[36m▸ ids referenced by sidepanel.js exist in the HTML\x1b[0m');
const js = read('sidepanel/sidepanel.js');
const idRefs = new Set();
for (const m of js.matchAll(/\$\(\s*'#([A-Za-z0-9_-]+)'\s*[,)]/g)) idRefs.add(m[1]);
for (const m of js.matchAll(/\$\(\s*`#\$\{([A-Za-z0-9_]+)\}ModelList`/g)) idRefs.add(`${'ollama'}ModelList`);
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const missingIds = [...idRefs].filter((id) => !htmlIds.has(id));
missingIds.length ? bad(`JS references missing ids: ${missingIds.join(', ')}`) : good(`all ${idRefs.size} id references resolve`);

/* ---------------------------------------------------------------- 5 */
console.log('\n\x1b[36m▸ t() keys used in JS exist in both locales\x1b[0m');
const tKeys = new Set();
for (const m of js.matchAll(/\bt\(\s*'([^']+)'/g)) tKeys.add(m[1]);
for (const m of js.matchAll(/t\(\s*`([^`$]+)`/g)) tKeys.add(m[1]);
const statusDynamic = ['idle', 'thinking', 'navigating', 'typing', 'scrolling', 'analyzing', 'filtering', 'ranking', 'ready', 'error', 'connecting', 'stopped'];
for (const s of statusDynamic) tKeys.add(`status.${s}`);
const missingT = [...tKeys].filter((k) => !k.includes('${') && (!faSet.has(k) || !enSet.has(k)));
missingT.length ? bad(`JS uses undefined t() keys: ${missingT.join(', ')}`) : good(`all ${tKeys.size} t() keys defined`);

/* ---------------------------------------------------------------- 6 */
console.log('\n\x1b[36m▸ message-type contract (background ⇄ panel ⇄ content)\x1b[0m');
const BG_FILES = ['background.js', ...fs.readdirSync(path.join(ROOT, 'background')).filter((f) => f.endsWith('.js')).map((f) => `background/${f}`)];
const bgSources = BG_FILES.map(read).join('\n');
const panelSends = new Set([...js.matchAll(/send\(\s*'([A-Z_]+)'/g)].map((m) => m[1]));
const bgCases = new Set([...bgSources.matchAll(/case\s+'([A-Z_]+)'/g)].map((m) => m[1]));
const bgExplicit = new Set([...bgSources.matchAll(/msg\.type === '([A-Z_]+)'/g)].map((m) => m[1]));
const unhandled = [...panelSends].filter(
  (t) => !bgCases.has(t) && !bgExplicit.has(t) && !['SHOPAGENT_PROGRESS', 'SHOPAGENT_RESULT', 'SHOPAGENT_LIVE_EVENT', 'SHOPAGENT_STREAM', 'SHOPAGENT_CONFIRM_SHOW'].includes(t)
);
unhandled.length ? bad(`panel sends types with no background case: ${unhandled.join(', ')}`) : good(`all ${panelSends.size} panel→background types handled`);

const contentSrc = read('content/content.js');
const contentActions = new Set([...contentSrc.matchAll(/^\s{4}([A-Z_]+):\s*async/gm)].map((m) => m[1]));
const bgToContent = new Set([...bgSources.matchAll(/sendToContent\(\s*[^,]+,\s*'([A-Z_]+)'/g)].map((m) => m[1]));
const missingContent = [...bgToContent].filter((a) => !contentActions.has(a));
missingContent.length ? bad(`background calls missing content actions: ${missingContent.join(', ')}`) : good(`all ${bgToContent.size} background→content actions exist`);

/* ---------------------------------------------------------------- 7 */
console.log('\n\x1b[36m▸ every JS file compiles + utils destructures cover bare calls\x1b[0m');

const SKIP_DIRS = new Set(['node_modules', '.git', 'docs']);
const JS_FILES = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full);
    } else if (entry.name.endsWith('.js')) {
      JS_FILES.push(path.relative(ROOT, full));
    }
  }
})(ROOT);

let compileErrors = 0;
for (const rel of JS_FILES) {
  try {
    // Strip shebangs (legal for Node CLI, illegal inside new Function).
    const code = read(rel).replace(/^#![^\n]*/, '');
    // eslint-disable-next-line no-new-func
    new Function(code);
  } catch (e) {
    compileErrors++;
    bad(`syntax error in ${rel}: ${e.message}`);
  }
}
compileErrors === 0 ? good(`all ${JS_FILES.length} JS files compile`) : null;

// Wherever a module destructures utils, every bare call must be covered.
let destructureChecks = 0;
const destructureFailures = [];
for (const rel of JS_FILES) {
  if (!rel.startsWith('content/')) continue;
  const src = read(rel);
  const block = src.match(/const \{([\s\S]*?)\}\s*=\s*(?:SA\.)?utils;/);
  if (!block) continue;
  destructureChecks++;
  // Capture both `name = fallback` and shorthand `{ name }` bindings.
  const destructured = new Set([...block[1].matchAll(/([A-Za-z0-9_$]+)(?:\s*=)?\s*,?/g)].map((x) => x[1]));
  const body = src.slice(block.index + block[0].length);
  // Every *bare* utils export used in the file must be destructured.
  (0, eval)(read('shared/utils.js'));
  const utilsExports = Object.keys(globalThis.ShopAgent.utils);
  const uncovered = utilsExports.filter((k) => new RegExp(`(?<![.\\w])${k}\\s*\\(`).test(body) && !destructured.has(k));
  if (uncovered.length) {
    destructureFailures.push(`${rel}: ${uncovered.join(', ')}`);
    bad(`${rel} uses utils exports that are not destructured: ${uncovered.join(', ')}  (→ ReferenceError at runtime)`);
  }
}
destructureFailures.length === 0 && destructureChecks > 0 ? good(`${destructureChecks} content module destructure blocks verified`) : null;

/* ---------------------------------------------------------------- */
console.log(`\n\x1b[1m${problems ? `\x1b[31m${problems} problem(s)\x1b[0m` : '\x1b[32mAll cross-file checks passed.\x1b[0m'}\x1b[0m`);
process.exit(problems ? 1 : 0);
