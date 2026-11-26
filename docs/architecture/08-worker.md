## 10. Воркер — задачі

| Задача | Розклад | Призначення |
|---|---|---|
| `np:sync-settlements` | 03:00 щодня | Кеш міст і відділень |
| `stock:release-expired` | щогодини | Звільнення прострочених резервацій |
| `stock:reconcile` | щогодини | Звірка `reserved_quantity` з сумою резервацій, алерт при розбіжності |
| `orders:expire-unpaid` | щогодини | Скасування неоплачених за TTL методу оплати (ADR-3) |
| `orders:reconcile-totals` | щогодини | Звірка `discount_total` із сумою `line_discount` (ADR-15) |
| `fiscal:issue-receipt` | черга | Пробиття чека після оплати, з ретраями (ADR-16). Реалізовано: тема outbox `fiscal.issue-receipt`, 20 повторів у pg-boss і до 12 спроб на документ, потім `failed` + `alert.fiscal-failed` |
| `fiscal:reconcile` | 06:00 щодня | Звірка еквайрингу з виданими чеками, алерт про розбіжності (реалізовано як `fiscal.reconcile`: перевіряє ЛИШЕ наші записи: оплачені або відправлені COD замовлення без виданого чека через годину, оплачені карткою без жодного виданого чека продажу та відкриті чеки повернення; звірка з розрахунками еквайра ще не зроблена) |
| `cart:abandoned-reminder` | щогодини | Один лист на кошик, не повторюється |
| `stock:notify-subscribers` | при поповненні | Розсилка «товар з'явився» |
| `reports:refresh-views` | щогодини | Матеріалізовані в'юшки для звітів |
| `feeds:rebuild` | 04:00 щодня | Google/Facebook фіди. **Phase 6 deviation:** the feeds are streamed live from the database by `/feed/google.xml` and `/feed/facebook.csv` (keyset batches, at most 8 open streams and 2 database reads at once, a 120 s deadline, `s-maxage=3600`), so no rebuild job exists; a snapshot job is only worth adding if the live read becomes a load problem |
| `views:cleanup` | 05:00 щодня | Видалення `product_views` старше 90 днів |
| `outbox:publish` | безперервно | Доставка outbox-записів у pg-boss з ретраями (ADR-4) |
| `payments:reconcile-open` | кожні 10 хв | `getPaymentStatus` для спроб у стані `unknown`/`in_flight` (реалізовано в фазі 3 як `payments.reconcile-open`; раз на 10 хв, бо `orders:expire-unpaid` пропускає замовлення зі спробою в стані `pending`, `in_flight` або `unknown`, і щогодини це тримало б склад годину) |
| `promo:reconcile` | 05:30 щодня | Звірка `uses_count` із redemption у стані `consumed` |
| `giftcards:reconcile` | 05:30 щодня | Звірка `balance` із сумою транзакцій, алерт |
| `giftcards:expire` | 06:30 щодня | Статус `expired`. Залишок НЕ списується до відповіді бухгалтера |
| `quarantine:cleanup` | 05:00 щодня | Очистка `webhook_quarantine` |
| `views:ingest` | черга | Асинхронна вставка переглядів — не додає латентності PDP |
| `db:backup` | 02:00 щодня | `pg_dump` → R2, ротація 30 днів |
| `email:send` | черга | Усі листи через pg-boss, з ретраями |

Листи ніколи не надсилаються синхронно в HTTP-запиті. Ставляться в чергу.

---

**Go-live note (receipts).** `fiscal.issue-receipt` jobs fail visibly while no Checkbox settings exist (`FiscalNotConfiguredError`) and retry for about fifteen hours before they land in `outbox.dead`. Receipts queued before the Checkbox account exists (Q3) therefore need a manual redrive of that dead-letter queue once the provider is configured; the `fiscal_documents` rows stay `pending` and `fiscal.reconcile` lists them meanwhile.
