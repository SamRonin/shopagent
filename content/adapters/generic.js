/**
 * ShopAgent — content/adapters/generic.js
 * ------------------------------------------------------------------
 * A neutral DOM adapter for stores we have never seen. Everything is
 * attribute/ARIA/text based so it degrades gracefully anywhere.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});
  const adapters = (ShopAgent.adapters = ShopAgent.adapters || {});
  adapters._pending = adapters._pending || [];

  adapters._pending.push({
    id: 'generic',
    selectors: {
      searchInput: [
        'input[type="search"]',
        'input[role="searchbox"]',
        'input[name="q"]',
        'input[name="query"]',
        'input[name="s"]',
        'input[placeholder*="search" i]',
        'input[placeholder*="جستجو"]',
        'input[aria-label*="search" i]',
      ],
      searchSubmit: ['form button[type="submit"]', 'button[aria-label*="search" i]', 'button[type="submit"]'],
      productCard: ['article', '[data-testid*="product" i]', 'li[class*="product" i]', 'div[class*="product-card" i]', 'div[class*="productCard"]'],
      productTitle: ['h1', 'h2', 'h3', '[class*="title" i]'],
      productLink: ['a[href]'],
      productPrice: ['[data-testid*="price" i]', '[class*="price" i]'],
      productImage: ['img[src]', 'img[data-src]'],
      productRating: ['[class*="rating" i]', '[class*="star" i]'],
      productSeller: ['[class*="seller" i]', '[class*="shop" i]'],
      discountBadge: ['[class*="discount" i]', '[class*="off" i]'],
      sortControl: ['select'],
      nextPage: ['a[rel="next"]'],
      loadMore: [],
    },
    labels: {
      sort: { bestselling: ['پرفروش'], cheapest: ['ارزان'], expensive: ['گران'], newest: ['جدید'], best_match: ['مرتبط'], discount: ['تخفیف'] },
      priceFilterHeading: ['قیمت'],
      apply: ['اعمال', 'apply'],
    },
    cartButtonTexts: ['add to cart', 'افزودن به سبد'],
  });
})(globalThis);
