# ARCHITECTURE.md

## 1. Стек і чому саме він

| Шар | Вибір | Обґрунтування |
|---|---|---|
| Застосунок | Next.js 16.3, App Router | Бекенд вбудований: server components читають БД напряму, route handlers приймають вебхуки, server actions роблять мутації. Ніякого окремого API-шару |
| Runtime | Node.js 22 LTS | Next.js 16 вимагає мінімум 20.9; Node 18 більше не підтримується |
| Мова | TypeScript 5.1+, `strict: true` | Мінімум для Next.js 16 |
| Збірка | Turbopack (default) | У 16 стабільний і вмикається сам для `next dev` і `next build`. Кастомного webpack-конфігу в проєкті немає — і не має з'явитись, бо з ним білд впаде |
| БД | PostgreSQL 16 | Транзакції для списання залишків, join-и для звітів, FK і CHECK для цілісності. Домен реляційний |
| ORM | Drizzle | Типізовані запити без рантайм-магії, міграції як SQL-файли, які можна прочитати |
| Auth | Auth.js + Drizzle adapter | Сесії в Postgres. Без Clerk — це $25/міс за те, що робиться за вечір |
| Стилі | Tailwind + shadcn/ui | — |
| Файли | Cloudflare R2 | 10 ГБ безкоштовно і нуль плати за egress. Для фото-каталогу це головна економія |
| Черги й cron | pg-boss | Живе в Postgres. Без Redis — мінус залежність, мінус витрати |
| Email | Resend | — |
| Хостинг | Hetzner VPS + Dokploy | ~€5/міс. Vercel Hobby для комерції заборонений, Pro — $20 |
| CDN/WAF | Cloudflare free | — |
| Пакетний менеджер | pnpm (обов'язково) | Не через швидкість. Строгий `node_modules` фізично не дає `packages/core` імпортувати `next`, якщо той не оголошений у його `package.json` — головне архітектурне правило стає гарантією інсталятора, а не питанням код-рев'ю. Плюс `pnpm deploy` збирає образ воркера без залежностей вітрини. **`shamefully-hoist` не додавати** — це зводить перевагу на нуль |

### Свідомі відмови

- **Supabase.** RLS цінна, коли браузер лізе в БД напряму. З server components авторизація живе в коді, де її видно й тестують. Плюс free tier паузить проєкт після тижня неактивності — для продакшену непридатно.
- **Розділення front/back.** Next.js уже моноліт. Розділення додає CORS, cookie-домени, version skew і три сітьових стрибки замість одного.
- **Мікросервіси.** На обороті малого магазину це чистий overhead.
- **Algolia/Typesense.** `pg_trgm` + `tsvector` достатньо до кількох десятків тисяч SKU.
- **Redis.** ISR знімає з БД майже все навантаження на читанні, сесії в Postgres, черги в pg-boss.

---

## 2. Структура репозиторію

```
store/
├─ apps/
│  ├─ web/                          # Next.js
│  │  ├─ app/
│  │  │  ├─ (shop)/[locale]/        # вітрина
│  │  │  │  ├─ page.tsx             # головна
│  │  │  │  ├─ catalog/[...slug]/   # категорії, будь-яка глибина
│  │  │  │  ├─ product/[slug]/
│  │  │  │  ├─ cart/ checkout/ order/ account/ blog/ p/[slug]/
│  │  │  ├─ (admin)/admin/          # окремий layout, окремий middleware
│  │  │  ├─ api/
│  │  │  │  ├─ webhooks/mono/       # route handler, POST
│  │  │  │  ├─ webhooks/wayforpay/
│  │  │  │  └─ revalidate/
│  │  │  ├─ sitemap.xml/ robots.txt/ feed/
│  │  ├─ components/ (ui | shop | admin)
│  │  └─ proxy.ts                   # локаль + захист /admin + 301 з БД
│  │                                # (у 16 middleware.ts перейменовано на proxy.ts,
│  │                                #  named export теж proxy; runtime — nodejs)
│  └─ worker/                       # окремий процес, той самий репозиторій
│     └─ jobs/                      # cron і черги
├─ packages/
│  ├─ db/            # schema.ts, міграції, seed, клієнт
│  ├─ core/          # ДОМЕН. Не залежить від Next.js
│  │  ├─ pricing/    # розрахунок кошика, знижки, промокоди
│  │  ├─ inventory/  # резервації, списання, повернення на склад
│  │  ├─ orders/     # створення, переходи статусів, повернення коштів
│  │  ├─ catalog/    # запити каталогу, фільтри, пошук
│  │  └─ reports/    # SQL для звітів
│  ├─ payments/      # PaymentProvider + mono + wayforpay
│  ├─ shipping/      # nova-poshta, ukrposhta
│  ├─ media/         # sharp, завантаження в R2
│  ├─ email/         # шаблони + Resend
│  └─ shared/        # zod-схеми, money, типи, i18n-ключі
├─ docker-compose.yml
├─ PLAN.md · ARCHITECTURE.md · SECURITY.md · RUNBOOK.md
```

### Головне архітектурне правило

**`packages/core` не імпортує нічого з Next.js.** Він отримує транзакцію БД і аргументи, повертає результат. Тоді те саме списання залишку викликається з server action в адмінці, з вебхука платіжки, з воркера і, якщо колись з'явиться публічний API, з нього.

Функція в `core` **не** робить `revalidateTag`, **не** читає cookie, **не** знає про HTTP. Це робить викликач.

Перевірка на здоров'я: якщо у `packages/core` з'явився імпорт `next/*` — архітектура почала протікати.

---
