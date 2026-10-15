/**
 * ShopAgent — content/adapters/digikala.js
 * ------------------------------------------------------------------
 * DOM selectors & site-specific logic for Digikala.
 *
 * Order matters: semantic/data-testid selectors first (stable across
 * redesigns), obfuscated class-name patterns last (they break on every
 * build). Every list is a *fallback chain* — see content/actions/dom.js.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});
  const adapters = (ShopAgent.adapters = ShopAgent.adapters || {});
  adapters._pending = adapters._pending || [];

  adapters._pending.push({
    id: 'digikala',
    selectors: {
      searchInput: [
        'input[type="search"][name="q"]',
        '#search-input',
        'input[data-testid="search-input"]',
        'input[name="q"]',
        'input[placeholder*="جستجو"]',
        'input[aria-label*="جستجو"]',
        'form[action*="/search"] input',
        'header input[type="search"]',
        'input[type="search"]',
      ],
      searchSubmit: [
        'button[data-testid="search-submit"]',
        'form[action*="/search"] button[type="submit"]',
        'button[aria-label*="جستجو"]',
        'button[type="submit"]',
      ],
      productCard: [
        '[data-testid="product-card"]',
        '[data-testid="productCard"]',
        'div.product-card',
        'div[class*="productCard"]',
        'ul.product-list > li',
        'main li:has(a[href*="/product/"])',
        'div:has(> a[href*="/product/"])',
      ],
      productTitle: [
        '[data-testid="product-title"]',
        '[data-testid="productTitle"]',
        'h2',
        'h3',
        '[class*="title"]',
        'a[href*="/product/"]',
      ],
      productLink: ['a[data-testid*="product"]', 'a[href*="/product/"]', 'a[href]'],
      productPrice: [
        '[data-testid="price"]',
        '[data-testid="price-current"]',
        '[class*="price"]',
        '[class*="Price"]',
      ],
      productImage: ['img[src]', 'img[data-src]', 'picture img'],
      productRating: ['[data-testid*="rating"]', '[class*="rating"]', '[class*="Rating"]'],
      productSeller: ['[data-testid*="seller"]', '[class*="seller"]', '[class*="Seller"]'],
      discountBadge: ['[data-testid*="discount"]', '[class*="discount"]', '[class*="Discount"]', '[class*="off"]'],
      sortControl: ['select[data-testid*="sort"]', 'select[class*="sort"]', '[class*="sort"] button', '[data-testid*="sort"]'],
      nextPage: ['a[rel="next"]', 'button[aria-label*="بعدی"]', 'a[class*="next"]'],
      loadMore: ['button[class*="more"]'],
    },
    labels: {
      sort: {
        bestselling: ['پرفروش‌ترین', 'پرفروش ترین', 'محبوب‌ترین'],
        cheapest: ['ارزان‌ترین', 'ارزان ترین', 'کمترین قیمت'],
        expensive: ['گران‌ترین', 'بیشترین قیمت'],
        newest: ['جدیدترین', 'تازه‌ترین'],
        best_match: ['مرتبط‌ترین', 'بهترین تطابق', 'مرتبط ترین'],
        discount: ['بیشترین تخفیف'],
      },
      priceFilterHeading: ['محدوده قیمت', 'قیمت', 'بازه قیمت'],
      apply: ['اعمال', 'ثبت', 'تایید', 'اعمال فیلتر'],
    },
    /** Persian texts used to find the cart button on product pages. */
    cartButtonTexts: ['افزودن به سبد خرید', 'افزودن به سبد', 'اضافه کردن به سبد', 'خرید نقدی'],
  });
})(globalThis);
