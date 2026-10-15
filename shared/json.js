/**
 * ShopAgent — shared/json.js
 * ------------------------------------------------------------------
 * Robust JSON recovery for LLM output.
 *
 * Small local models (and occasionally the cloud ones) return JSON that
 * is *almost* right: fenced in markdown, wrapped in prose, single-quoted,
 * with trailing commas, Python literals or unquoted keys. JSON.parse
 * rejects all of those, so we run a cascade of increasingly aggressive —
 * but still string-aware — repair passes before giving up.
 *
 * Everything here is pure and synchronous: it runs identically in the
 * service worker, the content script and Node (tests).
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});

  /* ------------------------------------------------------------------ *
   * 1. Character-level normalisation
   * ------------------------------------------------------------------ */

  /** Smart quotes / guillemets → straight quotes (outside JSON semantics). */
  function unifyQuotes(s) {
    return s
      .replace(/[\u201C\u201D\u201E\u201F\u00AB\u00BB\u2039\u203A]/g, '"')
      .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'");
  }

  /**
   * Strip // line comments and /* block comments *​/ that live OUTSIDE of
   * strings. A tiny state machine — never touches string contents.
   */
  function stripComments(s) {
    let out = '';
    let inStr = false;
    let quote = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        out += ch;
        if (ch === '\\') {
          out += s[i + 1] || '';
          i++;
        } else if (ch === quote) {
          inStr = false;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        inStr = true;
        quote = ch;
        out += ch;
        continue;
      }
      if (ch === '/' && s[i + 1] === '/') {
        while (i < s.length && s[i] !== '\n') i++;
        continue;
      }
      if (ch === '/' && s[i + 1] === '*') {
        i += 2;
        while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
        i++;
        continue;
      }
      out += ch;
    }
    return out;
  }

  /** Python / JS literal fixes that JSON cannot express. */
  function unifyLiterals(s) {
    return s
      .replace(/\bNone\b/g, 'null')
      .replace(/\bTrue\b/g, 'true')
      .replace(/\bFalse\b/g, 'false')
      .replace(/\bNaN\b/g, 'null')
      .replace(/\b-?Infinity\b/g, 'null')
      .replace(/\bundefined\b/g, 'null');
  }

  /**
   * Quote bare object keys:  {intent: "search"} → {"intent": "search"}.
   * Only fires for keys that are not already quoted (string-aware).
   */
  function quoteKeys(s) {
    return s.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3');
  }

  /** Remove trailing commas:  [1,2,] / {"a":1,}  (string-aware). */
  function stripTrailingCommas(s) {
    let out = '';
    let inStr = false;
    let quote = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        out += ch;
        if (ch === '\\') {
          out += s[i + 1] || '';
          i++;
        } else if (ch === quote) {
          inStr = false;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        inStr = true;
        quote = ch;
        out += ch;
        continue;
      }
      if (ch === ',') {
        // Peek past whitespace for a closing bracket.
        let j = i + 1;
        while (j < s.length && /\s/.test(s[j])) j++;
        if (s[j] === '}' || s[j] === ']') continue;
      }
      out += ch;
    }
    return out;
  }

  /** Single-quoted strings → double-quoted (string boundary aware). */
  function singleToDoubleQuotes(s) {
    let out = '';
    let inDbl = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"') {
        inDbl = !inDbl;
        out += ch;
        continue;
      }
      // A single quote outside a double-quoted span starts a single-quoted
      // string: re-emit it double-quoted, escaping any inner double quotes.
      if (ch === "'" && !inDbl) {
        const end = s.indexOf("'", i + 1);
        if (end === -1) {
          out += ch; // unbalanced — leave as-is
          continue;
        }
        const body = s.slice(i + 1, end).replace(/"/g, '\\"');
        out += `"${body}"`;
        i = end;
        continue;
      }
      out += ch;
    }
    return out;
  }

  /**
   * Full repair pipeline (idempotent-ish, ordered mild → aggressive).
   * @param {string} text raw model output
   * @returns {string} repaired text
   */
  function repairJson(text) {
    let s = String(text ?? '');
    s = s.replace(/^\uFEFF/, '');
    s = unifyQuotes(s);
    s = stripComments(s);
    s = unifyLiterals(s);
    s = stripTrailingCommas(s);
    s = quoteKeys(s);
    s = singleToDoubleQuotes(s);
    return s.trim();
  }

  /* ------------------------------------------------------------------ *
   * 2. Extraction — pull the first balanced JSON value out of prose
   * ------------------------------------------------------------------ */

  /**
   * Find the first balanced {...} or [...] span, honouring strings/escapes.
   * @returns {string|null}
   */
  function extractJsonSpan(text) {
    const opens = ['{', '['];
    for (const open of opens) {
      const start = text.indexOf(open);
      if (start === -1) continue;
      const close = open === '{' ? '}' : ']';
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === open) depth++;
        else if (ch === close) {
          depth--;
          if (depth === 0) return text.slice(start, i + 1);
        }
      }
    }
    return null;
  }

  /** Pull ```fenced``` blocks (```json or bare). */
  function extractFence(text) {
    const m = text.match(/```(?:json|JavaScript|js)?\s*([\s\S]*?)```/i);
    return m ? m[1].trim() : null;
  }

  /* ------------------------------------------------------------------ *
   * 3. safeJsonParse — the public entry point
   * ------------------------------------------------------------------ */

  /**
   * Best-effort JSON parse of arbitrary model output.
   * Cascade: direct parse → fenced block → balanced span → repaired
   * variants of each. Returns null only when nothing salvageable exists.
   *
   * @param {string} text
   * @returns {*|null}
   */
  function safeJsonParse(text) {
    if (text == null) return null;
    if (typeof text === 'object') return text; // already parsed upstream
    const raw = String(text);

    // 1. Direct parse of the raw / fenced / balanced candidates.
    for (const candidate of [raw, extractFence(raw), extractJsonSpan(raw)]) {
      if (!candidate) continue;
      try {
        return JSON.parse(candidate);
      } catch {}
    }

    // 2. Repair pipeline on the whole text, then on the extracted span.
    const repaired = repairJson(raw);
    for (const candidate of [repaired, extractFence(repaired), extractJsonSpan(repaired)]) {
      if (!candidate) continue;
      try {
        return JSON.parse(candidate);
      } catch {}
    }

    // 3. Last resort: repair the *span* taken from the repaired text
    //    (handles prose + broken JSON interleaved together).
    const span = extractJsonSpan(repaired);
    if (span) {
      try {
        return JSON.parse(repairJson(span));
      } catch {}
    }
    return null;
  }

  ShopAgent.json = { repairJson, unifyQuotes, stripComments, stripTrailingCommas, quoteKeys, extractJsonSpan, extractFence, safeJsonParse };
  // Back-compat: llm.safeJsonParse re-exports this.
})(globalThis);
