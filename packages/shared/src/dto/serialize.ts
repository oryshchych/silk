/**
 * DTO — ЯВНИЙ перелік полів, що виходять за межі сервера (AGENTS.md §4b.3).
 *
 * zod `z.object` за замовчуванням ВІДКИДАЄ невідомі ключі, і саме це робить
 * схему allowlist'ом: `cost_price`, `unit_cost_snapshot` у вкладених
 * позиціях, `admin_note` не пройдуть, навіть якщо їх передали. Тому в
 * `dto/` заборонені `looseObject`, `.passthrough()` і `.catchall()`
 * (лінт-правило), а відповідь формується лише через `serialize`.
 */
import type { z } from 'zod';

export function serialize<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  return schema.parse(value);
}
