import { z } from 'zod';

import { money, type Money } from '../money';

/** Сума в копійках у JSON — ціле число; на виході типізована як Money. */
export const moneyDto = z
  .number()
  .int()
  .transform((n): Money => money(n));
