## 8. SEO — реалізація

- `generateMetadata` на кожному маршруті. Дані з БД, fallback-шаблони в `packages/shared/seo.ts`.
- Стратегія фасетів: чиста категорія — index; один популярний фільтр з whitelist (напр. `?band=75`) — index з унікальним title; 2+ фільтри, сортування, `page ≥ 2` — `noindex, follow`, canonical на чисту категорію.
- JSON-LD генерується типізованими білдерами в `packages/shared/schema-org.ts`. Ніяких рядкових шаблонів.
- `sitemap.xml` — index, підсітмапи стрімляться з БД курсором, кеш 1 год через `revalidate`. **У 16 `id` з `generateSitemaps` приходить як Promise** — його треба `await`, інакше отримаєте `NaN` у зсуві:
  ```ts
  export default async function sitemap({ id }) {
    const start = Number(await id) * 50000;
  }
  ```
  Те саме стосується `params` та `id` у `opengraph-image`, `twitter-image`, `icon`.
- `redirects` — таблиця в БД + `proxy.ts`. Зміна slug в адмінці автоматично створює 301.
  Тут Next.js 16 нам допоміг: у `proxy` runtime — `nodejs` і не конфігурується (edge не підтримується). Раніше на edge-middleware читати Postgres було неможливо, і таблицю редіректів довелося б тягнути в KV. Тепер `proxy` ходить у БД напряму.
- `next/image`: у 16 змінилися дефолти. `images.domains` deprecated — для домену медіа з R2 використовуємо `remotePatterns`. `images.qualities` тепер дозволяє тільки `[75]`, тому будь-який інший `quality` треба оголосити явно. `minimumCacheTTL` виріс з 60 с до 4 год — для каталогу це радше плюс.
- **Core Web Vitals (phase 6).** Fonts: the site uses the system font stack (`--font-sans`, `--font-display` in `globals.css`), so there is no web font to preload and no font request at all. Photos: the six renditions made at upload (WebP and AVIF at 320, 800 and 1600 px) are served as `<picture>` with `srcset` and `sizes` (`ResponsiveImage`, `lib/renditions.ts`); the sibling URLs are derived from the full WebP key, a URL of another shape (the seed placeholder) is shown as is. `width` and `height` always reserve the box (no layout shift); the first cards and the gallery's lead photo are `fetchpriority=high` and eager, the rest `loading=lazy`; the product page preloads the lead photo (AVIF). JavaScript is split per route by the App Router; there is no heavy client-only dependency to lazy load.
- hreflang формується з одного джерела — мапи маршрутів, щоб пари гарантовано були взаємними.

Ключова перевірка після кожного релізу:

```bash
curl -sA "Mozilla/5.0 (compatible; Googlebot/2.1)" https://site/product/x \
  | grep -E '<title>|canonical|hreflang|application/ld\+json'
```

---
