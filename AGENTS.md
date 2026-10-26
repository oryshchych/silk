# AGENTS.md

<!-- Канонічні правила проєкту. Читають Claude Code, Codex, Cursor, Amp, Jules.
     CLAUDE.md посилається на цей файл і додає лише Claude-специфічне.
     Керований блок від `npx @next/codemod@canary agents-md` додається НИЖЧЕ
     і не редагується вручну. -->

Інтернет-магазин жіночої білизни та домашнього одягу. Реселлер оригінальної
продукції. Ринок — Україна, мови UK (основна) + EN, валюта UAH.

**Next.js у цьому проєкті — 16.3. TypeScript — 6.0. Node — 24 LTS.
PostgreSQL — 18.** Багато API розійшлися з тим, що ти «знаєш» із тренування.
Перед написанням коду з Next.js API читай `node_modules/next/dist/docs/`,
а не пам'ять.


---

## 1. Робочий режим

**Одна фаза за раз. Зупинка після кожної.**

Порядок: **0 → 0.5 → 1 → 2 → …** Фаза 0.5 («грошовий скелет») — наскрізний
найтонший зріз грошового шляху з тестами конкурентності на реальному
Postgres. Вона перевіряє контракт, який документація описує, але довести не
може. Не пропускати й не зливати з фазою 1.

Коли фаза завершена — не починай наступну. Зупинись і віддай звіт:

```
Фаза N завершена.
Критерії приймання:
  [x] критерій — як перевірено
  [ ] критерій — чому не виконано
Відхилення від плану: ...
Що потребує рішення людини: ...
```

Далі чекай явного «переходь до фази N+1».

Причина: кожна фаза встановлює інваріанти, на які спирається наступна. Якщо
каталог «майже готовий», checkout будується на хибних припущеннях про варіанти
й залишки, і це виявляється на фазі 5.

**Не розширюй обсяг.** Побачив дотичну проблему — запиши в `NOTES.md` і йди
далі. Не рефактори те, про що не просили.

---

---

## 2. Тверді правила (не обговорюються)

1. **Гроші — `integer` копійки.** Ніде немає `float`, `number` з дробом,
   `parseFloat` для суми. `1299.00 ₴` === `129900`. Округлення один раз, при
   відображенні.

2. **Ціни й доступність беруться з БД на сервері.** Клієнт надсилає
   `variantId` + `quantity` + id серверного checkout intent. Більше нічого.
   Якщо в тілі запиту з'явилася ціна — це вразливість, а не оптимізація.

3. **Бізнес-логіка живе в `packages/core`.** `core` не імпортує `next/*`, не
   читає cookie, не викликає `revalidateTag`, не знає про HTTP. Приймає
   транзакцію та аргументи, повертає результат. Викликається з server action,
   route handler і воркера однаково.

4. **Залишки змінюються тільки атомарним умовним UPDATE.** Ніколи
   `SELECT` → перевірка в JS → `UPDATE`. Патерн — у `ARCHITECTURE.md`, ADR-3.

5. **Фінансовий статус змінює тільки підтверджене серверне джерело**
   (ADR-4): перевірений вебхук, `getPaymentStatus`, підтверджене надходження
   COD/переказу або результат `refund_operations`. Redirect із браузера —
   ніколи. І навпаки: `getPaymentStatus` — законне джерело, тому воркер
   звіряє статус **перед** авто-скасуванням, інакше скасує оплачене.

5b. **Подія, фінансовий стан, склад, історія та `outbox` — одна
   транзакція.** Ідемпотентність отримання вебхука не робить ідемпотентним
   його застосування. Дубль відкидається лише після
   `payment_events.applied_at IS NOT NULL`, і навіть на гілці дубля
   відповідь провайдеру формує `buildWebhookResponse`.

5c. **Неперевірені вебхуки — у `webhook_quarantine`, не в
   `payment_events`.** Інакше сміття з правильним `invoiceId` займе ключ
   ідемпотентності, і справжній платіж буде відкинутий як дубль.

6. **Кожна мутація в адмінці перевіряє роль у самому server action**, а не
   тільки в `proxy.ts`. Перевірка в проксі — зручність, не безпека.

7. **Секрети тільки серверні.** Клієнту доступне лише `NEXT_PUBLIC_*`.

8. **Інваріант, який можна виразити в схемі, виражається в схемі.** Перевірка в
   застосунку не захищає від паралельних запитів, воркера й ручного SQL.

9. **Баг у грошах або залишках спершу відтворюється тестом, потім фіксується.**
   Без винятків.

---

---

## 3. Definition of done

Задача не завершена, поки:

- [ ] **`pnpm verify` проходить** (typecheck + lint --max-warnings 0 + unit + format:check)
- [ ] Логіка домену покрита unit-тестами в `packages/core`
      (`pricing` і `inventory` — поріг 95%)
- [ ] Зміна в грошах, залишках або платежах має тест на **паралельний виклик**
      із окремими з'єднаннями, не з одного пулу
- [ ] Немає `any` — це тепер ловить лінтер (`no-unsafe-*`), а не рев'ю.
      Якщо довелося обійти правило, у коментарі є причина
- [ ] `ts-expect-error` замість `ts-ignore`, з описом ≥ 20 символів
- [ ] Немає закоментованого коду й `console.log`
- [ ] Суми — тип `Money`, не `number`
- [ ] Мутації пишуть в `audit_log`
- [ ] Нові рядки UI мають переклад UK **і** EN
- [ ] Нові зображення мають `alt`, `width`, `height`
- [ ] Міграція, якщо змінювалась схема, і `drizzle-kit check` чистий

---

---

## 4. Next.js 16 — де ти найімовірніше помилишся

| Ти напишеш | Правильно у 16 |
|---|---|
| `middleware.ts`, `export function middleware` | `proxy.ts`, `export function proxy`. Runtime — `nodejs`, не конфігурується, edge не підтримується |
| `revalidateTag('products')` | `revalidateTag('products', 'max')` — другий аргумент обов'язковий. Для read-your-writes в адмінці — `updateTag(tag)` |
| `const { slug } = params` | `const { slug } = await params`. Синхронний доступ прибрано остаточно — те саме для `searchParams`, `cookies()`, `headers()` |
| `export default function sitemap({ id })` | `const resolvedId = await id` — у `generateSitemaps` id тепер Promise |
| `images: { domains: [...] }` | `images: { remotePatterns: [...] }` |
| `<Image quality={90} />` без конфігу | `images.qualities` за замовчуванням лише `[75]` — інші значення оголошуються явно |
| `next lint` у CI | Команди немає. ESLint CLI напряму, flat config |
| `--turbopack` у скриптах | Turbopack дефолтний. Кастомний webpack-конфіг зламає `next build` |
| `process.env.X` у server component | Для значень, що мусять читатись у рантаймі, спершу `await connection()` — інакше запечеться в білд (ADR-10) |
| `experimental.ppr` / `dynamicIO` | Прибрані. `cacheComponents` **не вмикаємо** у v1 — див. ADR-9 |
| `unstable_cacheTag` | `cacheTag`, `cacheLife` — стабільні |

Node.js ≥ 20.9 (у нас 22 LTS), TypeScript ≥ 5.1.

---

---

## 4b. Пастки, у які найлегше впасти в цьому проєкті

Виявлені двома незалежними рецензіями. Не «best practice», а конкретні
сценарії відмови.

**1. Передати не той transaction handle.** Найімовірніша помилка в усьому
проєкті. Зовнішній `db.transaction()` виглядає правильним, але
`reserveStock`, `applyPromo` або `writeHistory` всередині використає
глобальний `db` — і частина змін закомітиться незалежно від відкату.
Тому transaction handle — **обов'язковий перший параметр** усіх доменних
мутацій, а не опційний. Перевіряти навмисною помилкою після кожного кроку
і звіряти всі зачеплені таблиці.

**2. Занадто рано уніфікувати Mono і WayForPay.** Для Mono важливі
оригінальні байти тіла й ECDSA; WayForPay підписує визначений набір полів і
вимагає окремо підписаного acknowledgment. Поле, присутнє в JSON, не
обов'язково входить до підпису — тому підпис перевіряється **до** будь-якої
доменної нормалізації. Кожен адаптер тестується записаними реальними
прикладами, включно зі зміною непідписаних полів і повторною доставкою.

**3. Повернути клієнту повний Drizzle-об'єкт і приховати зайве в UI.**
Витече не `cost_price`, який ти пам'ятаєш, а `unit_cost_snapshot` у вкладених
`order_items` або старе значення в `audit_log.diff`. Найризиковіші місця:
картка замовлення, props клієнтського компонента, CSV/XLSX-експорт.
DTO формується **явним переліком полів**; тестується фактична серіалізована
відповідь для кожної ролі, не те, що видно на екрані.

**4. Застарілий кошик після повернення з платіжки.** `revalidateTag`
інвалідує серверний кеш, але не клієнтський router cache. Потрібен
`refresh()` із server action, а `/order/success` не покладається на
кешовані дані взагалі.

**5. Фіскальний чек у неправильний момент.** Не синхронно в обробнику
вебхука і не в чергу, яка може впасти тихо. Порядок — ADR-16. Якщо гроші
пройшли, а ПРРО віддав 503, транзакцію **не відкочувати**.

**6. Часові зони в резерваціях.** `expires_at` обчислюється як
`now() + interval` **на боці Postgres**. Ніяких порівнянь `Date.now()` з
полями БД. `CRON_TIMEZONE` впливає лише на розклад (ADR-17).

**7. Зліпити сертифікати з промокодами.** Виглядають однаково — «код, що
зменшує суму». Але промокод це знижка в `pricing`, а сертифікат — спосіб
оплати в `PaymentProvider`, за який гроші вже отримані. Якщо порахувати
продаж сертифіката як виручку, вона задвоїться: спершу при продажу, потім
при купівлі за нього (ADR-20).

**8. Назвати токени за кольором, а не за роллю.** `--blush`, `--cream`,
`--pink-accent` замість `--surface`, `--text-primary`, `--accent`. Виглядає
природно, коли пишеш перший компонент, і робить будь-яку зміну палітри
переписуванням. Вітрина у v1 світла, але токени семантичні (ADR-21).
Перевірка: `grep -rE "blush|cream|pink" packages/ apps/web/components/`
мусить бути порожнім.

**9. Поставити тему на `<html>` на сервері за cookie.** В адмінці це
безпечно — вона не кешується. На вітрині це фрагментує ISR-кеш по темах або
віддає комусь чужу тему (ADR-8 + ADR-21).

**10. Реалізувати «повернення на склад» літерально.** До оплати товар лише
резервувався, тому `stock_quantity` при скасуванні **не змінюється**.
Три різні операції: `release reservation`, `ship stock`, `receive return`
(ADR-18).

---

---

## 5. Коли зупинитись і запитати, а не вгадувати

- Рішення не описане в `ARCHITECTURE.md`, а вибір впливає на схему БД
- Потрібно змінити або видалити наявну колонку чи обмеження
- Потрібна нова залежність, важча за утиліту
- Виникає спокуса відключити `CHECK` або `UNIQUE`, щоб код заробив
- Щось у `PLAN.md` суперечить `ARCHITECTURE.md`
- Задача зачіпає юридичне (оферта, повернення, фіскальні чеки, персональні дані)
- Критерій приймання неможливо виконати як сформульовано

Формулюй як: що робиш, у чому вибір, які варіанти, що рекомендуєш і чому.

---

---

## 6. Заборонено без явного дозволу

- Виконувати міграції або будь-який DDL на production
- Змінювати `.env` продакшену чи staging
- Робити реальний платіж або створювати реальну ТТН Нової Пошти
- Розсилати email кудись, крім catch-all адреси на staging
- Комітити в `main` напряму
- Додавати `shamefully-hoist` у `.npmrc` (це знищує головну перевагу pnpm — див. §7)
- Ставити `dangerouslyAllowLocalIP`, `dangerouslySetInnerHTML` без sanitize,
  `eslint-disable` на цілий файл

---

---

## 7. Інструменти

`pnpm` обов'язково, не npm. Не через швидкість: строгий `node_modules` фізично
не дає `packages/core` імпортувати `next`, якщо той не оголошений у його
`package.json`. Це перетворює правило §2.3 з дисципліни в гарантію.

```bash
pnpm dev                    # web + worker + postgres
pnpm db:migrate             # міграції
pnpm db:seed                # тестові дані
pnpm typecheck lint test    # перед кожним комітом
pnpm test:e2e               # Playwright
pnpm --filter web build
```

---

---

## 8. Карта проєкту

```
apps/web        Next.js: вітрина + /admin + вебхуки + фіди
apps/worker     pg-boss: cron і черги. Той самий репозиторій, інший entrypoint
packages/db     Drizzle: schema, міграції, seed
packages/core   ДОМЕН: pricing, inventory, orders, catalog, reports
packages/payments  PaymentProvider + mono + wayforpay + FiscalProvider
packages/shipping  nova-poshta, ukrposhta
packages/media     sharp + R2
packages/email     шаблони + Resend
packages/shared    zod, money, типи, i18n-ключі, schema-org
```

Перевірка на здоров'я архітектури: `grep -r "from 'next" packages/core/` мусить
бути порожнім.

---

---

## 8b. Протокол сесій

Сесія не переживає перезапуск, і не має. **Стан живе в git і в
`docs/plan/CURRENT.md`, не в контексті.**

**На початку сесії:** прочитати `docs/plan/CURRENT.md` — це вхідні дані.
Потім файл поточної фази.

**Наприкінці сесії:** останньою дією оновити `docs/plan/CURRENT.md`:
поточна фаза, що закомічено (з хешами), наступний крок, які критерії
приймання **перевірені виконанням і чим саме**, відхилення від плану,
що чекає рішення людини.

Правила:

- «Зроблено» — тільки закомічене. Не «написав», а «закомічено в `abc1234`».
- Критерій відзначається, лише якщо перевірений **виконанням**. «Написав
  тест» — не критерій. «`pnpm test:int` проходить, 12 тестів» — критерій.
- Рішення змінилося → в «Відхилення», не тихо виправити.
- Тримати файл до 60 рядків: він читається на початку кожної сесії.

**Комітити малими зв'язними порціями** з conventional commits. Git-історія —
основна пам'ять проєкту; `CURRENT.md` лише вказівник у ній.

**Жодної атрибуції ШІ — ні в комітах, ні в PR.** Не додавати
`Co-Authored-By: Claude …` чи будь-який інший трейлер/примітку про ШІ-агента
в повідомлення коміту; не додавати «Generated with Claude Code» чи подібне
в назву, опис або коментарі PR. Правило сильніше за дефолтну поведінку
інструмента. Для комітів його тримає commitlint (`no-ai-attribution`).

**Не покладатися на `/compact`.** Стиснення може перетворити «я запропонував
X» на «ми вирішили X», і хибний висновок поїде далі. Замість цього:
закомітити, оновити `CURRENT.md`, почати чисту сесію.

## 9. Документи

Не вантажити все. Читати те, що потрібно для поточної задачі.

| Коли | Що читати |
|---|---|
| Завжди | цей файл + `CLAUDE.md` |
| На початку **кожної** сесії | `docs/plan/CURRENT.md` — стан з попередньої |
| Поточна фаза | `docs/plan/phase-NN-*.md` — **тільки свою** |
| Архітектурне рішення | `docs/architecture/README.md` → потрібний файл |
| Перед запитом до БД | `packages/db/src/schema.ts` |
| Тулінг, тести, міграції | `docs/DEVELOPMENT.md` |
| Env, деплой, staging | `docs/ENVIRONMENTS.md` |
| Промокоди | `docs/PROMO_CODES.md` |
| Сертифікати | `docs/GIFT_CARDS.md` |
| Конфіги агента | `docs/AI_SETUP.md` |
| **Перед тим, як «виправити» дивне рішення** | `docs/REVIEW_TRIAGE.md` — там обґрунтування ~60 рішень, які вже тричі обговорені |
| Мутація в адмінці | `docs/SECURITY.md` (фаза 4) |
| Інцидент | `docs/RUNBOOK.md` (фаза 12) |

Правило: **не переходити до наступної фази без явного підтвердження.**
І не вгадувати відповіді на «Відкриті питання» з
`docs/plan/00-rules-and-answers.md`.


<!-- NEXT-AGENTS-MD-START -->[Next.js Docs Index]|root: ./.next-docs|STOP. What you remember about Next.js is WRONG for this project. Always search docs and read before any task.|If docs missing, run this command first: npx @next/codemod agents-md --output AGENTS.md|01-app:{04-glossary.mdx}|01-app/01-getting-started:{01-installation.mdx,02-project-structure.mdx,03-layouts-and-pages.mdx,04-linking-and-navigating.mdx,05-server-and-client-components.mdx,06-fetching-data.mdx,07-mutating-data.mdx,08-caching.mdx,09-revalidating.mdx,10-error-handling.mdx,11-css.mdx,12-images.mdx,13-fonts.mdx,14-metadata-and-og-images.mdx,15-route-handlers.mdx,16-proxy.mdx,17-deploying.mdx,18-upgrading.mdx}|01-app/02-guides:{adopting-partial-prefetching.mdx,ai-agents.mdx,analytics.mdx,authentication-with-cache-components.mdx,authentication.mdx,backend-for-frontend.mdx,building.mdx,caching-without-cache-components.mdx,cdn-caching.mdx,ci-build-caching.mdx,content-security-policy.mdx,css-in-js.mdx,custom-server.mdx,data-security.mdx,debugging.mdx,deploying-to-platforms.mdx,draft-mode.mdx,environment-variables.mdx,forms.mdx,how-revalidation-works.mdx,incremental-static-regeneration-cache-components.mdx,incremental-static-regeneration.mdx,instant-navigation.mdx,instrumentation.mdx,interactive-apps.mdx,internationalization.mdx,json-ld.mdx,lazy-loading.mdx,local-development.mdx,mcp.mdx,mdx.mdx,memory-usage.mdx,migrating-to-cache-components.mdx,multi-tenant.mdx,multi-zones.mdx,offline-support.mdx,open-telemetry.mdx,optimizing-prefetching.mdx,package-bundling.mdx,ppr-platform-guide.mdx,prefetching.mdx,preserving-ui-state.mdx,preventing-flash-before-hydration.mdx,production-checklist.mdx,progressive-web-apps.mdx,public-static-pages.mdx,redirecting.mdx,rendering-philosophy.mdx,sass.mdx,scripts.mdx,self-hosting.mdx,server-actions.mdx,server-and-client-boundary.mdx,single-page-applications.mdx,static-exports.mdx,streaming.mdx,tailwind-v3-css.mdx,third-party-libraries.mdx,videos.mdx,view-transitions.mdx}|01-app/02-guides/client-side-data-fetching:{swr.mdx,tanstack-query.mdx}|01-app/02-guides/migrating:{app-router-migration.mdx,from-create-react-app.mdx,from-vite.mdx}|01-app/02-guides/testing:{cypress.mdx,jest.mdx,playwright.mdx,vitest.mdx}|01-app/02-guides/upgrading:{codemods.mdx,version-14.mdx,version-15.mdx,version-16.mdx}|01-app/03-api-reference:{07-edge.mdx,08-turbopack.mdx}|01-app/03-api-reference/01-directives:{use-cache-private.mdx,use-cache-remote.mdx,use-cache.mdx,use-client.mdx,use-server.mdx}|01-app/03-api-reference/02-components:{font.mdx,form.mdx,image.mdx,link.mdx,script.mdx}|01-app/03-api-reference/03-file-conventions/01-metadata:{app-icons.mdx,manifest.mdx,opengraph-image.mdx,robots.mdx,sitemap.mdx}|01-app/03-api-reference/03-file-conventions/02-route-segment-config:{dynamicParams.mdx,instant.mdx,maxDuration.mdx,preferredRegion.mdx,prefetch.mdx,runtime.mdx}|01-app/03-api-reference/03-file-conventions:{default.mdx,dynamic-routes.mdx,error.mdx,forbidden.mdx,instrumentation-client.mdx,instrumentation.mdx,intercepting-routes.mdx,layout.mdx,loading.mdx,mdx-components.mdx,middleware.mdx,not-found.mdx,page.mdx,parallel-routes.mdx,proxy.mdx,public-folder.mdx,route-groups.mdx,route.mdx,src-folder.mdx,template.mdx,unauthorized.mdx}|01-app/03-api-reference/04-functions:{after.mdx,cacheLife.mdx,cacheTag.mdx,catchError.mdx,connection.mdx,cookies.mdx,draft-mode.mdx,fetch.mdx,forbidden.mdx,generate-image-metadata.mdx,generate-metadata.mdx,generate-sitemaps.mdx,generate-static-params.mdx,generate-viewport.mdx,headers.mdx,image-response.mdx,io.mdx,next-request.mdx,next-response.mdx,next-root-params.mdx,not-found.mdx,permanentRedirect.mdx,redirect.mdx,refresh.mdx,revalidatePath.mdx,revalidateTag.mdx,unauthorized.mdx,unstable_cache.mdx,unstable_noStore.mdx,unstable_rethrow.mdx,updateTag.mdx,use-link-status.mdx,use-offline.mdx,use-params.mdx,use-pathname.mdx,use-report-web-vitals.mdx,use-router.mdx,use-search-params.mdx,use-selected-layout-segment.mdx,use-selected-layout-segments.mdx,userAgent.mdx}|01-app/03-api-reference/05-config/01-next-config-js:{adapterPath.mdx,allowedDevOrigins.mdx,appDir.mdx,assetPrefix.mdx,authInterrupts.mdx,basePath.mdx,cacheComponents.mdx,cacheHandlers.mdx,cacheLife.mdx,cacheMaxMemorySize.mdx,compress.mdx,crossOrigin.mdx,cssChunking.mdx,deploymentId.mdx,devIndicators.mdx,distDir.mdx,env.mdx,expireTime.mdx,exportPathMap.mdx,generateBuildId.mdx,generateEtags.mdx,headers.mdx,htmlLimitedBots.mdx,httpAgentOptions.mdx,images.mdx,incrementalCacheHandlerPath.mdx,inlineCss.mdx,instrumentationClientInject.mdx,logging.mdx,mdxRs.mdx,onDemandEntries.mdx,optimizePackageImports.mdx,output.mdx,outputHashSalt.mdx,pageExtensions.mdx,partialPrefetching.mdx,poweredByHeader.mdx,prefetchInlining.mdx,productionBrowserSourceMaps.mdx,proxyClientMaxBodySize.mdx,reactCompiler.mdx,reactMaxHeadersLength.mdx,reactStrictMode.mdx,redirects.mdx,rewrites.mdx,sassOptions.mdx,serverActions.mdx,serverComponentsHmrCache.mdx,serverExternalPackages.mdx,staleTimes.mdx,staticGeneration.mdx,supportsImmutableAssets.mdx,taint.mdx,trailingSlash.mdx,transpilePackages.mdx,turbopack.mdx,turbopackChunking.mdx,turbopackFileSystemCache.mdx,turbopackIgnoreIssue.mdx,turbopackLocalPostcssConfig.mdx,turbopackMemoryEviction.mdx,turbopackRustReactCompiler.mdx,typedRoutes.mdx,typescript.mdx,urlImports.mdx,useLightningcss.mdx,useOffline.mdx,useTypeScriptCli.mdx,webVitalsAttribution.mdx,webpack.mdx}|01-app/03-api-reference/05-config:{02-typescript.mdx,03-eslint.mdx}|01-app/03-api-reference/06-cli:{create-next-app.mdx,next.mdx}|01-app/03-api-reference/07-adapters:{01-configuration.mdx,02-creating-an-adapter.mdx,03-api-reference.mdx,04-testing-adapters.mdx,05-routing-with-next-routing.mdx,06-implementing-ppr-in-an-adapter.mdx,07-runtime-integration.mdx,08-invoking-entrypoints.mdx,09-output-types.mdx,10-routing-information.mdx,11-use-cases.mdx,12-immutable-static-assets.mdx}|02-pages/01-getting-started:{01-installation.mdx,02-project-structure.mdx,04-images.mdx,05-fonts.mdx,06-css.mdx,11-deploying.mdx}|02-pages/02-guides:{analytics.mdx,authentication.mdx,babel.mdx,ci-build-caching.mdx,content-security-policy.mdx,css-in-js.mdx,custom-server.mdx,debugging.mdx,draft-mode.mdx,environment-variables.mdx,forms.mdx,incremental-static-regeneration.mdx,instrumentation.mdx,internationalization.mdx,lazy-loading.mdx,mdx.mdx,multi-zones.mdx,open-telemetry.mdx,package-bundling.mdx,post-css.mdx,preview-mode.mdx,production-checklist.mdx,redirecting.mdx,sass.mdx,scripts.mdx,self-hosting.mdx,static-exports.mdx,tailwind-v3-css.mdx,third-party-libraries.mdx}|02-pages/02-guides/migrating:{app-router-migration.mdx,from-create-react-app.mdx,from-vite.mdx}|02-pages/02-guides/testing:{cypress.mdx,jest.mdx,playwright.mdx,vitest.mdx}|02-pages/02-guides/upgrading:{codemods.mdx,version-10.mdx,version-11.mdx,version-12.mdx,version-13.mdx,version-14.mdx,version-9.mdx}|02-pages/03-building-your-application/01-routing:{01-pages-and-layouts.mdx,02-dynamic-routes.mdx,03-linking-and-navigating.mdx,05-custom-app.mdx,06-custom-document.mdx,07-api-routes.mdx,08-custom-error.mdx}|02-pages/03-building-your-application/02-rendering:{01-server-side-rendering.mdx,02-static-site-generation.mdx,04-automatic-static-optimization.mdx,05-client-side-rendering.mdx}|02-pages/03-building-your-application/03-data-fetching:{01-get-static-props.mdx,02-get-static-paths.mdx,03-get-server-side-props.mdx,05-client-side.mdx}|02-pages/03-building-your-application/06-configuring:{12-error-handling.mdx}|02-pages/04-api-reference:{06-edge.mdx,08-turbopack.mdx}|02-pages/04-api-reference/01-components:{font.mdx,form.mdx,head.mdx,image-legacy.mdx,image.mdx,link.mdx,script.mdx}|02-pages/04-api-reference/02-file-conventions:{instrumentation.mdx,proxy.mdx,public-folder.mdx,src-folder.mdx}|02-pages/04-api-reference/03-functions:{catchError.mdx,get-initial-props.mdx,get-server-side-props.mdx,get-static-paths.mdx,get-static-props.mdx,next-request.mdx,next-response.mdx,use-params.mdx,use-report-web-vitals.mdx,use-router.mdx,use-search-params.mdx,userAgent.mdx}|02-pages/04-api-reference/04-config/01-next-config-js:{adapterPath.mdx,allowedDevOrigins.mdx,assetPrefix.mdx,basePath.mdx,bundlePagesRouterDependencies.mdx,compress.mdx,crossOrigin.mdx,deploymentId.mdx,devIndicators.mdx,distDir.mdx,env.mdx,exportPathMap.mdx,generateBuildId.mdx,generateEtags.mdx,headers.mdx,httpAgentOptions.mdx,images.mdx,logging.mdx,onDemandEntries.mdx,optimizePackageImports.mdx,output.mdx,pageExtensions.mdx,poweredByHeader.mdx,productionBrowserSourceMaps.mdx,proxyClientMaxBodySize.mdx,reactStrictMode.mdx,redirects.mdx,rewrites.mdx,serverExternalPackages.mdx,trailingSlash.mdx,transpilePackages.mdx,turbopack.mdx,turbopackChunking.mdx,typescript.mdx,urlImports.mdx,useLightningcss.mdx,useTypeScriptCli.mdx,webVitalsAttribution.mdx,webpack.mdx}|02-pages/04-api-reference/04-config:{01-typescript.mdx,02-eslint.mdx}|02-pages/04-api-reference/05-cli:{create-next-app.mdx,next.mdx}|02-pages/04-api-reference/06-adapters:{01-configuration.mdx,02-creating-an-adapter.mdx,03-api-reference.mdx,04-testing-adapters.mdx,05-routing-with-next-routing.mdx,06-runtime-integration.mdx,07-invoking-entrypoints.mdx,08-output-types.mdx,09-routing-information.mdx,10-use-cases.mdx}|03-architecture:{accessibility.mdx,fast-refresh.mdx,nextjs-compiler.mdx,supported-browsers.mdx}|04-community:{01-contribution-guide.mdx,02-rspack.mdx}<!-- NEXT-AGENTS-MD-END -->
