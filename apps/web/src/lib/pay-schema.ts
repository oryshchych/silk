import { z } from 'zod';

/**
 * `z.literal([...])` compares against the listed values only. `z.enum` looks a name up in an
 * object, so `__proto__`, `constructor` or `toString` pass it and fail much later (a database
 * enum error, or a truthy lookup in a settings map): every closed set from outside uses this.
 */
export const oneOf = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.literal([...values]);

export const payInputSchema = z.object({
  locale: oneOf(['uk', 'en']),
  provider: oneOf(['mono', 'wayforpay']),
});
