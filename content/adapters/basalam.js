/**
 * ShopAgent — content/adapters/basalam.js
 * ------------------------------------------------------------------
 * Basalam adapter: ordered selector candidates + Persian UI labels.
 *
 * Same contract as digikala.js — ordered, never-authoritative lists;
 * the tiered discovery in content/adapters/index.js covers the misses.
 *
 * Loaded as a classic script AFTER shared/sites.js.
 * ------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const ShopAgent = (root.ShopAgent = root.ShopAgent || {});
  const { register } = ShopAgent.sites;

  register({
    id: 'basalam',
    nameKey: 'store.basalam',
    label: 'باسلام',
    labelEn: 'Basalam',
    hosts: ['basalam.com', 'www.basalam.com'],
    home: 'https://basalam.com/',
    searchUrl: (q) => [
      `https://basalam.com/search?q=${encodeURIComponent(q)}`,
      `https://basalam.com/fa/search?q=${encodeURIComponent(q)}`,
      `https://basalam.com/products?q=${encodeURIComponent(q)}`,
    ],
    productLinkRe: /\/(product|p|vendor\/[^/]+\/product)\//i,
    categoryLinkRe: /\/(product|search|category|shop)\//i,
    selectors: {
      searchInput: [
        'input[name="q"]',
        'input[type="search"]',
        'input[placeholder*="جستجو"]',
        'input[placeholder*="دنبال"]',
        'input[aria-label*="جستجو"]',
        'form[action*="search"] input',
        'header input',
      ],
      searchSubmit: ['form[action*="search"] button[type="submit"]', 'button[aria-label*="جستجو"]', 'button[type="submit"]'],
      productCard: [
        '[data-testid*="product"]',
        'article',
        'div[class*="product-card"]',
        'div[class*="productCard"]',
        'div[class*="product_card"]',
        'main div:has(> a[href*="/product/"])',
        'li:has(a[href*="/product/"])',
      ],
      productTitle: ['h2', 'h3', '[class*="title"]', 'a[href*="/product/"]'],
      productLink: ['a[href*="/product/"]', 'a[href]'],
      productPrice: ['[class*="price"]', '[class*="Price"]', '[class*="cost"]'],
      productImage: ['img[src]', 'img[data-src]'],
      productRating: ['[class*="rating"]', '[class*="star"]'],
      productSeller: ['[class*="seller"]', '[class*="shop"]', 'a[href*="/shop"]'],
      discountBadge: ['[class*="discount"]', '[class*="off"]', '[class*="takhfif"]'],
      sortControl: ['select', '[class*="sort"] button', '[class*="sort"]'],
      nextPage: ['a[rel="next"]', 'button[aria-label*="بعدی"]'],
      loadMore: ['button[class*="more"]'],
      /* Product-page buy box (tier-1 only). */
      addToCart: [
        '[data-testid*="add-to-cart"]',
        'button[aria-label*="سبد"]',
        'div[class*="product-action"] button',
        'div[class*="buy"] button',
      ],
    },
    labels: {
      sort: {
        bestselling: ['پرفروش‌ترین', 'محبوب‌ترین', 'پرفروش'],
        cheapest: ['ارزان‌ترین', 'کمترین قیمت', 'ارزان'],
        expensive: ['گران‌ترین', 'بیشترین قیمت'],
        newest: ['جدید‌ترین', 'تازه‌ترین', 'جدید'],
        best_match: ['مرتبط‌ترین', 'بهترین', 'پیشنهادی'],
        discount: ['بیشترین تخفیف', 'تخفیف'],
      },
      priceFilterHeading: ['محدوده قیمت', 'قیمت'],
      apply: ['اعمال', 'ثبت', 'تایید'],
      addToCart: ['افزودن به سبد خرید', 'افزودن به سبد', 'خرید نقدی', 'اضافه به سبد'],
      inCart: ['در سبد خرید', 'به سبد اضافه شد', 'سبد خرید', 'مشاهده سبد'],
    },
  });
})(globalThis);
