/**
 * ShopAgent — content/adapters/digikala.js
 * ------------------------------------------------------------------
 * Digikala adapter: ordered selector candidates + Persian UI labels.
 *
 * Nothing here is authoritative. Every list is tried top-to-bottom and
 * the generic engine in shared/sites.js (plus the tiered button
 * discovery in content/adapters/index.js) covers the misses. Add new
 * candidates at the TOP of a list, never replace one that still works.
 *
 * Loaded as a classic script AFTER shared/sites.js.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});
  const { register } = ShopAgent.sites;

  register({
    id: 'digikala',
    nameKey: 'store.digikala',
    label: 'دیجی‌کالا',
    labelEn: 'Digikala',
    hosts: ['www.digikala.com', 'digikala.com', 'm.digikala.com'],
    home: 'https://www.digikala.com/',
    /** Tried in order; the first reachable template wins. */
    searchUrl: (q) => [
      `https://www.digikala.com/search/?q=${encodeURIComponent(q)}`,
      `https://www.digikala.com/search?q=${encodeURIComponent(q)}`,
    ],
    productLinkRe: /\/(product|dp)\/(dkp-|\d)/i,
    categoryLinkRe: /\/(product|search|category|list)\//i,
    selectors: {
      searchInput: [
        'input[type="search"][name="q"]',
        '#search-input-digitalkala',
        'input#search-input',
        'input[placeholder*="جستجو"]',
        'input[aria-label*="جستجو"]',
        'form[action*="/search"] input[type="text"]',
        'form[action*="/search"] input[type="search"]',
        'header input[type="search"]',
        'input[type="search"]',
      ],
      searchSubmit: [
        'form[action*="/search"] button[type="submit"]',
        'button[aria-label*="جستجو"]',
        'button[type="submit"]',
      ],
      productCard: [
        '[data-testid="productCard"]',
        '[data-testid="product-card"]',
        'div.product-card',
        'div[class*="productCard"]',
        'ul.product-list > li',
        'div[class*="product-list"] > div',
        'div[class*="ProductList"] > div',
        'main li:has(a[href*="/product/"])',
        'div:has(> a[href*="/product/"])',
      ],
      productTitle: [
        '[data-testid="productTitle"]',
        'h2',
        'h3',
        'span[class*="title"]',
        'div[class*="title"]',
        'a[href*="/product/"]',
      ],
      productLink: ['a[href*="/product/"]', 'a[data-testid*="product"]', 'a[href]'],
      productPrice: [
        '[data-testid="price"]',
        'div[class*="price"]',
        'span[class*="price"]',
        'div[class*="Price"]',
      ],
      productImage: ['img[src]', 'img[data-src]', 'picture img'],
      productRating: ['[class*="rating"]', '[class*="Rating"]', '[data-testid*="rating"]'],
      productSeller: ['[class*="seller"]', '[class*="Seller"]'],
      discountBadge: ['[class*="discount"]', '[class*="Discount"]', '[class*="off"]'],
      sortControl: ['select[class*="sort"]', '[class*="sort"] button', '[data-testid*="sort"]'],
      nextPage: ['a[rel="next"]', 'button[aria-label*="بعدی"]', 'a[class*="next"]'],
      loadMore: ['button[class*="more"]', 'button:has(span)'],
      /* Product-page buy box. Tier-1 candidates only — the tiered
       * discovery in adapters/index.js adds the resilient fallbacks. */
      addToCart: [
        '[data-testid="add-to-cart"]',
        '[data-testid="buyBox"] button',
        'button[aria-label*="سبد خرید"]',
        'div[class*="buy-box"] button',
        'div[class*="BuyBox"] button',
      ],
    },
    /** Persian UI labels used by the click-by-text strategy. */
    labels: {
      sort: {
        bestselling: ['پرفروش‌ترین', 'پرفروش ترین', 'محبوب‌ترین'],
        cheapest: ['ارزان‌ترین', 'ارزان ترین', 'کمترین قیمت'],
        expensive: ['گران‌ترین', 'بیشترین قیمت'],
        newest: ['جدید‌ترین', 'جدیدترین', 'تازه‌ترین'],
        best_match: ['مرتبط‌ترین', 'بهترین تطابق', 'مرتبط ترین'],
        discount: ['بیشترین تخفیف'],
      },
      priceFilterHeading: ['محدوده قیمت', 'قیمت', 'بازه قیمت'],
      apply: ['اعمال', 'ثبت', 'تایید', 'اعمال فیلتر'],
      addToCart: ['افزودن به سبد خرید', 'افزودن به سبد', 'اضافه به سبد خرید', 'خرید نقدی'],
      inCart: ['در سبد خرید', 'به سبد اضافه شد', 'سبد خرید', 'مشاهده سبد'],
    },
  });
})(globalThis);
