/**
 * П'ять промокодів різних типів (PROMO_CODES.md): відсоток із лімітом,
 * фіксована сума з мінімумом, безкоштовна доставка, категорійний і
 * прострочений — щоб адмінка й checkout бачили всі гілки.
 */
import { sql } from 'drizzle-orm';

import { promoCodes } from '../src/schema.ts';
import type { Tx } from '../src/types.ts';

export interface SeedPromo {
  id: string;
  code: string;
  /** Відсоток для percent, копійки для fixed. */
  type: 'percent' | 'fixed' | 'free_shipping';
  value: number;
}

export async function seedPromoCodes(tx: Tx, bras: string): Promise<SeedPromo[]> {
  const rows = await tx
    .insert(promoCodes)
    .values([
      {
        code: 'WELCOME10',
        description: 'Мінус 10% на перше замовлення, максимум 500 ₴',
        type: 'percent',
        value: 10,
        maxDiscountAmount: 50000,
        firstOrderOnly: true,
        perCustomerLimit: 1,
      },
      {
        code: 'MINUS200',
        description: 'Мінус 200 ₴ від 1500 ₴',
        type: 'fixed',
        value: 20000,
        minOrderTotal: 150000,
        maxUses: 100,
      },
      {
        code: 'FREESHIP',
        description: 'Безкоштовна доставка',
        type: 'free_shipping',
        value: 0,
      },
      {
        code: 'BRAS15',
        description: 'Мінус 15% на бюстгальтери',
        type: 'percent',
        value: 15,
        scope: 'category',
        scopeCategoryId: bras,
        excludesDiscountedItems: true,
      },
      {
        code: 'SUMMER20',
        description: 'Літня акція — завершена',
        type: 'percent',
        value: 20,
        startsAt: sql`now() - interval '120 days'`,
        endsAt: sql`now() - interval '30 days'`,
      },
    ])
    .returning({
      id: promoCodes.id,
      code: promoCodes.code,
      type: promoCodes.type,
      value: promoCodes.value,
    });
  return rows;
}
