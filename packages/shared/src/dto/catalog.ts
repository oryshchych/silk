/**
 * Публічна картка товару (PLP, пошук). Собівартість, чернетки, службові
 * лічильники сюди не потрапляють за побудовою: їх немає в схемі.
 */
import { z } from 'zod';

import { moneyDto } from './money';

export const productBadgeValues = ['none', 'new', 'sale', 'bestseller', 'last_units'] as const;

export const productCardDto = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  brand: z.string(),
  price: moneyDto,
  compareAtPrice: moneyDto.nullable(),
  badge: z.enum(productBadgeValues),
  ratingAvg: z.number().min(1).max(5).nullable(),
  reviewsCount: z.number().int().nonnegative(),
  inStock: z.boolean(),
});

export type ProductCardDto = z.output<typeof productCardDto>;
