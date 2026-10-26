/**
 * Гроші — цілі копійки (ADR-1). `1299.00 ₴` === `money(129900)`.
 *
 * Brand забороняє передати сирий `number` туди, де очікується `Money`, але
 * НЕ забороняє оператори: `m / 3` компілюється. Тому:
 *  - кожна операція повертає результат через конструктор із перевіркою;
 *  - відсотки — окрема функція з ЯВНИМ режимом округлення;
 *  - `+ - * / %` над `Money` поза цим файлом ловить лінт-правило
 *    `money/no-arithmetic` (eslint-rules/money.js).
 */

declare const moneyBrand: unique symbol;

/** Копійки. Може бути від'ємним: коригування, повернення. */
export type Money = number & { readonly [moneyBrand]: 'Money' };

/** Максимум колонки `integer` у Postgres (≈ 21,4 млн ₴). */
const PG_INT_MAX = 2_147_483_647;

export function money(kopiyky: number): Money {
  if (!Number.isSafeInteger(kopiyky)) {
    throw new RangeError(`Money — лише цілі копійки, отримано ${String(kopiyky)}`);
  }
  // Єдине місце, де number стає Money: перевірка вище й є причиною існування brand.
  return kopiyky as Money;
}

export const ZERO: Money = money(0);

export const add = (a: Money, b: Money): Money => money(a + b);
export const subtract = (a: Money, b: Money): Money => money(a - b);
export const sum = (items: readonly Money[]): Money => items.reduce(add, ZERO);

/** Ціна × кількість. Кількість — лише ціле число. */
export function multiply(a: Money, quantity: number): Money {
  if (!Number.isSafeInteger(quantity)) {
    throw new RangeError(`кількість має бути цілою, отримано ${String(quantity)}`);
  }
  return money(a * quantity);
}

export type Rounding = 'floor' | 'half-up';

/**
 * Відсоток від суми з явним округленням. 15% від 19 999 = 2 999,85 копійки —
 * рішення про округлення мусить бути прийняте тут, до запису (ADR-1).
 * `percent` — ціле 0..100 (як `promo_codes.value`).
 */
export function percentOf(a: Money, percent: number, rounding: Rounding): Money {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new RangeError(`відсоток має бути цілим 0..100, отримано ${String(percent)}`);
  }
  const scaled = a * percent; // точне ціле: a — копійки, percent — ціле
  const whole = Math.trunc(scaled / 100);
  const rest = scaled - whole * 100;
  if (rounding === 'floor' || rest === 0)
    return money(scaled < 0 && rest !== 0 ? whole - 1 : whole);
  const up = Math.abs(rest) >= 50;
  return money(up ? whole + Math.sign(scaled) : whole);
}

/**
 * Розподіл суми пропорційно вагам методом найбільшого залишку (ADR-15).
 *
 *  1. Кожна частка — floor від ідеальної.
 *  2. Залишок роздається ПО ОДНІЙ копійці позиціям із найбільшою дробовою
 *     частиною; рівні — за індексом (стабільно й відтворювано).
 *  3. Частка ніколи не перевищує вагу, якщо total ≤ сума ваг.
 *
 * НЕ «залишок на найдорожчу позицію»: на цінах 1000, 999, 998 і знижці 2996
 * це дає знижку 1001 при ціні 1000.
 */
export function allocate(total: Money, weights: readonly Money[]): Money[] {
  if (total < 0) throw new RangeError('розподіляється лише невід’ємна сума');
  if (weights.some((w) => w < 0)) throw new RangeError('ваги мають бути невід’ємними');
  const weightSum = weights.reduce((acc, w) => acc + w, 0);
  if (weights.length === 0 || weightSum === 0) {
    if (total === 0) return weights.map(() => ZERO);
    throw new RangeError('немає ваг для розподілу ненульової суми');
  }
  if (total > weightSum) throw new RangeError('сума для розподілу більша за суму ваг');

  // BigInt: total × weight може вийти за 2^53 на великих сумах.
  const t = BigInt(total);
  const s = BigInt(weightSum);
  const shares = weights.map((w, index) => {
    const exact = t * BigInt(w);
    return { index, floor: exact / s, remainder: exact % s };
  });
  let left = t - shares.reduce((acc, x) => acc + x.floor, 0n);
  const order = [...shares].sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  const extra = new Set<number>();
  for (const share of order) {
    if (left === 0n) break;
    extra.add(share.index);
    left -= 1n;
  }
  return shares.map((x) => money(Number(x.floor) + (extra.has(x.index) ? 1 : 0)));
}

/** Перевірка перед записом у колонку `integer` (ADR-1, п. 4). */
export function assertFitsPgInteger(a: Money): Money {
  if (a > PG_INT_MAX || a < -PG_INT_MAX - 1) {
    throw new RangeError(`сума ${String(a)} не вміщується в integer Postgres`);
  }
  return a;
}

/**
 * Розбір гривень із рядка БЕЗ parseFloat (AGENTS.md §2.1): «1299», «1299.5»,
 * «1 299,50». Більше двох знаків після коми — помилка, а не округлення.
 */
export function parseHryvnias(input: string): Money {
  const normalized = input.replace(/[\s ]/g, '').replace(',', '.');
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(normalized);
  if (match === null) throw new RangeError(`не сума в гривнях: «${input}»`);
  const [, sign = '', whole = '0', fraction = ''] = match;
  const kopiyky = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return money(sign === '-' ? -kopiyky : kopiyky);
}

export type MoneyLocale = 'uk' | 'en';

const formatters: Record<MoneyLocale, Intl.NumberFormat> = {
  uk: new Intl.NumberFormat('uk-UA', { style: 'currency', currency: 'UAH' }),
  en: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'UAH' }),
};

/** Відображення. Округлення тут не відбувається: копійки ділимо точно на 100. */
export function formatMoney(a: Money, locale: MoneyLocale): string {
  return formatters[locale].format(a / 100);
}
