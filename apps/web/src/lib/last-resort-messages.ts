/**
 * The few strings the last-resort pages (`global-error`, `global-not-found`) need, in both languages.
 * They live here, not imported from `messages/*.json`: those files are whole message trees, and a
 * page that imports them ships the WHOLE tree (every admin label included) as a public script chunk.
 * `last-resort-messages.unit.test.ts` fails when a value drifts from the message files.
 */
const uk = {
  errors: {
    backHome: 'На головну',
    errorTitle: 'Щось пішло не так',
    notFoundText: 'Такої сторінки немає або її було переміщено.',
    notFoundTitle: 'Сторінку не знайдено',
    retry: 'Спробувати ще раз',
  },
  footer: {
    trademark:
      'Усі торгові марки та назви брендів належать їхнім законним власникам і використовуються на сайті лише для ідентифікації товарів.',
  },
} as const;

const en = {
  errors: {
    backHome: 'Back to home',
    errorTitle: 'Something went wrong',
    notFoundText: 'This page does not exist or has been moved.',
    notFoundTitle: 'Page not found',
    retry: 'Try again',
  },
  footer: {
    trademark:
      'All trademarks and brand names belong to their respective owners and are used on this site only to identify products.',
  },
} as const;

export { en, uk };
