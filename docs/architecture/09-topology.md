## 11. Продакшн-топологія

```
Cloudflare (DNS, CDN, WAF, SSL)
   │
Hetzner CX22 · Dokploy
   ├─ caddy         (reverse proxy, автосертифікати)
   ├─ web           (Next.js, standalone build)
   ├─ worker        (pg-boss)
   ├─ postgres 16   (volume + щоденний dump у R2)
   └─ umami         (опційно)

Зовні: Cloudflare R2 (медіа + бекапи) · Resend · Mono · WayForPay · Нова Пошта · Sentry
```

Два стеки: `staging` і `production`, різні БД, різні ключі платіжок (sandbox/live).

Бекапи: **безперервне архівування WAL** через pgBackRest або WAL-G у R2, плюс
щоденний повний бекап і **перевірене відновлення** раз на місяць.

Щоденного `pg_dump` **недостатньо**: він дає RPO до 24 годин. Для магазину, що
приймає платежі, це означає сценарій «диск на ноді Hetzner помер о 23:00 →
втрачено день замовлень, а гроші в еквайрі є, і зв'язок замовлень із
фіскальними чеками зник». Архівування WAL дає point-in-time recovery з RPO у
хвилини.

Бекап, який ніколи не розвертали, не існує.

---
