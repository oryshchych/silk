## 10. Воркер — задачі

| Задача | Розклад | Призначення |
|---|---|---|
| `np:sync-settlements` | 03:00 щодня | Кеш міст і відділень |
| `stock:release-expired` | щогодини | Звільнення прострочених резервацій |
| `stock:reconcile` | щогодини | Звірка `reserved_quantity` з сумою резервацій, алерт при розбіжності |
| `orders:expire-unpaid` | щогодини | Скасування неоплачених за TTL методу оплати (ADR-3) |
| `orders:reconcile-totals` | щогодини | Звірка `discount_total` із сумою `line_discount` (ADR-15) |
| `fiscal:issue-receipt` | черга | Пробиття чека після оплати, з ретраями (ADR-16) |
| `fiscal:reconcile` | 06:00 щодня | Звірка еквайрингу з виданими чеками, алерт про розбіжності |
| `cart:abandoned-reminder` | щогодини | Один лист на кошик, не повторюється |
| `stock:notify-subscribers` | при поповненні | Розсилка «товар з'явився» |
| `reports:refresh-views` | щогодини | Матеріалізовані в'юшки для звітів |
| `feeds:rebuild` | 04:00 щодня | Google/Facebook фіди |
| `views:cleanup` | 05:00 щодня | Видалення `product_views` старше 90 днів |
| `outbox:publish` | безперервно | Доставка outbox-записів у pg-boss з ретраями (ADR-4) |
| `payments:reconcile-open` | щогодини | `getPaymentStatus` для спроб у стані `unknown`/`in_flight` |
| `promo:reconcile` | 05:30 щодня | Звірка `uses_count` із redemption у стані `consumed` |
| `giftcards:reconcile` | 05:30 щодня | Звірка `balance` із сумою транзакцій, алерт |
| `giftcards:expire` | 06:30 щодня | Статус `expired`. Залишок НЕ списується до відповіді бухгалтера |
| `quarantine:cleanup` | 05:00 щодня | Очистка `webhook_quarantine` |
| `views:ingest` | черга | Асинхронна вставка переглядів — не додає латентності PDP |
| `db:backup` | 02:00 щодня | `pg_dump` → R2, ротація 30 днів |
| `email:send` | черга | Усі листи через pg-boss, з ретраями |

Листи ніколи не надсилаються синхронно в HTTP-запиті. Ставляться в чергу.

---
