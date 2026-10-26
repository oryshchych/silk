/**
 * 10 відгуків: 8 схвалених, 2 на модерації. Спершу — від тих, хто справді
 * отримав товар; агрегати товару (rating_avg, fit_*) рахуються з
 * СХВАЛЕНИХ відгуків, а не вигадуються (data-model §5).
 */
import { sql } from 'drizzle-orm';

import { reviews } from '../src/schema.ts';
import type { Tx } from '../src/types.ts';
import type { SeedCustomer } from './customers.ts';
import type { SeedPurchase } from './orders.ts';
import type { Rng } from './random.ts';

const TOTAL = 10;
const PENDING = 2;

const TEXTS = [
  ['Дуже зручно', 'Сідає ідеально, тканина приємна до тіла.'],
  ['Гарна якість', 'Шви акуратні, після прання не розтягнулося.'],
  ['Рекомендую', 'Колір як на фото, доставка швидка.'],
  ['Трохи замало', 'Беріть на розмір більше, якщо між розмірами.'],
  ['Неймовірно м’яко', 'Ношу щодня, купуватиму ще.'],
] as const;

const FIT = ['small', 'true_to_size', 'true_to_size', 'true_to_size', 'large'] as const;

export async function seedReviews(
  tx: Tx,
  rng: Rng,
  purchases: SeedPurchase[],
  people: SeedCustomer[],
  productIds: string[],
): Promise<void> {
  const seen = new Set<string>();
  const pairs: {
    productId: string;
    customerId: string;
    orderId: string | null;
    size: string | null;
  }[] = [];

  for (const p of purchases.filter((x) => x.delivered)) {
    const key = `${p.productId}:${p.customerId}`;
    if (seen.has(key) || pairs.length >= TOTAL) continue;
    seen.add(key);
    pairs.push({
      productId: p.productId,
      customerId: p.customerId,
      orderId: p.orderId,
      size: p.sizeLabel,
    });
  }
  // Добираємо відгуками без замовлення (купували офлайн / до запуску сайту).
  while (pairs.length < TOTAL) {
    const productId = rng.pick(productIds);
    const customerId = rng.pick(people).id;
    const key = `${productId}:${customerId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ productId, customerId, orderId: null, size: null });
  }

  await tx.insert(reviews).values(
    pairs.map((p, i) => {
      const [title, body] = TEXTS[i % TEXTS.length] ?? TEXTS[0];
      return {
        productId: p.productId,
        customerId: p.customerId,
        orderId: p.orderId,
        rating: rng.int(3, 5),
        title,
        body,
        sizeBought: p.size,
        fitFeedback: rng.pick(FIT),
        isApproved: i < TOTAL - PENDING,
        createdAt: sql`now() - make_interval(days => ${i})`,
      };
    }),
  );

  await tx.execute(sql`
    UPDATE products p
       SET rating_avg      = s.avg,
           reviews_count   = s.cnt,
           fit_true_count  = s.fit_true,
           fit_total_count = s.fit_total
      FROM (SELECT product_id,
                   avg(rating)::real AS avg,
                   count(*)::int AS cnt,
                   (count(*) FILTER (WHERE fit_feedback = 'true_to_size'))::int AS fit_true,
                   count(fit_feedback)::int AS fit_total
              FROM reviews WHERE is_approved GROUP BY product_id) s
     WHERE p.id = s.product_id`);
}
