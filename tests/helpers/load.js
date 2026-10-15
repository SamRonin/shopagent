/**
 * tests/helpers/load.js — load ShopAgent IIFE modules into Node's global,
 * exactly like the browser/worker script tags and importScripts do.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function load(...relative) {
  for (const rel of relative) {
    const file = path.join(ROOT, rel);
    // indirect eval → global scope, attaches to globalThis.ShopAgent
    (0, eval)(fs.readFileSync(file, 'utf8'));
  }
  return globalThis.ShopAgent;
}

module.exports = { load, ROOT };
