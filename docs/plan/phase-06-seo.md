## Фаза 6 — SEO-інфраструктура (4–5 днів)

Розмітка вже зроблена на фазі 1. Тут — те, що вимагає готового каталогу й адмінки.

**Обсяг:**
- Стратегія фасетів: чиста категорія — index; один фільтр з whitelist — index з унікальним title; 2+ фільтри, сортування, `page ≥ 2` — `noindex, follow` + canonical на чисту категорію.
- `sitemap.xml` як index + підсітмапи, стрімінг з БД курсором, `lastmod`, hreflang-alternates, ліміт 50k. **`id` з `generateSitemaps` — Promise, треба `await`.**
- `robots.txt`, таблиця `redirects` + `proxy.ts` (у 16 `proxy` працює в Node runtime і читає БД напряму — на edge-middleware це було неможливо), 410 для видалених.
- Фіди: `/feed/google.xml` з `item_group_id`, `size`, `color`, `gender`, `age_group`; `/feed/facebook.csv`.
- Аналітика: GA4 з повним набором e-commerce events, Meta Pixel, GTM, Consent Mode v2, cookie-банер.
- Core Web Vitals: preload шрифтів, `srcset`/`sizes`, code splitting.

**Критерії приймання:**
- [ ] `sitemap.xml` містить лише активні товари, `lastmod` = `updated_at`, розбиття працює
- [ ] 2+ фільтри → `noindex`; чиста категорія → index
- [ ] Фід проходить валідацію Merchant Center без critical errors
- [ ] Трекери не завантажуються до згоди в банері
- [ ] Зміна slug → 301 працює в проді, `hit_count` рахується

---
