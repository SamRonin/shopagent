/**
 * tests/guardrails.test.js — risk classification (shared/guardrails.js)
 * + Persian error mapping (shared/errors.js).
 * Run: node --test tests/
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers/load');

const SA = load('shared/utils.js', 'shared/guardrails.js', 'shared/errors.js');
const { assessTarget, assessUrl, isProductUrl } = SA.guardrails;
const { classify, friendly, KINDS } = SA.errors;

test('payment / checkout targets are hard-blocked', () => {
  assert.equal(assessTarget({ text: 'تایید و پرداخت' }).risk, 'blocked');
  assert.equal(assessTarget({ text: 'ثبت نهایی سفارش' }).risk, 'blocked');
  assert.equal(assessTarget({ ariaLabel: 'Place order' }).risk, 'blocked');
});

test('blocked by destination URL even when the text looks innocent', () => {
  assert.equal(assessTarget({ text: 'ادامه', href: 'https://www.digikala.com/checkout/cart/' }).risk, 'blocked');
  assert.equal(assessTarget({ text: 'حساب کاربری', href: 'https://x.com/login' }).risk, 'blocked');
});

test('address / login / OTP are blocked', () => {
  assert.equal(assessTarget({ text: 'ثبت آدرس' }).risk, 'blocked');
  assert.equal(assessTarget({ text: 'ورود به حساب کاربری' }).risk, 'blocked');
  assert.equal(assessTarget({ text: 'کد تایید پیامک‌شده' }).risk, 'blocked');
});

test('cart actions require explicit confirmation', () => {
  assert.equal(assessTarget({ text: 'افزودن به سبد خرید' }).risk, 'confirm');
  assert.equal(assessTarget({ text: 'خرید نقدی' }).risk, 'confirm');
  assert.equal(assessTarget({ testId: 'add-to-cart' }).risk, 'confirm');
});

test('navigation / search / sort are safe', () => {
  assert.equal(assessTarget({ text: 'جستجو' }).risk, 'safe');
  assert.equal(assessTarget({ text: 'ارزان‌ترین' }).risk, 'safe');
  assert.equal(assessTarget({ text: 'صفحه بعد' }).risk, 'safe');
});

test('URL risk assessment', () => {
  assert.equal(assessUrl('https://www.digikala.com/checkout/').risk, 'blocked');
  assert.equal(assessUrl('https://basalam.com/product/abc').risk, 'safe');
  assert.equal(assessUrl('').risk, 'blocked'); // unknown = never navigate blind
});

test('product-url heuristic', () => {
  assert.equal(isProductUrl('https://www.digikala.com/product/dkp-12345/نام/'), true);
  assert.equal(isProductUrl('https://basalam.com/p/abc'), true);
  assert.equal(isProductUrl('https://basalam.com/search?q=کفش'), false);
});

test('error classification', () => {
  assert.equal(classify(new Error('TypeError: Failed to fetch'), { provider: 'ollama' }), KINDS.OLLAMA_DOWN);
  assert.equal(classify(new Error('request TIMEOUT')), KINDS.TIMEOUT);
  assert.equal(classify(new Error('nope'), { status: 401 }), KINDS.AUTH);
  assert.equal(classify(new Error('quota exceeded'), { status: 429 }), KINDS.RATE_LIMIT);
  assert.equal(classify(new Error('weird stuff')), KINDS.UNKNOWN);
});

test('friendly messages are Persian and actionable', () => {
  const f = friendly(new Error('TypeError: Failed to fetch'), { lang: 'fa', provider: 'ollama' });
  assert.equal(f.kind, KINDS.OLLAMA_DOWN);
  assert.ok(f.message.includes('ollama serve'));
  const en = friendly(new Error('TIMEOUT'), { lang: 'en' });
  assert.ok(en.message.length > 10);
});
