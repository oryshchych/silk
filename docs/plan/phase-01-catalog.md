## Фаза 1 — Каталог і базове SEO (1.5 тижня)

**Мета:** відвідувач знаходить товар, Google бачить сторінку правильно.

SEO-розмітка входить **сюди**, а не в окрему пізню фазу. Це виправлення
попередньої версії плану: `generateMetadata` і JSON-LD — властивість сторінки,
і дописувати їх через п'ять фаз означає переписувати всі маршрути.

**Обсяг:**
- Дерево категорій (3 рівні), сторінка категорії з рекурсивним включенням підкатегорій.
- PLP: фільтри (обхват, чашка, розмір одягу, колір, ціна, бренд, наявність, знижка), сортування, пагінація. Стан у URL — єдине джерело істини.
- PDP: галерея, колір → перемикання фото, розміри з недоступними станами, акордеони, таблиця розмірів.
- Пошук: `tsvector` з **українським hunspell-словником** + `pg_trgm` для опечаток.
  Первісно тут стояло `simple` + `unaccent` із поясненням, що українського
  словника в Postgres немає — це правда лише про **вбудовані** конфігурації.
  Образ Postgres ми будуємо самі, тому hunspell ставиться в
  `$SHAREDIR/tsearch_data` і створюється конфігурація `ukrainian` (SQL — у
  `schema.ts`, блок додаткового SQL). Без цього «бюстгальтер» і «бюстгальтери»
  різні токени, і `pg_trgm` компенсує морфологію триграмами, розмиваючи
  релевантність. Ціна — свій Dockerfile для Postgres і лок-ін на self-hosted.
- Калькулятор розміру бюстгальтера в `packages/core/catalog/bra-size.ts` — чиста функція, unit-тести на межах.
- Головна: hero, категорії, новинки, бестселери, USP.
- ISR + точкові теги `product:{id}`, `category:{id}`.
- **Базове SEO:** `generateMetadata` на всіх маршрутах (title, description, canonical, hreflang uk↔en↔x-default, OG/Twitter), JSON-LD `Product` / `ItemList` / `BreadcrumbList` через типізовані білдери в `packages/shared/schema-org.ts`.
- Скелетони, empty states, 404.

**Acceptance criteria** (verified by execution on 2026-11-23, tree = `main` + #48; details in `docs/plan/CURRENT.md`):
- [x] Three filters together give a correct result and live in the URL: `catalog.int.test.ts` (band, cup and colour must match ONE variant; `band=75&cup=B&color=black` returns only the right product), `listing-params.unit.test.ts`, `pnpm smoke:web` (`/category/bras?band=75&cup=B&color=black` is 200 with the query in the language switch).
- [x] Search with a typo finds the product: integration tests (`бюстгалтер` without the soft sign, `aurra`, inflected forms, `-ий` words), `pnpm smoke:web` on the built app.
- [x] The calculator on real measurements matches the correspondence table: `bra-size.unit.test.ts` (both edges of every cup row, worked fittings), real browser on the built image (76/90 gives 75B, 76/94 gives 75D). The table itself is a placeholder until the shop confirms it (owner item Q19).
- [x] An unavailable size is not selectable, an available one is: `variant-selection.unit.test.ts`, a `disabled` radio in the served HTML (smoke), clicks in a real browser on the built image.
- [x] UK/EN switch keeps the page and the filters: `pnpm smoke:web` (the language link carries the same path and query), hreflang pairs are reciprocal with x-default.
- [x] `curl -A Googlebot` returns title, canonical, hreflang and JSON-LD in the primary HTML: `/category/bras` and `/product/push-up-bra-aurora-1` on a production-mode image (canonical and hreflang on the runtime `SITE_URL`, 2 JSON-LD blocks each); `pnpm smoke:web` asserts the same on every run.
- [ ] Rich Results Test: Google's tool was NOT run (it needs a public URL). A structural check of the served JSON-LD against Google's documented required fields found no errors for `Product` (absolute images, offers with exact decimal price, UAH, schema.org availability, no unseen rating) and `BreadcrumbList` in both locales. Run the real tool against staging when it is reachable.
- [x] Lighthouse mobile on the built image as `APP_ENV=production`: category and product pages, uk and en, Performance 100, SEO 100, Accessibility 100, CLS 0 (warm). The first request after a container start scored 80 on the category page (cold route, empty cache); three warm reruns scored 100.
- [x] No N+1 on the listing: `pg_stat_statements` on a throwaway Postgres: a cache-miss category listing is 2 statements (the page rows and one batched image query) with 38 and with 338 products; an integration test in `catalog.int.test.ts` counts queries and pins the same.
---
