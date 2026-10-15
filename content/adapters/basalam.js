/**
 * ShopAgent — content/adapters/basalam.js
 * ------------------------------------------------------------------
 * DOM selectors & site-specific logic for Basalam (marketplace of
 * independent Iranian sellers). Same fallback-chain discipline as
 * digikala.js.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});
  const adapters = (ShopAgent.adapters = ShopAgent.adapters || {});
  adapters._pending = adapters._pending || [];

  adapters._pending.push({
    id: 'basalam',
    selectors: {
      searchInput: [
        'input[name="q"]',
        'input[data-testid="search-input"]',
        'input[type="search"]',
        'input[placeholder*="جستجو"]',
        'input[placeholder*="دنبال"]',
        'input[aria-label*="جستجو"]',
        'form[action*="search"] input',
        'header input',
      ],
      searchSubmit: [
        'form[action*="search"] button[type="submit"]',
        'button[data-testid*="search"]',
        'button[aria-label*="جستجو"]',
        'button[type="submit"]',
      ],
      productCard: [
        '[data-testid*="product-card"]',
        '[data-testid*="product"]',
        'article',
        'div[class*="product-card"]',
        'div[class*="productCard"]',
        'div[class*="product_card"]',
        'main div:has(> a[href*="/product/"])',
        'li:has(a[href*="/product/"])',
      ],
      productTitle: ['h2', 'h3', '[data-testid*="title"]', '[class*="title"]', 'a[href*="/product/"]'],
      productLink: ['a[data-testid*="product"]', 'a[href*="/product/"]', 'a[href]'],
      productPrice: ['[data-testid*="price"]', '[class*="price"]', '[class*="Price"]', '[class*="cost"]'],
      productImage: ['img[src]', 'img[data-src]'],
      productRating: ['[data-testid*="rating"]', '[class*="rating"]', '[class*="star"]'],
      productSeller: ['[data-testid*="vendor"]', '[class*="seller"]', '[class*="shop"]', 'a[href*="/vendor"]'],
      discountBadge: ['[data-testid*="discount"]', '[class*="discount"]', '[class*="off"]', '[class*="takhfif"]'],
      sortControl: ['select[data-testid*="sort"]', 'select', '[class*="sort"] button', '[class*="sort"]'],
      nextPage: ['a[rel="next"]', 'button[aria-label*="بعدی"]'],
      loadMore: ['button[class*="more"]'],
    },
    labels: {
      sort: {
        bestselling: ['پرفروش‌ترین', 'محبوب‌ترین', 'پرفروش'],
        cheapest: ['ارزان‌ترین', 'کمترین قیمت', 'ارزان'],
        expensive: ['گران‌ترین', 'بیشترین قیمت'],
        newest: ['جدیدترین', 'تازه‌ترین', 'جدید'],
        best_match: ['مرتبط‌ترین', 'بهترین', 'پیشنهادی'],
        discount: ['بیشترین تخفیف', 'تخفیف'],
      },
      priceFilterHeading: ['محدوده قیمت', 'قیمت'],
      apply: ['اعمال', 'ثبت', 'تایید'],
    },
    cartButtonTexts: ['افزودن به سبد خرید', 'افزودن به سبد', 'خرید'],
  });
})(globalThis);
