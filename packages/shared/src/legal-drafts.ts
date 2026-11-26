/**
 * DRAFT: NEEDS A LAWYER. Neutral starting texts for the legal and static pages, in Ukrainian and English.
 *
 * These are SITE CONTENT, not legal advice. They state no company facts (no legal entity, tax id, address,
 * phone: those come from `settings.company` and `settings.contacts` and show as "not set" until filled in)
 * and they are never published by themselves: the admin creates a DRAFT from a template, a person with
 * `legal.publish` reviews it (with a lawyer) and publishes it. Every text opens with a visible
 * "Draft: needs a lawyer" line, so a page shown before the real text exists is never presented as final.
 * The owner replaces each text with the lawyer's version as a NEW version (old versions stay): owner queue Q77.
 */
import type { LegalKind, LegalLocale } from './legal';

export interface LegalDraft {
  title: string;
  /** The Markdown subset of `./rich-text`. */
  source: string;
}

const NOTICE: Record<LegalLocale, string> = {
  uk: '**Чернетка: потребує юриста.** Цей текст є нейтральним шаблоном і не є остаточним.',
  en: '**Draft: needs a lawyer.** This text is a neutral template and is not final.',
};

const BODY: Record<LegalKind, Record<LegalLocale, LegalDraft>> = {
  terms: {
    uk: {
      title: 'Умови оферти',
      source: `## Загальні положення

Ці умови описують порядок замовлення товарів в інтернет-магазині. Оформлюючи замовлення, покупець підтверджує, що ознайомився з цими умовами та з політикою конфіденційності.

## Замовлення й ціна

Ціни й наявність товарів показані на сторінках магазину. Остаточна сума замовлення показується на етапі оформлення, до оплати.

## Оплата й доставка

Способи оплати та доставки описані на сторінці «Доставка й оплата».

## Обмін і повернення

Порядок обміну та повернення описано на сторінці «Обмін і повернення».`,
    },
    en: {
      title: 'Terms of the offer',
      source: `## General

These terms describe how goods are ordered in the online shop. By placing an order the buyer confirms that they have read these terms and the privacy policy.

## Orders and prices

Prices and availability are shown on the shop's pages. The final order total is shown at checkout, before payment.

## Payment and delivery

The payment and delivery methods are described on the "Delivery and payment" page.

## Exchange and returns

The exchange and return procedure is described on the "Returns and exchange" page.`,
    },
  },
  privacy: {
    uk: {
      title: 'Політика конфіденційності',
      source: `## Які дані ми збираємо

Для виконання замовлення ми обробляємо ім'я, контактний телефон, електронну адресу та адресу доставки. Для облікового запису додатково зберігається електронна адреса та захищений пароль.

## Навіщо ми їх використовуємо

Дані потрібні для оформлення, оплати, доставки замовлення та зв'язку з покупцем щодо нього.

## Права покупця

Покупець може звернутися до магазину із запитом про доступ до своїх даних, їх виправлення або видалення. Контакти зазначені на сторінці «Контакти».`,
    },
    en: {
      title: 'Privacy policy',
      source: `## What data we collect

To fulfil an order we process the name, contact phone number, e-mail address and delivery address. For an account we also keep the e-mail address and a protected password.

## What we use it for

The data is needed to place, pay for and deliver the order and to contact the buyer about it.

## The buyer's rights

The buyer may ask the shop for access to their data, for its correction or for its deletion. Contact details are on the "Contacts" page.`,
    },
  },
  delivery_payment: {
    uk: {
      title: 'Доставка й оплата',
      source: `## Доставка

Замовлення доставляється по Україні службами доставки, доступними під час оформлення (наприклад, відділення чи поштомат перевізника). Вартість доставки показується під час оформлення замовлення.

## Оплата

Доступні способи оплати показані під час оформлення замовлення. Статус оплати змінюється лише після підтвердження від платіжного сервісу.

## Відстеження

Статус замовлення можна переглянути на сторінці відстеження за номером замовлення.`,
    },
    en: {
      title: 'Delivery and payment',
      source: `## Delivery

Orders are delivered across Ukraine by the delivery services offered at checkout (for example a carrier's branch or parcel locker). The delivery cost is shown when the order is placed.

## Payment

The available payment methods are shown at checkout. The payment status changes only after the payment service confirms it.

## Tracking

The status of an order can be viewed on the tracking page using the order number.`,
    },
  },
  returns: {
    uk: {
      title: 'Обмін і повернення',
      source: `## Загальні правила

Відповідно до законодавства України (Постанова Кабінету Міністрів України № 172 від 19 березня 1994 року) натільна білизна та панчішно-шкарпеткові вироби належної якості обміну й поверненню не підлягають.

## Товар неналежної якості

Якщо товар має дефект, не відповідає опису або надіслано не той товар, покупець може подати запит на повернення в особистому кабінеті протягом строку, зазначеного в короткому викладі вище. Кожен запит розглядає менеджер.

## Як подати запит

Запит подається в особистому кабінеті для доставлених замовлень. Гроші повертаються після того, як магазин отримав товар.`,
    },
    en: {
      title: 'Returns and exchange',
      source: `## General rules

Under the legislation of Ukraine (Resolution No. 172 of the Cabinet of Ministers of Ukraine of 19 March 1994) underwear and hosiery of proper quality are not subject to exchange or return.

## Goods of improper quality

If an item is defective, does not match its description or the wrong item was sent, the buyer may submit a return request in their account within the period stated in the summary above. A manager reviews each request.

## How to submit a request

A request is submitted in the account for delivered orders. The money is refunded after the shop has received the goods.`,
    },
  },
  about: {
    uk: {
      title: 'Про нас',
      source: `Ми продаємо оригінальну жіночу білизну та домашній одяг із доставкою по Україні.

Магазин є офіційним роздрібним продавцем продукції, представленої на сайті. Назви брендів належать їхнім власникам.`,
    },
    en: {
      title: 'About us',
      source: `We sell original women's lingerie and homewear with delivery across Ukraine.

The shop is a retail seller of the products shown on the site. Brand names belong to their owners.`,
    },
  },
  faq: {
    uk: {
      title: 'Часті запитання',
      source: `## Як оформити замовлення?

Додайте товари до кошика й перейдіть до оформлення: виберіть спосіб доставки та оплати й підтвердіть замовлення.

## Як дізнатися, де моє замовлення?

Відкрийте сторінку відстеження й введіть номер замовлення.

## Чи можна повернути білизну?

Умови обміну й повернення описані на сторінці «Обмін і повернення».

## Як зв'язатися з магазином?

Контакти зазначені на сторінці «Контакти».`,
    },
    en: {
      title: 'FAQ',
      source: `## How do I place an order?

Add items to the cart and go to checkout: choose the delivery and payment methods and confirm the order.

## How do I find out where my order is?

Open the tracking page and enter the order number.

## Can underwear be returned?

The exchange and return terms are described on the "Returns and exchange" page.

## How do I contact the shop?

Contact details are on the "Contacts" page.`,
    },
  },
  contacts: {
    uk: {
      title: 'Контакти',
      source: "Зв'язатися з магазином можна за контактами нижче.",
    },
    en: {
      title: 'Contacts',
      source: 'You can reach the shop using the contact details below.',
    },
  },
};

/** The draft template of a document in a language, opening with the visible "needs a lawyer" notice. */
export function legalDraft(kind: LegalKind, locale: LegalLocale): LegalDraft {
  const body = BODY[kind][locale];
  return { title: body.title, source: `${NOTICE[locale]}\n\n${body.source}` };
}
