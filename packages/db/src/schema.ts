/**
 * packages/db/src/schema.ts
 *
 * Домен магазину білизни. PostgreSQL 16 + Drizzle.
 *
 * КОНВЕНЦІЇ
 *  - Гроші: integer, копійки. 1299.00 ₴ === 129900. Ніде немає float.
 *  - Локалізація: пари колонок *_uk / *_en. Дві мови, фіксовано (див. ADR-2).
 *  - Часові поля: timestamptz, завжди UTC.
 *  - Інваріанти виражені CHECK/UNIQUE у схемі, а не перевірками в застосунку.
 *  - Розширення (створити в першій міграції):
 *      CREATE EXTENSION IF NOT EXISTS pg_trgm;
 *      CREATE EXTENSION IF NOT EXISTS unaccent;
 *      CREATE EXTENSION IF NOT EXISTS btree_gin;
 */

import {
  pgTable, pgEnum, uuid, text, varchar, integer, smallint, boolean,
  timestamp, date, jsonb, index, uniqueIndex, primaryKey, check, real,
  customType,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

/* ─────────────────────────── допоміжні типи ─────────────────────────── */

/** tsvector для повнотекстового пошуку (generated column, заповнюється тригером/GENERATED ALWAYS) */
const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
});

/** Гроші. Завжди копійки. Тип-обгортка Money живе в packages/shared/money.ts */
const money = (name: string) => integer(name);

/**
 * PK для довідників і рідко вставлюваних таблиць.
 *
 * Для таблиць із високим темпом вставки (orders, order_items,
 * payment_events, gift_card_transactions, product_views, outbox)
 * використовувати `hotId()` — uuidv4 фрагментує B-tree, бо вставки йдуть
 * у випадкові місця індексу.
 */
const id = () => uuid('id').primaryKey().defaultRandom();

/** PostgreSQL 18: timestamp-ordered UUID. Вставки йдуть у кінець індексу */
const hotId = () => uuid('id').primaryKey().default(sql`uuidv7()`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/* ────────────────────────────── enum'и ──────────────────────────────── */

export const sizeSystemEnum = pgEnum('size_system', ['bra', 'panty', 'apparel', 'onesize']);
export const badgeEnum = pgEnum('product_badge', ['none', 'new', 'sale', 'bestseller', 'last_units']);
export const attributeTypeEnum = pgEnum('attribute_type', ['select', 'multiselect', 'boolean', 'text']);

/**
 * Тип товару. `gift_card` продається як звичайний товар (є картка, ціна,
 * варіанти-номінали), але НЕ має залишку, ваги й доставки, а при оплаті
 * випускає рядок у `gift_cards` (ADR-20).
 */
export const productKindEnum = pgEnum('product_kind', ['physical', 'gift_card']);

/** Фулфілмент. Окремо від грошей — див. ARCHITECTURE §7 */
export const orderStatusEnum = pgEnum('order_status', [
  'pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'returned',
]);

/** Гроші. Окремо від фулфілменту */
export const paymentStatusEnum = pgEnum('payment_status', [
  'pending', 'authorized', 'paid', 'failed', 'expired', 'refunded', 'partially_refunded',
]);

/**
 * Стан операції із зовнішнім ефектом (платіж, повернення, ТТН, чек).
 *
 * ОГОЛОШЕНО ТУТ СВІДОМО: раніше цей enum стояв нижче за таблиці, які його
 * використовують. `pgEnum(...)` викликається під час створення таблиці, це
 * не відкладений callback як `.references(() => ...)`, тому TypeScript
 * давав TS2448 і файл схеми взагалі не компілювався.
 */
export const operationStateEnum = pgEnum('operation_state', [
  'pending',    // створено локально, зовнішній виклик ще не зроблено
  'in_flight',  // виклик зроблено, відповіді немає
  'succeeded',
  'failed',
  'unknown',    // таймаут: результат НЕВІДОМИЙ. Потребує звірки, не повтору
]);

export const paymentProviderEnum = pgEnum('payment_provider', [
  'mono', 'wayforpay', 'cod', 'bank_transfer',
  /** Сертифікат — це СПОСІБ ОПЛАТИ, не знижка (ADR-20) */
  'gift_card',
]);

/** Стан фіскального чека (ADR-16). Пробивається асинхронно, після оплати */
export const fiscalStatusEnum = pgEnum('fiscal_status', [
  'not_required',   // до відповіді на відкрите питання №1, або COD із чеком у кур'єра
  'pending',        // у черзі
  'issued',
  'failed',         // вичерпані ретраї — потрібне ручне втручання
  'refund_issued',
]);

export const deliveryMethodEnum = pgEnum('delivery_method', [
  'np_warehouse',   // відділення / поштомат Нової Пошти
  'np_courier',     // адресна доставка Нової Пошти
  'ukrposhta',
  'pickup',         // самовивіз
]);

export const promoTypeEnum = pgEnum('promo_type', ['percent', 'fixed', 'free_shipping']);
export const promoScopeEnum = pgEnum('promo_scope', ['all', 'category', 'product']);
export const fitFeedbackEnum = pgEnum('fit_feedback', ['small', 'true_to_size', 'large']);
export const adminRoleEnum = pgEnum('admin_role', ['owner', 'admin', 'manager', 'content']);
export const relationKindEnum = pgEnum('relation_kind', ['similar', 'cross_sell', 'up_sell', 'accessory']);
export const npWarehouseTypeEnum = pgEnum('np_warehouse_type', ['branch', 'postomat', 'cargo']);

/* ═══════════════════════════ КАТАЛОГ ═══════════════════════════ */

export const categories = pgTable('categories', {
  id: id(),
  parentId: uuid('parent_id').references((): any => categories.id, { onDelete: 'restrict' }),
  slug: varchar('slug', { length: 160 }).notNull(),
  nameUk: varchar('name_uk', { length: 200 }).notNull(),
  nameEn: varchar('name_en', { length: 200 }).notNull(),
  descriptionUk: text('description_uk'),
  descriptionEn: text('description_en'),
  /** SEO-текст під списком товарів. Rich text, санітизований при збереженні */
  seoTextUk: text('seo_text_uk'),
  seoTextEn: text('seo_text_en'),
  imageUrl: text('image_url'),
  /** Основна система розмірів категорії — визначає, які фільтри показувати */
  sizeSystem: sizeSystemEnum('size_system'),
  depth: smallint('depth').notNull().default(0),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  metaTitleUk: varchar('meta_title_uk', { length: 200 }),
  metaTitleEn: varchar('meta_title_en', { length: 200 }),
  metaDescriptionUk: varchar('meta_description_uk', { length: 400 }),
  metaDescriptionEn: varchar('meta_description_en', { length: 400 }),
  noindex: boolean('noindex').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('categories_slug_uq').on(t.slug),
  index('categories_parent_idx').on(t.parentId, t.sortOrder),
  index('categories_active_idx').on(t.isActive),
  check('categories_no_self_parent', sql`${t.parentId} IS NULL OR ${t.parentId} <> ${t.id}`),
  check('categories_depth_range', sql`${t.depth} BETWEEN 0 AND 3`),
]);

export const colors = pgTable('colors', {
  id: id(),
  slug: varchar('slug', { length: 80 }).notNull(),
  nameUk: varchar('name_uk', { length: 80 }).notNull(),
  nameEn: varchar('name_en', { length: 80 }).notNull(),
  hex: varchar('hex', { length: 7 }).notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
}, (t) => [
  uniqueIndex('colors_slug_uq').on(t.slug),
  check('colors_hex_format', sql`${t.hex} ~ '^#[0-9A-Fa-f]{6}$'`),
]);

/**
 * Розміри. band/cup окремими колонками, щоб фільтр «обхват 75» і фільтр
 * «чашка B» працювали незалежно, без парсингу label у запиті.
 */
export const sizes = pgTable('sizes', {
  id: id(),
  system: sizeSystemEnum('system').notNull(),
  /** Те, що бачить покупець: '75B', 'M', 'XL', 'One size' */
  label: varchar('label', { length: 20 }).notNull(),
  /** Обхват під грудьми. Лише для system = 'bra' */
  band: smallint('band'),
  /** Чашка: 'A'..'DDD'. Лише для system = 'bra' */
  cup: varchar('cup', { length: 4 }),
  euLabel: varchar('eu_label', { length: 20 }),
  usLabel: varchar('us_label', { length: 20 }),
  sortOrder: integer('sort_order').notNull().default(0),
}, (t) => [
  uniqueIndex('sizes_system_label_uq').on(t.system, t.label),
  index('sizes_band_cup_idx').on(t.band, t.cup),
  /** Бюстгальтер без обхвату або чашки — не бюстгальтер. Тримає БД */
  check('sizes_bra_has_band_cup', sql`
    (${t.system} <> 'bra') OR (${t.band} IS NOT NULL AND ${t.cup} IS NOT NULL)
  `),
  /** І навпаки: band/cup не мають сенсу поза системою bra */
  check('sizes_band_cup_only_bra', sql`
    (${t.system} = 'bra') OR (${t.band} IS NULL AND ${t.cup} IS NULL)
  `),
  check('sizes_band_range', sql`${t.band} IS NULL OR ${t.band} BETWEEN 60 AND 110`),
]);

export const products = pgTable('products', {
  id: id(),
  sku: varchar('sku', { length: 64 }).notNull(),
  slug: varchar('slug', { length: 200 }).notNull(),
  /** Бренд як АТРИБУТ товару, не бренд сайту. Реселлерська модель */
  brand: varchar('brand', { length: 120 }).notNull(),
  kind: productKindEnum('kind').notNull().default('physical'),
  categoryId: uuid('category_id').notNull().references(() => categories.id, { onDelete: 'restrict' }),

  nameUk: varchar('name_uk', { length: 300 }).notNull(),
  nameEn: varchar('name_en', { length: 300 }).notNull(),
  shortDescriptionUk: varchar('short_description_uk', { length: 500 }),
  shortDescriptionEn: varchar('short_description_en', { length: 500 }),
  descriptionUk: text('description_uk'),
  descriptionEn: text('description_en'),
  compositionUk: text('composition_uk'),
  compositionEn: text('composition_en'),
  careUk: text('care_uk'),
  careEn: text('care_en'),

  /** Базова ціна в копійках. Може перекриватись на рівні варіанта */
  basePrice: money('base_price').notNull(),
  /** Перекреслена «до знижки». NULL = без знижки */
  compareAtPrice: money('compare_at_price'),
  /** Собівартість. НІКОЛИ не входить у публічні селекти. Лише owner/admin */
  costPrice: money('cost_price'),

  /**
   * Для розрахунку доставки й формування ТТН.
   * Для kind='gift_card' допускається 0 — сертифікат не має ваги й доставки.
   * CHECK нижче гарантує, що фізичний товар вагу має.
   */
  weightGrams: integer('weight_grams').notNull().default(200),

  /**
   * Код УКТЗЕД. Потрібен для фіскального чека (ПРРО) — деякі провайдери
   * чеків вимагають його для всіх позицій, деякі лише для окремих категорій.
   * УТОЧНИТИ В БУХГАЛТЕРА (відкрите питання №1 у PLAN.md), а не вгадувати.
   * Nullable, бо до відповіді заповнювати нічим.
   */
  uktzedCode: varchar('uktzed_code', { length: 20 }),

  isActive: boolean('is_active').notNull().default(false),
  isFeatured: boolean('is_featured').notNull().default(false),
  badge: badgeEnum('badge').notNull().default('none'),

  /** Денормалізовані агрегати. Оновлюються при модерації відгуку */
  ratingAvg: real('rating_avg'),
  reviewsCount: integer('reviews_count').notNull().default(0),
  fitTrueCount: integer('fit_true_count').notNull().default(0),
  fitTotalCount: integer('fit_total_count').notNull().default(0),

  metaTitleUk: varchar('meta_title_uk', { length: 200 }),
  metaTitleEn: varchar('meta_title_en', { length: 200 }),
  metaDescriptionUk: varchar('meta_description_uk', { length: 400 }),
  metaDescriptionEn: varchar('meta_description_en', { length: 400 }),
  ogImageUrl: text('og_image_url'),
  noindex: boolean('noindex').notNull().default(false),

  /**
   * Пошуковий вектор. ЗВИЧАЙНА колонка, заповнюється тригером.
   *
   * НЕ `GENERATED ALWAYS`: generated column вимагає IMMUTABLE-виразу, а
   * `unaccent()` оголошений STABLE (залежить від словника, який можна
   * змінити). Той самий аргумент стосується `to_tsvector` з кастомною
   * конфігурацією `ukrainian`. Спроба зробити це generated-колонкою просто
   * не пройде міграцію.
   *
   * Бонус тригера: словник можна змінити без DROP/ADD колонки й
   * переіндексації всієї таблиці — достатньо backfill.
   */
  searchVector: tsvector('search_vector'),

  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('products_slug_uq').on(t.slug),
  uniqueIndex('products_sku_uq').on(t.sku),
  index('products_catalog_idx').on(t.categoryId, t.isActive, t.publishedAt),
  index('products_brand_idx').on(t.brand),
  index('products_featured_idx').on(t.isFeatured).where(sql`${t.isFeatured} = true`),
  index('products_search_idx').using('gin', t.searchVector),
  // ПРИБРАНО index на сирому name_uk із gin_trgm_ops.
  // Запит шукає по search_norm (нормалізований, lower), тому індекс на
  // сирій колонці НЕ використовувався б планувальником — лишався б лише
  // коштом на кожну вставку. Індекс на search_norm створюється в блоці
  // додаткового SQL нижче, разом із самою колонкою.
  check('products_price_positive', sql`${t.basePrice} > 0`),
  check('products_compare_gt_price', sql`
    ${t.compareAtPrice} IS NULL OR ${t.compareAtPrice} > ${t.basePrice}
  `),
  check('products_cost_nonneg', sql`${t.costPrice} IS NULL OR ${t.costPrice} >= 0`),
  /**
   * Було `weight_grams > 0` беззастережно — суперечило kind='gift_card',
   * у якого ваги немає. Тепер вага обов'язкова лише для фізичного товару.
   */
  check('products_weight_by_kind', sql`
    (${t.kind} <> 'physical' AND ${t.weightGrams} >= 0)
    OR (${t.kind} = 'physical' AND ${t.weightGrams} > 0)
  `),
  check('products_rating_range', sql`${t.ratingAvg} IS NULL OR ${t.ratingAvg} BETWEEN 1 AND 5`),
]);

export const productImages = pgTable('product_images', {
  id: id(),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  /** Прив'язка до кольору — при виборі свотча показуються відповідні фото */
  colorId: uuid('color_id').references(() => colors.id, { onDelete: 'set null' }),
  url: text('url').notNull(),
  /** Готові ресайзи, згенеровані sharp при завантаженні: { thumb, card, full } × { webp, avif } */
  variants: jsonb('variants').$type<Record<string, string>>(),
  altUk: varchar('alt_uk', { length: 300 }),
  altEn: varchar('alt_en', { length: 300 }),
  width: integer('width'),
  height: integer('height'),
  sortOrder: integer('sort_order').notNull().default(0),
}, (t) => [
  index('product_images_product_idx').on(t.productId, t.sortOrder),
  index('product_images_color_idx').on(t.productId, t.colorId),
]);

/**
 * Варіант = конкретна комбінація розмір × колір. Саме тут живуть залишки.
 * available = stock_quantity - reserved_quantity (ADR-3)
 */
export const productVariants = pgTable('product_variants', {
  id: id(),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  sizeId: uuid('size_id').notNull().references(() => sizes.id, { onDelete: 'restrict' }),
  colorId: uuid('color_id').notNull().references(() => colors.id, { onDelete: 'restrict' }),
  sku: varchar('sku', { length: 64 }).notNull(),
  barcode: varchar('barcode', { length: 64 }),
  /** NULL = використовується products.base_price */
  priceOverride: money('price_override'),
  stockQuantity: integer('stock_quantity').notNull().default(0),
  /** Денормалізовано, щоб не рахувати суму резервацій на кожному читанні PLP */
  reservedQuantity: integer('reserved_quantity').notNull().default(0),
  weightGrams: integer('weight_grams'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('variants_combo_uq').on(t.productId, t.sizeId, t.colorId),
  uniqueIndex('variants_sku_uq').on(t.sku),
  index('variants_product_idx').on(t.productId),
  index('variants_size_idx').on(t.sizeId),
  index('variants_color_idx').on(t.colorId),
  index('variants_available_idx')
    .on(t.productId)
    .where(sql`${t.stockQuantity} - ${t.reservedQuantity} > 0 AND ${t.isActive} = true`),
  check('variants_stock_nonneg', sql`${t.stockQuantity} >= 0`),
  check('variants_reserved_nonneg', sql`${t.reservedQuantity} >= 0`),
  // ВІДСУТНІЙ СВІДОМО: CHECK (reserved_quantity <= stock_quantity).
  // Виглядає правильно, але створює операційний тупик: під час
  // інвентаризації адмін може виявити, що реального залишку менше, ніж
  // зарезервовано (склад порахували неправильно). З таким CHECK він фізично
  // не зможе виправити цифру, поки не скасує чужі замовлення.
  // Замість цього — воркер stock:reconcile алертить про розбіжність,
  // а рішення приймає людина.
  check('variants_price_positive', sql`${t.priceOverride} IS NULL OR ${t.priceOverride} > 0`),
]);

/* ─── гнучкі атрибути (тип чашки, push-up, тканина, рівень підтримки) ─── */

export const attributes = pgTable('attributes', {
  id: id(),
  code: varchar('code', { length: 64 }).notNull(),
  nameUk: varchar('name_uk', { length: 120 }).notNull(),
  nameEn: varchar('name_en', { length: 120 }).notNull(),
  type: attributeTypeEnum('type').notNull().default('select'),
  isFilterable: boolean('is_filterable').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
}, (t) => [uniqueIndex('attributes_code_uq').on(t.code)]);

export const attributeValues = pgTable('attribute_values', {
  id: id(),
  attributeId: uuid('attribute_id').notNull().references(() => attributes.id, { onDelete: 'cascade' }),
  slug: varchar('slug', { length: 80 }).notNull(),
  valueUk: varchar('value_uk', { length: 160 }).notNull(),
  valueEn: varchar('value_en', { length: 160 }).notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
}, (t) => [uniqueIndex('attribute_values_uq').on(t.attributeId, t.slug)]);

export const productAttributeValues = pgTable('product_attribute_values', {
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  attributeValueId: uuid('attribute_value_id').notNull().references(() => attributeValues.id, { onDelete: 'cascade' }),
}, (t) => [
  primaryKey({ columns: [t.productId, t.attributeValueId] }),
  index('pav_value_idx').on(t.attributeValueId),
]);

export const relatedProducts = pgTable('related_products', {
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  relatedId: uuid('related_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  kind: relationKindEnum('kind').notNull().default('similar'),
  sortOrder: integer('sort_order').notNull().default(0),
}, (t) => [
  primaryKey({ columns: [t.productId, t.relatedId, t.kind] }),
  check('related_not_self', sql`${t.productId} <> ${t.relatedId}`),
]);

/* ═══════════════════════════ КЛІЄНТИ ═══════════════════════════ */

export const customers = pgTable('customers', {
  id: id(),
  /**
   * FK на auth_users. Раніше тут стояло софт-посилання з обґрунтуванням
   * «таблицю створює і мігрує адаптер Auth.js» — це було НЕПРАВДОЮ:
   * Drizzle-адаптер міграцій не запускає. Auth-таблиці описані в цій же
   * схемі (див. authUsers), тому FK коректний.
   * NULL — гість, що оформив замовлення без реєстрації.
   */
  userId: uuid('user_id').references(() => authUsers.id, { onDelete: 'set null' }),
  email: varchar('email', { length: 320 }).notNull(),
  phone: varchar('phone', { length: 20 }),
  firstName: varchar('first_name', { length: 120 }),
  lastName: varchar('last_name', { length: 120 }),
  birthDate: timestamp('birth_date', { withTimezone: false }),
  acceptsMarketing: boolean('accepts_marketing').notNull().default(false),
  /** Збережені розміри → підсвітка «твій розмір» у каталозі */
  preferredBraSizeId: uuid('preferred_bra_size_id').references(() => sizes.id, { onDelete: 'set null' }),
  preferredApparelSizeId: uuid('preferred_apparel_size_id').references(() => sizes.id, { onDelete: 'set null' }),
  tags: text('tags').array(),
  adminNote: text('admin_note'),
  locale: varchar('locale', { length: 5 }).notNull().default('uk'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('customers_email_uq').on(t.email),
  uniqueIndex('customers_user_uq').on(t.userId).where(sql`${t.userId} IS NOT NULL`),
  index('customers_phone_idx').on(t.phone),
  check('customers_email_format', sql`${t.email} ~ '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'`),
]);

export const addresses = pgTable('addresses', {
  id: id(),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  recipientName: varchar('recipient_name', { length: 240 }).notNull(),
  phone: varchar('phone', { length: 20 }).notNull(),
  deliveryMethod: deliveryMethodEnum('delivery_method').notNull(),
  /** Ref з API Нової Пошти */
  settlementRef: varchar('settlement_ref', { length: 64 }),
  settlementName: varchar('settlement_name', { length: 240 }),
  warehouseRef: varchar('warehouse_ref', { length: 64 }),
  warehouseName: text('warehouse_name'),
  street: varchar('street', { length: 240 }),
  house: varchar('house', { length: 40 }),
  apartment: varchar('apartment', { length: 40 }),
  postcode: varchar('postcode', { length: 10 }),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: createdAt(),
}, (t) => [
  index('addresses_customer_idx').on(t.customerId),
  uniqueIndex('addresses_one_default_uq').on(t.customerId).where(sql`${t.isDefault} = true`),
]);

/* ═══════════════════════════ КОШИК ═══════════════════════════ */

export const carts = pgTable('carts', {
  id: id(),
  /** Гостьовий кошик: httpOnly cookie. Мерджиться в кошик клієнта при логіні */
  token: varchar('token', { length: 64 }).notNull(),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
  /**
   * Версія кошика. Інкрементується тригером на будь-яку зміну cart_items —
   * бо зміна дочірньої таблиці НЕ оновлює carts.updated_at автоматично, і
   * без цього активний покупець виглядав як «покинутий кошик».
   * Використовується checkout_intents для прив'язки до конкретного складу.
   */
  version: integer('version').notNull().default(1),
  promoCode: varchar('promo_code', { length: 64 }),
  /**
   * Зв'язок кошик → замовлення. Без нього критерій «не надсилати
   * нагадування, якщо замовлення оформлене» не забезпечувався: прапорець
   * фіксував лише факт відправлення листа.
   */
  convertedOrderId: uuid('converted_order_id').references(() => orders.id, { onDelete: 'set null' }),
  convertedAt: timestamp('converted_at', { withTimezone: true }),
  abandonedEmailSentAt: timestamp('abandoned_email_sent_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('carts_token_uq').on(t.token),
  index('carts_customer_idx').on(t.customerId),
  index('carts_abandoned_idx').on(t.updatedAt)
    .where(sql`${t.abandonedEmailSentAt} IS NULL AND ${t.convertedAt} IS NULL`),
]);

export const cartItems = pgTable('cart_items', {
  id: id(),
  cartId: uuid('cart_id').notNull().references(() => carts.id, { onDelete: 'cascade' }),
  variantId: uuid('variant_id').notNull().references(() => productVariants.id, { onDelete: 'cascade' }),
  quantity: integer('quantity').notNull(),
  addedAt: createdAt(),
}, (t) => [
  uniqueIndex('cart_items_uq').on(t.cartId, t.variantId),
  check('cart_items_qty_positive', sql`${t.quantity} > 0 AND ${t.quantity} <= 99`),
]);

/* ═══════════════════════════ ЗАМОВЛЕННЯ ═══════════════════════════ */

export const orders = pgTable('orders', {
  id: hotId(),   // uuidv7: висока частота вставок
  /** Людський номер: LS-2026-000123. Генерується з sequence */
  orderNumber: varchar('order_number', { length: 32 }).notNull(),
  /**
   * Checkout intent, з якого створене замовлення (ADR-11).
   *
   * Раніше тут був `idempotency_key` від клієнта. Прибрано: ADR-11 у третій
   * редакції перевів ідемпотентність на СЕРВЕРНИЙ intent, бо клієнтський
   * ключ зникав при перезавантаженні сторінки й давав друге замовлення.
   * Залишити обидва механізми означало б два джерела істини.
   *
   * Nullable — для замовлень, створених адміном вручну, без checkout.
   */
  checkoutIntentId: uuid('checkout_intent_id'),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),

  status: orderStatusEnum('status').notNull().default('pending'),
  paymentStatus: paymentStatusEnum('payment_status').notNull().default('pending'),
  paymentProvider: paymentProviderEnum('payment_provider'),
  /**
   * Актуальна спроба оплати (ADR-11). Повторна оплата не створює нове
   * замовлення — вона створює новий рядок у payment_attempts і переставляє
   * цей вказівник. FK додається окремою міграцією після payment_attempts,
   * бо тут циклічне посилання.
   */
  currentPaymentAttemptId: uuid('current_payment_attempt_id'),
  /** invoiceId у Mono, orderReference у WayForPay — актуальної спроби */
  providerPaymentId: varchar('provider_payment_id', { length: 128 }),

  /** Фіскальний чек (ADR-16). Ніколи не блокує підтвердження оплати */
  fiscalStatus: fiscalStatusEnum('fiscal_status').notNull().default('not_required'),
  fiscalReceiptId: varchar('fiscal_receipt_id', { length: 128 }),
  fiscalReceiptUrl: text('fiscal_receipt_url'),
  fiscalError: text('fiscal_error'),
  fiscalAttempts: smallint('fiscal_attempts').notNull().default(0),

  /** Снапшот контактів на момент замовлення */
  customerEmail: varchar('customer_email', { length: 320 }).notNull(),
  customerPhone: varchar('customer_phone', { length: 20 }).notNull(),
  customerName: varchar('customer_name', { length: 240 }).notNull(),

  /** Снапшот адреси доставки — адресу клієнта могли змінити або видалити */
  deliveryMethod: deliveryMethodEnum('delivery_method').notNull(),
  deliverySettlementRef: varchar('delivery_settlement_ref', { length: 64 }),
  deliverySettlementName: varchar('delivery_settlement_name', { length: 240 }),
  deliveryWarehouseRef: varchar('delivery_warehouse_ref', { length: 64 }),
  deliveryWarehouseName: text('delivery_warehouse_name'),
  deliveryAddress: text('delivery_address'),
  /** Номер накладної Нової Пошти */
  ttn: varchar('ttn', { length: 40 }),

  subtotal: money('subtotal').notNull(),
  discountTotal: money('discount_total').notNull().default(0),
  shippingTotal: money('shipping_total').notNull().default(0),
  /**
   * Ручна коригувальна сума з адмінки: + доплата, − компенсація.
   * Без цієї колонки CHECK на арифметику total блокував би будь-яку
   * легітимну ручну правку суми замовлення.
   */
  adjustmentTotal: money('adjustment_total').notNull().default(0),
  /** Поточна вартість виконання замовлення */
  total: money('total').notNull(),
  /**
   * Фактично отримана сума, ВИВЕДЕНА з успішних платіжних операцій.
   * Окремо від `total` свідомо: критерій «редагування складу оплаченого
   * замовлення перераховує суму» інакше перезаписував би суму реального
   * розрахунку. Покупець сплатив 2000, менеджер видалив позицію — і БД
   * більше не знає, скільки насправді прийшло.
   * Заповнюється тільки з payment_attempts, ніколи вручну.
   */
  capturedTotal: money('captured_total').notNull().default(0),
  refundedTotal: money('refunded_total').notNull().default(0),
  /**
   * Реальна вартість доставки з відповіді Нової Пошти.
   * Разом із shipping_paid_by: тариф перевізника — це витрата продавця
   * ЛИШЕ якщо доставку оплатив продавець. Інакше звіт маржинальності
   * відніме з маржі те, що заплатив одержувач.
   */
  shippingCostActual: money('shipping_cost_actual'),
  shippingPaidBy: varchar('shipping_paid_by', { length: 10 }).notNull().default('recipient'),
  /**
   * Токен доступу до замовлення для гостя.
   * order_number послідовний і НЕ є секретом — /order/success/LS-2026-000123
   * перебирається. Зберігається хеш; сам токен віддається один раз.
   * НЕ використовувати для цього order_number або checkout intent.
   */
  accessTokenHash: text('access_token_hash'),
  currency: varchar('currency', { length: 3 }).notNull().default('UAH'),
  promoCode: varchar('promo_code', { length: 64 }),

  locale: varchar('locale', { length: 5 }).notNull().default('uk'),
  comment: text('comment'),
  adminNote: text('admin_note'),

  ip: varchar('ip', { length: 45 }),
  userAgent: text('user_agent'),
  utmSource: varchar('utm_source', { length: 120 }),
  utmMedium: varchar('utm_medium', { length: 120 }),
  utmCampaign: varchar('utm_campaign', { length: 200 }),

  paidAt: timestamp('paid_at', { withTimezone: true }),
  shippedAt: timestamp('shipped_at', { withTimezone: true }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('orders_number_uq').on(t.orderNumber),
  /** Один intent → одне замовлення. Це і є ідемпотентність (ADR-11) */
  uniqueIndex('orders_intent_uq').on(t.checkoutIntentId)
    .where(sql`${t.checkoutIntentId} IS NOT NULL`),
  index('orders_created_idx').on(t.createdAt),
  index('orders_status_idx').on(t.status),
  index('orders_customer_idx').on(t.customerId),
  index('orders_phone_idx').on(t.customerPhone),
  index('orders_ttn_idx').on(t.ttn),
  index('orders_provider_payment_idx').on(t.providerPaymentId),
  /** Для екрана «неоплачені» та воркера auto-cancel */
  index('orders_unpaid_idx').on(t.createdAt).where(sql`${t.paymentStatus} = 'pending'`),
  /** Для алерту «відправлено без ТТН» */
  index('orders_no_ttn_idx').on(t.createdAt).where(sql`${t.ttn} IS NULL`),
  check('orders_total_nonneg', sql`${t.total} >= 0`),
  check('orders_discount_nonneg', sql`${t.discountTotal} >= 0`),
  /**
   * Повернути можна не більше, ніж фактично отримано.
   * Раніше було проти `total` — і зменшення total після часткового
   * повернення блокувало легітимну правку замовлення.
   */
  check('orders_refund_lte_captured', sql`${t.refundedTotal} <= ${t.capturedTotal}`),
  check('orders_captured_nonneg', sql`${t.capturedTotal} >= 0`),
  check('orders_shipping_payer', sql`${t.shippingPaidBy} IN ('recipient', 'sender')`),
  check('orders_total_math', sql`
    ${t.total} = ${t.subtotal} - ${t.discountTotal} + ${t.shippingTotal} + ${t.adjustmentTotal}
  `),
]);

export const orderItems = pgTable('order_items', {
  id: hotId(),   // uuidv7: висока частота вставок
  /**
   * RESTRICT, не CASCADE. Задеклароване правило «CASCADE тільки для справді
   * залежних сутностей» не виконувалось: видалення замовлення прибирало
   * позиції, історію, резерви й використання промокодів, при цьому
   * `reserved_quantity` на варіанті залишався. Фінансово значущі записи
   * фізично не видаляються — замовлення архівується.
   */
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'restrict' }),
  /** SET NULL: замовлення мусить читатись навіть після видалення товару */
  productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
  variantId: uuid('variant_id').references(() => productVariants.id, { onDelete: 'set null' }),

  /**
   * Незмінна ідентичність товару — НЕ зануляється разом з FK.
   * Потрібна, бо видалений SKU можуть перевикористати, і тоді старі та
   * нові продажі змішаються у звіті.
   */
  productUidSnapshot: uuid('product_uid_snapshot').notNull(),
  variantUidSnapshot: uuid('variant_uid_snapshot').notNull(),

  /** Снапшоти. Замовлення дворічної давнини показує ціну на момент покупки */
  nameSnapshot: varchar('name_snapshot', { length: 300 }).notNull(),
  skuSnapshot: varchar('sku_snapshot', { length: 64 }).notNull(),
  brandSnapshot: varchar('brand_snapshot', { length: 120 }),
  sizeLabel: varchar('size_label', { length: 20 }).notNull(),
  /**
   * Без системи розміру «M» неоднозначне. Потрібне і для повернень,
   * і для звіту про вимивання розмірів.
   */
  sizeSystemSnapshot: varchar('size_system_snapshot', { length: 20 }),
  colorName: varchar('color_name', { length: 80 }).notNull(),
  /**
   * Категорія на момент продажу. Без цього переміщення товару в іншу
   * категорію перегруповує продажі за минулий рік.
   */
  categoryPathSnapshot: text('category_path_snapshot'),
  imageUrlSnapshot: text('image_url_snapshot'),
  /**
   * Снапшот УКТЗЕД. Без нього неможливо сформувати коректний фіскальний чек
   * повернення через рік, якщо товар уже видалено з каталогу.
   */
  uktzedSnapshot: varchar('uktzed_snapshot', { length: 20 }),

  unitPrice: money('unit_price').notNull(),
  /** Знижка на позицію. Потрібна для акцій «3 за ціною 2» і подарунків до замовлення */
  lineDiscount: money('line_discount').notNull().default(0),
  /** Собівартість на момент продажу — основа звіту маржинальності */
  unitCostSnapshot: money('unit_cost_snapshot'),
  quantity: integer('quantity').notNull(),
  lineTotal: money('line_total').notNull(),
}, (t) => [
  index('order_items_order_idx').on(t.orderId),
  index('order_items_product_idx').on(t.productId),
  index('order_items_variant_idx').on(t.variantId),
  check('order_items_qty_positive', sql`${t.quantity} > 0`),
  check('order_items_discount_nonneg', sql`${t.lineDiscount} >= 0`),
  // Дозволяє позицію за 0 (подарунок), але не від'ємну
  check('order_items_line_math', sql`
    ${t.lineTotal} = ${t.unitPrice} * ${t.quantity} - ${t.lineDiscount}
    AND ${t.lineTotal} >= 0
  `),
]);

export const orderStatusHistory = pgTable('order_status_history', {
  id: id(),
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  fromStatus: varchar('from_status', { length: 40 }),
  toStatus: varchar('to_status', { length: 40 }).notNull(),
  field: varchar('field', { length: 20 }).notNull().default('status'), // 'status' | 'payment_status'
  changedByUserId: uuid('changed_by_user_id'),
  /** 'webhook:mono', 'worker:expire-unpaid', 'admin' */
  source: varchar('source', { length: 40 }).notNull(),
  comment: text('comment'),
  createdAt: createdAt(),
}, (t) => [index('osh_order_idx').on(t.orderId, t.createdAt)]);

/**
 * Ідемпотентність вебхуків (ADR-4). UNIQUE(provider, external_id) —
 * вставка події є ПЕРШОЮ операцією обробника; конфлікт означає дубль.
 */
export const paymentEvents = pgTable('payment_events', {
  id: hotId(),   // uuidv7: висока частота вставок
  orderId: uuid('order_id').references(() => orders.id, { onDelete: 'restrict' }),
  /**
   * Прив'язка до конкретної спроби оплати. Раніше `external_id` змішував
   * ідентичність спроби й ідентичність повідомлення: один інвойс дає
   * кілька повідомлень про зміну стану, тому `processing` займав ключ, а
   * `success` відкидався як дубль.
   */
  paymentAttemptId: uuid('payment_attempt_id')
    .references(() => paymentAttempts.id, { onDelete: 'restrict' }),
  provider: paymentProviderEnum('provider').notNull(),
  /**
   * Ключ дедуплікації ПОВІДОМЛЕННЯ, не спроби. Для провайдера без
   * окремого event id — хеш значущих автентифікованих полів.
   */
  messageKey: varchar('message_key', { length: 200 }).notNull(),
  /**
   * Версія стану на боці провайдера (Mono: `modifiedDate`). Mono прямо
   * попереджає, що порядок вебхуків не гарантований. Застаріле
   * повідомлення зберігається, але НЕ скасовує вже підтверджений
   * фінансовий факт.
   */
  stateVersion: timestamp('state_version', { withTimezone: true }),
  eventType: varchar('event_type', { length: 80 }),
  mappedStatus: paymentStatusEnum('mapped_status'),
  amount: money('amount'),
  currency: varchar('currency', { length: 3 }),
  rawPayload: jsonb('raw_payload').notNull(),
  /** Застосовано, а не лише отримано. Дублі відкидаються після цієї мітки */
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  error: text('error'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('payment_events_idem_uq').on(t.provider, t.messageKey),
  index('payment_events_order_idx').on(t.orderId, t.createdAt),
  index('payment_events_attempt_idx').on(t.paymentAttemptId),
  index('payment_events_unapplied_idx').on(t.createdAt).where(sql`${t.appliedAt} IS NULL`),
]);

/**
 * Спроби оплати (ADR-11).
 *
 * Одне замовлення — багато спроб. «Не вистачило коштів, зміню карту» створює
 * НОВУ спробу, а не нове замовлення. Резервація належить замовленню, тому
 * повторна оплата не резервує товар удруге.
 *
 * Без цієї таблиці повторна оплата або створювала дубль замовлення, або
 * блокувалася ключем ідемпотентності — обидва варіанти неприйнятні.
 */
export const paymentAttempts = pgTable('payment_attempts', {
  id: hotId(),   // uuidv7: висока частота вставок
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'restrict' }),
  attemptNumber: smallint('attempt_number').notNull(),
  provider: paymentProviderEnum('provider').notNull(),
  /**
   * Наш незмінний reference, який передається провайдеру ДО зовнішнього
   * виклику. Спроба створюється першою; якщо відповідь загубилася, ми
   * знаємо, за яким reference питати статус, і не створюємо другий інвойс.
   */
  localReference: uuid('local_reference').notNull().defaultRandom(),
  /** invoiceId / orderReference цієї конкретної спроби */
  externalId: varchar('external_id', { length: 128 }),
  redirectUrl: text('redirect_url'),
  /**
   * `unknown` — зовнішній виклик зроблено, результат невідомий.
   * Наступний крок — звірка через getPaymentStatus, НЕ нова спроба.
   */
  state: operationStateEnum('state').notNull().default('pending'),
  status: paymentStatusEnum('status').notNull().default('pending'),
  amount: money('amount').notNull(),
  currency: varchar('currency', { length: 3 }).notNull().default('UAH'),
  /** Фактично зарахована сума цієї спроби — джерело orders.captured_total */
  capturedAmount: money('captured_amount').notNull().default(0),
  failureReason: text('failure_reason'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('payment_attempts_order_num_uq').on(t.orderId, t.attemptNumber),
  uniqueIndex('payment_attempts_local_ref_uq').on(t.localReference),
  uniqueIndex('payment_attempts_external_uq').on(t.provider, t.externalId)
    .where(sql`${t.externalId} IS NOT NULL`),
  index('payment_attempts_order_idx').on(t.orderId, t.createdAt),
  /** Для воркера звірки незавершених спроб */
  index('payment_attempts_open_idx').on(t.createdAt)
    .where(sql`${t.state} IN ('pending', 'in_flight', 'unknown')`),
  check('payment_attempts_num_positive', sql`${t.attemptNumber} > 0`),
  check('payment_attempts_amount_positive', sql`${t.amount} > 0`),
  check('payment_attempts_captured_lte', sql`${t.capturedAmount} <= ${t.amount}`),
]);

/**
 * Резервації залишків (ADR-3). Створюються разом із замовленням,
 * звільняються при оплаті (з реальним списанням), скасуванні або протермінуванні.
 *
 * TTL залежить від методу оплати: картка 30 хв, переказ 24 год,
 * COD 2 год до підтвердження менеджером. Значення в settings.reservation_ttl.
 */
export const stockReservations = pgTable('stock_reservations', {
  id: id(),
  variantId: uuid('variant_id').notNull().references(() => productVariants.id, { onDelete: 'restrict' }),
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'restrict' }),
  quantity: integer('quantity').notNull(),
  /**
   * NULL = резерв без строку: оплачене замовлення або підтверджений COD.
   * Тримається до `shipped` (ADR-18). Раніше було NOT NULL, що суперечило
   * дефолту «COD до shipped без TTL».
   */
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  /** 'shipped' | 'cancelled' | 'expired' — НЕ 'paid': оплата не звільняє резерв */
  releaseReason: varchar('release_reason', { length: 20 }),
  createdAt: createdAt(),
}, (t) => [
  /**
   * ЧАСТКОВИЙ unique. Повний блокував повторне додавання позиції в
   * замовлення після її видалення менеджером: закритий резерв займав ключ.
   */
  uniqueIndex('reservations_active_uq').on(t.orderId, t.variantId)
    .where(sql`${t.releasedAt} IS NULL`),
  index('reservations_expiry_idx').on(t.expiresAt)
    .where(sql`${t.releasedAt} IS NULL AND ${t.expiresAt} IS NOT NULL`),
  index('reservations_variant_idx').on(t.variantId).where(sql`${t.releasedAt} IS NULL`),
  check('reservations_qty_positive', sql`${t.quantity} > 0`),
]);

/* ═══════════════════════════ МАРКЕТИНГ ═══════════════════════════ */

export const promoCodes = pgTable('promo_codes', {
  id: id(),
  code: varchar('code', { length: 64 }).notNull(),
  /** Опис для адмінки — навіщо код створювався */
  description: varchar('description', { length: 300 }),
  type: promoTypeEnum('type').notNull(),
  /** percent: 1..100; fixed: копійки; free_shipping: 0 */
  value: integer('value').notNull(),
  /**
   * Стеля знижки для відсоткових кодів. Без неї «20% на все» на
   * замовленні в 50 000 ₴ дає 10 000 ₴ знижки.
   */
  maxDiscountAmount: money('max_discount_amount'),
  minOrderTotal: money('min_order_total').notNull().default(0),
  maxUses: integer('max_uses'),
  usesCount: integer('uses_count').notNull().default(0),
  perCustomerLimit: integer('per_customer_limit'),
  scope: promoScopeEnum('scope').notNull().default('all'),
  /**
   * RESTRICT, не CASCADE: видалення категорії стирало сам промокод разом
   * з історією його використань, тобто пояснення історичних знижок.
   */
  scopeCategoryId: uuid('scope_category_id').references(() => categories.id, { onDelete: 'restrict' }),
  scopeProductId: uuid('scope_product_id').references(() => products.id, { onDelete: 'restrict' }),
  /** Чи можна поєднувати з іншим кодом. За замовчуванням — ні */
  stackable: boolean('stackable').notNull().default(false),
  /** Не застосовувати до позицій, що вже мають compare_at_price */
  excludesDiscountedItems: boolean('excludes_discounted_items').notNull().default(false),
  /** Лише для першого замовлення клієнта */
  firstOrderOnly: boolean('first_order_only').notNull().default(false),
  /**
   * Сертифікати ніколи не оплачуються промокодом: інакше можна купити
   * інструмент на 1000 ₴ за 800 ₴ і виводити різницю.
   */
  excludesGiftCards: boolean('excludes_gift_cards').notNull().default(true),
  startsAt: timestamp('starts_at', { withTimezone: true }),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  isActive: boolean('is_active').notNull().default(true),
  createdByUserId: uuid('created_by_user_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('promo_codes_code_uq').on(sql`upper(${t.code})`),
  index('promo_codes_active_idx').on(t.isActive, t.endsAt),
  check('promo_value_range', sql`
    (${t.type} <> 'percent') OR (${t.value} BETWEEN 1 AND 100)
  `),
  check('promo_uses_lte_max', sql`${t.maxUses} IS NULL OR ${t.usesCount} <= ${t.maxUses}`),
  /**
   * Звільнення використання при скасуванні робить `uses_count -= 1`.
   * Без цього CHECK подвійне звільнення (воркер + вебхук) заганяло
   * лічильник у мінус, і код ставав «безлімітним».
   */
  check('promo_uses_nonneg', sql`${t.usesCount} >= 0`),
  check('promo_dates_order', sql`
    ${t.startsAt} IS NULL OR ${t.endsAt} IS NULL OR ${t.startsAt} < ${t.endsAt}
  `),
  /** Стеля має сенс лише для відсоткових */
  check('promo_cap_only_percent', sql`
    ${t.maxDiscountAmount} IS NULL OR ${t.type} = 'percent'
  `),
  /** Ліміт на клієнта вимагає підтвердженої ідентичності — не для гостей */
  check('promo_per_customer_positive', sql`
    ${t.perCustomerLimit} IS NULL OR ${t.perCustomerLimit} > 0
  `),
]);

/**
 * Використання промокоду.
 *
 * Обіцяного обмеження «N використань на клієнта» частковий UNIQUE не давав:
 * для довільного N це неможливо виразити індексом, а гість має
 * `customer_id = NULL` і обходив перевірку взагалі.
 *
 * Тому правило: усі застосування та звільнення конкретного промокоду
 * виконуються ПІД БЛОКУВАННЯМ ЙОГО РЯДКА (`SELECT ... FOR UPDATE` на
 * `promo_codes`). У тій самій транзакції перевіряються загальний і
 * клієнтський ліміти, пишеться redemption і змінюється лічильник.
 *
 * Промокоди з лімітом на клієнта дозволені тільки для підтвердженої
 * облікової ідентичності — це ліміт на акаунт, а не гарантія «одна людина».
 */
export const promoCodeRedemptions = pgTable('promo_code_redemptions', {
  id: id(),
  promoCodeId: uuid('promo_code_id').notNull().references(() => promoCodes.id, { onDelete: 'restrict' }),
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'restrict' }),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
  discountAmount: money('discount_amount').notNull(),
  /**
   * Стан, щоб скасування замовлення звільняло використання РІВНО ОДИН РАЗ.
   * Без цього `uses_count` розходився з реальними використаннями після
   * скасувань.
   */
  state: varchar('state', { length: 20 }).notNull().default('consumed'),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('promo_redemption_order_uq').on(t.promoCodeId, t.orderId),
  index('promo_redemption_customer_idx').on(t.promoCodeId, t.customerId)
    .where(sql`${t.state} = 'consumed'`),
  check('promo_redemption_state', sql`${t.state} IN ('consumed', 'released')`),
]);

export const banners = pgTable('banners', {
  id: id(),
  titleUk: varchar('title_uk', { length: 200 }),
  titleEn: varchar('title_en', { length: 200 }),
  subtitleUk: varchar('subtitle_uk', { length: 300 }),
  subtitleEn: varchar('subtitle_en', { length: 300 }),
  imageDesktopUrl: text('image_desktop_url').notNull(),
  imageMobileUrl: text('image_mobile_url').notNull(),
  ctaLabelUk: varchar('cta_label_uk', { length: 80 }),
  ctaLabelEn: varchar('cta_label_en', { length: 80 }),
  href: text('href'),
  position: varchar('position', { length: 40 }).notNull().default('home_hero'),
  startsAt: timestamp('starts_at', { withTimezone: true }),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
}, (t) => [index('banners_position_idx').on(t.position, t.sortOrder)]);

export const reviews = pgTable('reviews', {
  id: id(),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  /** Верифікація: відгук лише від того, хто справді купив */
  orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
  rating: smallint('rating').notNull(),
  title: varchar('title', { length: 200 }),
  body: text('body'),
  sizeBought: varchar('size_bought', { length: 20 }),
  fitFeedback: fitFeedbackEnum('fit_feedback'),
  photoUrls: text('photo_urls').array(),
  isApproved: boolean('is_approved').notNull().default(false),
  moderatedByUserId: uuid('moderated_by_user_id'),
  adminReply: text('admin_reply'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('reviews_product_customer_uq').on(t.productId, t.customerId),
  index('reviews_product_approved_idx').on(t.productId).where(sql`${t.isApproved} = true`),
  index('reviews_pending_idx').on(t.createdAt).where(sql`${t.isApproved} = false`),
  check('reviews_rating_range', sql`${t.rating} BETWEEN 1 AND 5`),
]);

export const wishlistItems = pgTable('wishlist_items', {
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.customerId, t.productId] })]);

export const stockNotifications = pgTable('stock_notifications', {
  id: id(),
  variantId: uuid('variant_id').notNull().references(() => productVariants.id, { onDelete: 'cascade' }),
  email: varchar('email', { length: 320 }).notNull(),
  locale: varchar('locale', { length: 5 }).notNull().default('uk'),
  notifiedAt: timestamp('notified_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('stock_notif_uq').on(t.variantId, t.email),
  index('stock_notif_pending_idx').on(t.variantId).where(sql`${t.notifiedAt} IS NULL`),
]);

export const newsletterSubscribers = pgTable('newsletter_subscribers', {
  id: id(),
  email: varchar('email', { length: 320 }).notNull(),
  locale: varchar('locale', { length: 5 }).notNull().default('uk'),
  source: varchar('source', { length: 60 }),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('newsletter_email_uq').on(t.email)]);

/* ═══════════════════════════ КОНТЕНТ ═══════════════════════════ */

export const pages = pgTable('pages', {
  id: id(),
  slug: varchar('slug', { length: 160 }).notNull(),
  titleUk: varchar('title_uk', { length: 300 }).notNull(),
  titleEn: varchar('title_en', { length: 300 }).notNull(),
  contentUk: text('content_uk'),
  contentEn: text('content_en'),
  metaTitleUk: varchar('meta_title_uk', { length: 200 }),
  metaTitleEn: varchar('meta_title_en', { length: 200 }),
  metaDescriptionUk: varchar('meta_description_uk', { length: 400 }),
  metaDescriptionEn: varchar('meta_description_en', { length: 400 }),
  noindex: boolean('noindex').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('pages_slug_uq').on(t.slug)]);

export const blogPosts = pgTable('blog_posts', {
  id: id(),
  slug: varchar('slug', { length: 200 }).notNull(),
  titleUk: varchar('title_uk', { length: 300 }).notNull(),
  titleEn: varchar('title_en', { length: 300 }).notNull(),
  excerptUk: varchar('excerpt_uk', { length: 500 }),
  excerptEn: varchar('excerpt_en', { length: 500 }),
  contentUk: text('content_uk'),
  contentEn: text('content_en'),
  coverUrl: text('cover_url'),
  author: varchar('author', { length: 160 }),
  tags: text('tags').array(),
  metaTitleUk: varchar('meta_title_uk', { length: 200 }),
  metaTitleEn: varchar('meta_title_en', { length: 200 }),
  metaDescriptionUk: varchar('meta_description_uk', { length: 400 }),
  metaDescriptionEn: varchar('meta_description_en', { length: 400 }),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('blog_slug_uq').on(t.slug),
  index('blog_published_idx').on(t.publishedAt),
]);

/** 301-редіректи. Зміна slug в адмінці автоматично створює запис */
export const redirects = pgTable('redirects', {
  id: id(),
  fromPath: varchar('from_path', { length: 500 }).notNull(),
  toPath: varchar('to_path', { length: 500 }).notNull(),
  statusCode: smallint('status_code').notNull().default(301),
  hitCount: integer('hit_count').notNull().default(0),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('redirects_from_uq').on(t.fromPath),
  check('redirects_status_valid', sql`${t.statusCode} IN (301, 302, 410)`),
  check('redirects_not_loop', sql`${t.fromPath} <> ${t.toPath}`),
]);

/* ═══════════════════ ДОВІДНИКИ ДОСТАВКИ (кеш API) ═══════════════════ */

export const npSettlements = pgTable('np_settlements', {
  ref: varchar('ref', { length: 64 }).primaryKey(),
  nameUk: varchar('name_uk', { length: 240 }).notNull(),
  areaNameUk: varchar('area_name_uk', { length: 240 }),
  regionNameUk: varchar('region_name_uk', { length: 240 }),
  settlementTypeUk: varchar('settlement_type_uk', { length: 80 }),
  warehousesCount: integer('warehouses_count').notNull().default(0),
  syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('np_settlements_name_trgm_idx').using('gin', sql`${t.nameUk} gin_trgm_ops`),
  index('np_settlements_count_idx').on(t.warehousesCount),
]);

export const npWarehouses = pgTable('np_warehouses', {
  ref: varchar('ref', { length: 64 }).primaryKey(),
  settlementRef: varchar('settlement_ref', { length: 64 }).notNull(),
  number: varchar('number', { length: 20 }).notNull(),
  descriptionUk: text('description_uk').notNull(),
  type: npWarehouseTypeEnum('type').notNull().default('branch'),
  maxWeightKg: real('max_weight_kg'),
  latitude: real('latitude'),
  longitude: real('longitude'),
  scheduleUk: jsonb('schedule_uk'),
  isActive: boolean('is_active').notNull().default(true),
  syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('np_warehouses_settlement_idx').on(t.settlementRef, t.type),
  index('np_warehouses_desc_trgm_idx').using('gin', sql`${t.descriptionUk} gin_trgm_ops`),
]);

/* ═══════════════════ ПОВЕРНЕННЯ ТА ОБМІН ═══════════════════ */

export const returnStatusEnum = pgEnum('return_status', [
  'requested', 'approved', 'rejected', 'in_transit', 'received', 'refunded', 'closed',
]);

export const returnReasonEnum = pgEnum('return_reason', [
  'defect',            // дефект: режим неналежної якості, №172 не застосовується
  'wrong_item',        // надіслали не те: помилка комплектації, окремий режим
  'not_as_described',  // невідповідність опису: окремий режим
  'changed_mind',      // товар належної якості — ось тут і діє перелік №172
  'wrong_size',        // так само належна якість
  'other',
]);

/**
 * Запити на повернення й обмін.
 *
 * ВАЖЛИВО про №172: перелік стосується товарів **належної якості**.
 * Дефект, помилка комплектації та невідповідність опису — це ІНШІ режими,
 * і відмовляти в них «бо це білизна» неправильно. Так само непорушена
 * упаковка сама собою не скасовує виняток для натільної білизни, і єдина
 * політика не має автоматично поширюватись на весь домашній одяг.
 *
 * Тому: застосовність визначається реальною класифікацією товару, а
 * добровільна політика магазину описується окремо від законодавчої вимоги.
 * `policy_version` фіксує, яка редакція політики діяла на момент запиту —
 * ті самі правила мусять використовуватись у checkout, у заявці та в
 * `hasMerchantReturnPolicy` у JSON-LD.
 *
 * Логіка допустимості — packages/core/orders/returns.ts.
 * Остаточні тексти узгоджує юрист (відкрите питання №6).
 */
export const returnRequests = pgTable('return_requests', {
  id: id(),
  requestNumber: varchar('request_number', { length: 32 }).notNull(),
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'restrict' }),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
  status: returnStatusEnum('status').notNull().default('requested'),
  reason: returnReasonEnum('reason').notNull(),
  /** Редакція політики повернень, що діяла на момент запиту */
  policyVersion: varchar('policy_version', { length: 20 }).notNull(),
  customerComment: text('customer_comment'),
  photoUrls: text('photo_urls').array(),
  adminNote: text('admin_note'),
  /** Скільки погодились повернути. Може бути меншим за суму позицій */
  refundAmount: money('refund_amount'),
  /** Чи повертати товар на склад — при дефекті зазвичай ні */
  restock: boolean('restock').notNull().default(false),
  resolvedByUserId: uuid('resolved_by_user_id'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('return_requests_number_uq').on(t.requestNumber),
  index('return_requests_order_idx').on(t.orderId),
  index('return_requests_status_idx').on(t.status),
  index('return_requests_open_idx').on(t.createdAt)
    .where(sql`${t.status} IN ('requested', 'approved', 'in_transit', 'received')`),
]);

export const returnRequestItems = pgTable('return_request_items', {
  id: id(),
  returnRequestId: uuid('return_request_id').notNull()
    .references(() => returnRequests.id, { onDelete: 'cascade' }),
  orderItemId: uuid('order_item_id').notNull()
    .references(() => orderItems.id, { onDelete: 'restrict' }),
  /**
   * Денормалізований order_id для складеного FK нижче.
   * Без нього схема допускала включення позиції ЧУЖОГО замовлення
   * у запит на повернення.
   */
  orderId: uuid('order_id').notNull(),
  quantity: integer('quantity').notNull(),
  /**
   * Фактично прийнята і оприбуткована кількість — окремо від заявленої.
   * Один прапорець `restock` на весь запит не описував часткове
   * приймання, а повторний запуск обробника `received` поповнював склад
   * двічі.
   */
  receivedQuantity: integer('received_quantity').notNull().default(0),
  restockedQuantity: integer('restocked_quantity').notNull().default(0),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('return_items_uq').on(t.returnRequestId, t.orderItemId),
  index('return_items_order_idx').on(t.orderId),
  check('return_items_qty_positive', sql`${t.quantity} > 0`),
  check('return_items_received_lte', sql`${t.receivedQuantity} <= ${t.quantity}`),
  check('return_items_restocked_lte', sql`${t.restockedQuantity} <= ${t.receivedQuantity}`),
]);

/*
  ДОДАТКОВО В МІГРАЦІЇ (Drizzle не виражає складені FK декларативно):

  -- 1. Позиція мусить належати тому самому замовленню, що й запит
  ALTER TABLE order_items ADD CONSTRAINT order_items_id_order_uq
    UNIQUE (id, order_id);

  ALTER TABLE return_request_items
    ADD CONSTRAINT rri_item_belongs_to_order_fk
    FOREIGN KEY (order_item_id, order_id)
    REFERENCES order_items (id, order_id);

  ALTER TABLE return_requests ADD CONSTRAINT return_requests_id_order_uq
    UNIQUE (id, order_id);

  ALTER TABLE return_request_items
    ADD CONSTRAINT rri_request_same_order_fk
    FOREIGN KEY (return_request_id, order_id)
    REFERENCES return_requests (id, order_id);

  -- 2. Сума повернень по позиції не перевищує проданої кількості —
  --    cross-table, тому перевіряється в core під блокуванням order_items:
  --
  --    ВИПРАВЛЕНО: 'closed' НЕ виключається. Закрите повернення — це
  --    ВИКОНАНЕ зобов'язання, і воно мусить рахуватися назавжди. Інакше
  --    після кожного закриття заявки та сама одиниця знову доступна для
  --    повернення, і цикл можна повторювати.
  --    Виключаються лише заявки, що НЕ створили зобов'язання.
  --
  --    SELECT sum(rri.quantity) FROM return_request_items rri
  --      JOIN return_requests r ON r.id = rri.return_request_id
  --     WHERE rri.order_item_id = $1
  --       AND r.status NOT IN ('rejected');
*/

/* ═══════════════════ ПЕРЕГЛЯДИ ТОВАРІВ ═══════════════════ */

/**
 * Джерело даних для двох речей, які інакше неможливі:
 *   1. Звіт «переглядали, але не купували» (фаза 10)
 *   2. Воронка на дашборді: перегляди → кошики → checkout → оплачені
 *
 * session_hash — SHA-256 від (session_id + сіль), НЕ IP і не user-agent:
 * персональні дані тут не потрібні, а для дедуплікації хеша достатньо.
 * Пишеться асинхронно через pg-boss, щоб не додавати латентності PDP.
 * Очищається воркером, TTL 90 днів — інакше таблиця з'їсть диск.
 */
export const productViews = pgTable('product_views', {
  id: hotId(),   // uuidv7: висока частота вставок
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  sessionHash: varchar('session_hash', { length: 64 }).notNull(),
  /**
   * ДАТА, не момент (ADR-17). Дедуплікація «один перегляд на сесію на день»
   * вимагає однозначної межі доби. Обчислюється в UTC на боці Postgres
   * (`current_date`), а не з Date.now() у Node.
   */
  viewedOn: date('viewed_on').notNull().default(sql`current_date`),
  createdAt: createdAt(),
}, (t) => [
  /** Дедуплікація: один перегляд товару на сесію на день */
  uniqueIndex('product_views_dedup_uq').on(t.productId, t.sessionHash, t.viewedOn),
  index('product_views_product_idx').on(t.productId, t.viewedOn),
  index('product_views_cleanup_idx').on(t.viewedOn),
]);

/* ═══════════════ ФІНАНСОВІ ОПЕРАЦІЇ ТА НАДІЙНІСТЬ ═══════════════ */

/**
 * Transactional outbox.
 *
 * ADR-4: ідемпотентність ОТРИМАННЯ вебхука не робить ідемпотентним його
 * ЗАСТОСУВАННЯ. Якщо процес упаде між вставкою події й оновленням
 * замовлення, повторна доставка побачить «дубль» і замовлення назавжди
 * залишиться неоплаченим, хоча гроші списані.
 *
 * Тому подія, фінансовий стан, складські зміни, історія і запис у цю
 * таблицю комітяться ОДНІЄЮ транзакцією. Воркер потім доставляє записи
 * в pg-boss із ретраями. Це ж вирішує другу проблему: постановка листа
 * в чергу після коміту мала власне вікно втрати.
 */
export const outbox = pgTable('outbox', {
  id: hotId(),   // uuidv7: висока частота вставок
  topic: varchar('topic', { length: 80 }).notNull(),
  payload: jsonb('payload').notNull(),
  /** Для дедуплікації доставки в чергу */
  dedupKey: varchar('dedup_key', { length: 200 }),
  attempts: smallint('attempts').notNull().default(0),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdAt: createdAt(),
}, (t) => [
  index('outbox_unpublished_idx').on(t.createdAt).where(sql`${t.publishedAt} IS NULL`),
  uniqueIndex('outbox_dedup_uq').on(t.dedupKey).where(sql`${t.dedupKey} IS NOT NULL`),
]);

/**
 * Карантин неперевірених вхідних повідомлень.
 *
 * КРИТИЧНО: вебхуки з невалідним підписом НЕ пишуться в payment_events.
 * `UNIQUE(provider, external_id)` там не враховує signature_valid, тому
 * запит зі сміттєвим підписом і правильним invoiceId першим займе ключ —
 * і справжній платіжний вебхук потім відкинеться як дубль. Це можливо і
 * без атаки: через помилку перевірки підпису при першій доставці.
 *
 * Обмежений строк зберігання, очищається воркером.
 */
export const webhookQuarantine = pgTable('webhook_quarantine', {
  id: id(),
  provider: varchar('provider', { length: 40 }).notNull(),
  rawBody: text('raw_body').notNull(),
  headers: jsonb('headers'),
  reason: varchar('reason', { length: 120 }).notNull(),
  sourceIp: varchar('source_ip', { length: 45 }),
  createdAt: createdAt(),
}, (t) => [index('webhook_quarantine_created_idx').on(t.createdAt)]);

/**
 * Операції повернення коштів.
 *
 * Агрегату `orders.refunded_total` недостатньо: два паралельні запити
 * бачать ту саму доступну суму й запускають два повернення. А якщо
 * провайдер виконав повернення й HTTP-відповідь загубилася, повторний
 * запит запустить ще одне.
 *
 * Правило: під блокуванням оплати перевірити бюджет, зарезервувати суму,
 * закомітити операцію, і ЛИШЕ потім робити API-виклик. Таймаут →
 * `unknown` → звірка, НЕ автоматичний повтор.
 *
 * БЮДЖЕТ = captured − SUM(amount) для станів
 *          ('pending', 'in_flight', 'unknown', 'succeeded').
 *
 * Первісна формула віднімала лише `succeeded` та `in_flight` — і це була
 * помилка: нова операція створюється саме як `pending`, а таймаут переводить
 * її в `unknown`. Обидва стани можуть уже представляти фактично повернені
 * гроші, тому їх виключення дозволяло другій операції зайняти ту саму суму.
 *
 * Бюджет звільняється ЛИШЕ після підтвердженого `failed` або скасування
 * до зовнішнього виклику. `unknown` тримає резерв доти, доки звірка не
 * встановить результат.
 */
export const refundOperations = pgTable('refund_operations', {
  id: id(),
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'restrict' }),
  paymentAttemptId: uuid('payment_attempt_id').references(() => paymentAttempts.id, { onDelete: 'restrict' }),
  returnRequestId: uuid('return_request_id'),
  amount: money('amount').notNull(),
  state: operationStateEnum('state').notNull().default('pending'),
  /** Наш незмінний reference, який передається провайдеру */
  localReference: uuid('local_reference').notNull().defaultRandom(),
  providerReference: varchar('provider_reference', { length: 200 }),
  initiatedByUserId: uuid('initiated_by_user_id'),
  reason: text('reason'),
  lastError: text('last_error'),
  createdAt: createdAt(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('refund_local_ref_uq').on(t.localReference),
  index('refund_order_idx').on(t.orderId, t.createdAt),
  index('refund_open_idx').on(t.createdAt)
    .where(sql`${t.state} IN ('pending', 'in_flight', 'unknown')`),
  check('refund_amount_positive', sql`${t.amount} > 0`),
]);

/**
 * Операції створення накладної Нової Пошти.
 *
 * `InternetDocument/save` після таймауту лишає застосунок у стані «не знаю,
 * чи документ створено». Повтор створює другу накладну. Друкований номер
 * ТТН не є достатнім ідентифікатором операції.
 */
export const shipmentOperations = pgTable('shipment_operations', {
  id: id(),
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'restrict' }),
  carrier: varchar('carrier', { length: 40 }).notNull(),
  state: operationStateEnum('state').notNull().default('pending'),
  localReference: uuid('local_reference').notNull().defaultRandom(),
  /** Ref документа у провайдера — не друкований номер */
  providerDocumentRef: varchar('provider_document_ref', { length: 64 }),
  ttn: varchar('ttn', { length: 40 }),
  declaredCost: money('declared_cost'),
  weightGrams: integer('weight_grams'),
  quotedCost: money('quoted_cost'),
  /** Повний запит і відповідь — для відновлення після unknown */
  requestSnapshot: jsonb('request_snapshot'),
  responseSnapshot: jsonb('response_snapshot'),
  lastError: text('last_error'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('shipment_local_ref_uq').on(t.localReference),
  index('shipment_order_idx').on(t.orderId),
  index('shipment_open_idx').on(t.createdAt)
    .where(sql`${t.state} IN ('pending', 'in_flight', 'unknown')`),
]);

/**
 * Серверний checkout intent.
 *
 * Замінює клієнтський idempotency key. Причина: «ключ живе, доки живе
 * сторінка checkout» не працює — перезавантаження сторінки дає новий UUID
 * і друге замовлення, дві вкладки так само.
 *
 * Intent прив'язаний до кошика та його версії й повертається однаковим у
 * всіх вкладках до завершення або явного перезапуску оформлення.
 * `payload_fingerprint` — хеш суттєвих параметрів; той самий intent з
 * іншим payload → 409.
 *
 * ВАЖЛИВО: перевірка завершеного intent виконується ДО повторної
 * резервації. Інакше повтор успішної покупки останньої одиниці повернув би
 * «немає залишку» замість наявного замовлення.
 */
export const checkoutIntents = pgTable('checkout_intents', {
  id: id(),
  cartId: uuid('cart_id').notNull().references(() => carts.id, { onDelete: 'cascade' }),
  cartVersion: integer('cart_version').notNull(),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'cascade' }),
  /** Власник для гостя — токен кошика. Чужий intent використати не можна */
  ownerToken: varchar('owner_token', { length: 64 }).notNull(),
  payloadFingerprint: varchar('payload_fingerprint', { length: 64 }),
  orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('checkout_intent_cart_uq').on(t.cartId, t.cartVersion)
    .where(sql`${t.completedAt} IS NULL`),
  index('checkout_intent_expiry_idx').on(t.expiresAt).where(sql`${t.completedAt} IS NULL`),
]);

/* ═══════════════════════ AUTH (ADR-19) ═══════════════════════ */

/**
 * Auth.js Credentials-провайдер вимагає JWT-сесій — з database strategy він
 * не працює. Тому сесії — JWT із `sid`, а відкликання перевіряється проти
 * цієї таблиці на сервері.
 *
 * Адаптер Drizzle таблиці НЕ створює і НЕ мігрує — попереднє твердження в
 * коментарі до customers.user_id було хибним. Тому auth-таблиці описані
 * тут явно й мігруються разом з усіма.
 */
export const authUsers = pgTable('auth_users', {
  id: id(),
  email: varchar('email', { length: 320 }).notNull(),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('auth_users_email_uq').on(sql`lower(${t.email})`)]);

export const authCredentials = pgTable('auth_credentials', {
  userId: uuid('user_id').primaryKey().references(() => authUsers.id, { onDelete: 'cascade' }),
  /** argon2id. Ніколи не покидає сервер */
  passwordHash: text('password_hash').notNull(),
  passwordUpdatedAt: timestamp('password_updated_at', { withTimezone: true }).notNull().defaultNow(),
  failedAttempts: smallint('failed_attempts').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
});

export const authTotp = pgTable('auth_totp', {
  userId: uuid('user_id').primaryKey().references(() => authUsers.id, { onDelete: 'cascade' }),
  /** Зашифрований секрет, не plaintext */
  secretEncrypted: text('secret_encrypted').notNull(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  lastUsedStep: integer('last_used_step'),
});

export const authRecoveryCodes = pgTable('auth_recovery_codes', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  codeHash: text('code_hash').notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
}, (t) => [index('auth_recovery_user_idx').on(t.userId)]);

/**
 * Реєстр сесій для відкликання. JWT сам собою відкликати не можна, тому
 * `sid` із токена перевіряється тут при кожному адмінському запиті.
 * До підтвердження TOTP повноцінна адміністративна сесія не видається.
 */
export const authSessions = pgTable('auth_sessions', {
  sid: uuid('sid').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  mfaSatisfiedAt: timestamp('mfa_satisfied_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ip: varchar('ip', { length: 45 }),
  userAgent: text('user_agent'),
  createdAt: createdAt(),
}, (t) => [
  index('auth_sessions_user_idx').on(t.userId),
  index('auth_sessions_active_idx').on(t.expiresAt).where(sql`${t.revokedAt} IS NULL`),
]);

/* ═══════════════ ПОДАРУНКОВІ СЕРТИФІКАТИ (ADR-20) ═══════════════ */

export const giftCardStatusEnum = pgEnum('gift_card_status', [
  'pending_issue',  // товар куплено, оплата ще не підтверджена
  'active',
  'depleted',
  'expired',
  'void',           // анульований адміном
]);

export const giftCardTxnEnum = pgEnum('gift_card_txn', [
  'issue',      // випуск при оплаті замовлення-продажу
  'redeem',     // погашення при оплаті іншого замовлення
  'refund',     // повернення коштів на сертифікат
  'adjust',     // ручна коригування адміном
  'void',
]);

/**
 * Подарунковий сертифікат.
 *
 * ЦЕ НЕ ПРОМОКОД. Промокод — правило знижки, грошей не отримано.
 * Сертифікат — передплачений інструмент: гроші отримані при ПРОДАЖІ, і в
 * цей момент виникло ЗОБОВ'ЯЗАННЯ, а не виручка. Виручка визнається при
 * погашенні.
 *
 * Наслідки, які легко зламати:
 *  - Застосовується на кроці ОПЛАТИ (payment_attempts з provider='gift_card'),
 *    а не в pricing. Це не знижка.
 *  - Замовлення може бути оплачене частково сертифікатом, частково карткою.
 *  - У звіті виручки продаж сертифіката НЕ є виручкою — інакше подвійний
 *    облік: спершу при продажу, потім при купівлі за нього.
 *  - Для ПРРО продаж і погашення — дві різні операції.
 *
 * КОД: високої ентропії, не послідовний. У БД лежить ХЕШ; повний код
 * показується покупцю один раз при видачі. `last4` — для відображення
 * в адмінці й кабінеті.
 */
export const giftCards = pgTable('gift_cards', {
  id: id(),
  /** SHA-256(code + pepper). Пошук за кодом — по цьому індексу */
  codeHash: text('code_hash').notNull(),
  last4: varchar('last4', { length: 4 }).notNull(),
  status: giftCardStatusEnum('status').notNull().default('pending_issue'),
  initialAmount: money('initial_amount').notNull(),
  /**
   * Денормалізований баланс. Істина — сума gift_card_transactions;
   * воркер щодня звіряє й алертить про розбіжність (як з reserved_quantity).
   */
  balance: money('balance').notNull(),
  currency: varchar('currency', { length: 3 }).notNull().default('UAH'),
  /** Замовлення, у якому сертифікат КУПИЛИ */
  issuedByOrderId: uuid('issued_by_order_id').references(() => orders.id, { onDelete: 'restrict' }),
  issuedToEmail: varchar('issued_to_email', { length: 320 }),
  issuedToName: varchar('issued_to_name', { length: 240 }),
  senderName: varchar('sender_name', { length: 240 }),
  message: text('message'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  issuedAt: timestamp('issued_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('gift_cards_hash_uq').on(t.codeHash),
  index('gift_cards_status_idx').on(t.status),
  index('gift_cards_order_idx').on(t.issuedByOrderId),
  index('gift_cards_expiry_idx').on(t.expiresAt).where(sql`${t.status} = 'active'`),
  check('gift_cards_initial_positive', sql`${t.initialAmount} > 0`),
  check('gift_cards_balance_range', sql`${t.balance} >= 0 AND ${t.balance} <= ${t.initialAmount}`),
]);

/**
 * Журнал операцій із сертифікатом. Append-only, нічого не оновлюється.
 *
 * Погашення — під `SELECT ... FOR UPDATE` на gift_cards, з перевіркою
 * балансу в тій самій транзакції. Без цього два паралельні замовлення
 * витратять той самий баланс.
 */
export const giftCardTransactions = pgTable('gift_card_transactions', {
  id: hotId(),   // uuidv7: висока частота вставок
  giftCardId: uuid('gift_card_id').notNull().references(() => giftCards.id, { onDelete: 'restrict' }),
  type: giftCardTxnEnum('type').notNull(),
  /** Замовлення, у якому сертифікат ВИКОРИСТАЛИ (для redeem) */
  orderId: uuid('order_id').references(() => orders.id, { onDelete: 'restrict' }),
  paymentAttemptId: uuid('payment_attempt_id')
    .references(() => paymentAttempts.id, { onDelete: 'restrict' }),
  /** Знак відповідає типу: issue/refund додають, redeem віднімає */
  amount: money('amount').notNull(),
  balanceAfter: money('balance_after').notNull(),
  performedByUserId: uuid('performed_by_user_id'),
  note: text('note'),
  createdAt: createdAt(),
}, (t) => [
  index('gift_card_txn_card_idx').on(t.giftCardId, t.createdAt),
  index('gift_card_txn_order_idx').on(t.orderId),
  /** Одне погашення на пару (сертифікат, спроба оплати) — ідемпотентність */
  uniqueIndex('gift_card_txn_redeem_uq').on(t.giftCardId, t.paymentAttemptId)
    .where(sql`${t.type} = 'redeem'`),
  check('gift_card_txn_balance_nonneg', sql`${t.balanceAfter} >= 0`),
]);

/* ═══════════════ ЮРИДИЧНІ ДОКУМЕНТИ (керуються з адмінки) ═══════════════ */

/**
 * Версійовані юридичні документи: оферта, політика конфіденційності,
 * умови повернення. Адмін завантажує PDF або редагує текст.
 *
 * Версійність обов'язкова: `return_requests.policy_version` посилається на
 * редакцію, що діяла на момент запиту, і `hasMerchantReturnPolicy` у JSON-LD
 * мусить збігатися з чинною версією.
 */
export const legalDocuments = pgTable('legal_documents', {
  id: id(),
  kind: varchar('kind', { length: 40 }).notNull(),   // offer | privacy | returns | delivery
  version: varchar('version', { length: 20 }).notNull(),
  locale: varchar('locale', { length: 5 }).notNull(),
  /** Або текст, або файл — принаймні одне */
  bodyHtml: text('body_html'),
  fileUrl: text('file_url'),
  effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
  uploadedByUserId: uuid('uploaded_by_user_id'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('legal_docs_uq').on(t.kind, t.version, t.locale),
  index('legal_docs_current_idx').on(t.kind, t.locale, t.effectiveFrom),
  check('legal_docs_has_content', sql`${t.bodyHtml} IS NOT NULL OR ${t.fileUrl} IS NOT NULL`),
]);

/* ═══════════════ ФІСКАЛЬНІ ДОКУМЕНТИ ═══════════════ */

/**
 * Закладено наперед (відповідь на відкрите питання №1: «чи можемо
 * закласти можливість» — так, ось вона).
 *
 * Модель документів не можна відкладати до реалізації, бо чек повернення
 * мусить посилатися на первинний чек продажу. Якщо продажі якийсь час
 * ідуть без цієї таблиці, зв'язок відновити нічим.
 *
 * Реалізація `FiscalProvider` — після відповіді бухгалтера. Таблиця
 * порожня до того моменту й нічого не блокує.
 */
export const fiscalDocuments = pgTable('fiscal_documents', {
  id: id(),
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'restrict' }),
  /** 'sale' | 'return' */
  kind: varchar('kind', { length: 20 }).notNull(),
  /**
   * Чек повернення посилається на первинний чек продажу.
   * Self-FK був пропущений — без нього CHECK вимагав наявності
   * parent_document_id, але не перевіряв, що такий документ існує.
   */
  parentDocumentId: uuid('parent_document_id')
    .references((): any => fiscalDocuments.id, { onDelete: 'restrict' }),
  refundOperationId: uuid('refund_operation_id')
    .references(() => refundOperations.id, { onDelete: 'restrict' }),
  state: operationStateEnum('state').notNull().default('pending'),
  provider: varchar('provider', { length: 40 }),
  localReference: uuid('local_reference').notNull().defaultRandom(),
  /** Фіскальний номер від ПРРО */
  fiscalNumber: varchar('fiscal_number', { length: 64 }),
  receiptUrl: text('receipt_url'),
  amount: money('amount').notNull(),
  /** Снапшот позицій на момент фіскалізації, з УКТЗЕД */
  itemsSnapshot: jsonb('items_snapshot'),
  attempts: smallint('attempts').notNull().default(0),
  lastError: text('last_error'),
  issuedAt: timestamp('issued_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('fiscal_docs_local_ref_uq').on(t.localReference),
  index('fiscal_docs_order_idx').on(t.orderId),
  /** Екран «замовлення без чека» в адмінці */
  index('fiscal_docs_open_idx').on(t.createdAt)
    .where(sql`${t.state} IN ('pending', 'in_flight', 'unknown', 'failed')`),
  check('fiscal_docs_kind', sql`${t.kind} IN ('sale', 'return')`),
  check('fiscal_docs_return_has_parent', sql`
    ${t.kind} <> 'return' OR ${t.parentDocumentId} IS NOT NULL
  `),
]);

/* ═══════════════════════════ СЛУЖБОВЕ ═══════════════════════════ */

export const settings = pgTable('settings', {
  key: varchar('key', { length: 120 }).primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: updatedAt(),
});
/**
 * Очікувані ключі:
 *  free_shipping_threshold  { amount: 200000 }
 *  cod_max_amount           { amount: 500000 }
 *  payment_providers        { mono: true, wayforpay: false, cod: true, bank_transfer: false }
 *  contacts                 { phone, email, telegram, viber, address }
 *  analytics                { ga4_id, gtm_id, meta_pixel_id, gsc_verification }
 *  reservation_ttl          { card_minutes: 30, transfer_hours: 24, cod_hours: 2 }
 *  cod_limits               { max_pending_per_phone: 3 }
 *  redirects_version        { v: 1 }   -- інвалідація кешу в proxy.ts (ADR-14)
 */

export const adminUsers = pgTable('admin_users', {
  userId: uuid('user_id').primaryKey(),
  role: adminRoleEnum('role').notNull().default('manager'),
  isActive: boolean('is_active').notNull().default(true),
  totpEnabled: boolean('totp_enabled').notNull().default(false),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index('admin_users_active_idx').on(t.isActive)]);

export const auditLog = pgTable('audit_log', {
  id: hotId(),   // uuidv7: висока частота вставок
  userId: uuid('user_id'),
  action: varchar('action', { length: 60 }).notNull(),   // create | update | delete | refund | transition
  entity: varchar('entity', { length: 60 }).notNull(),
  entityId: varchar('entity_id', { length: 64 }),
  diff: jsonb('diff'),
  ip: varchar('ip', { length: 45 }),
  createdAt: createdAt(),
}, (t) => [
  index('audit_entity_idx').on(t.entity, t.entityId, t.createdAt),
  index('audit_user_idx').on(t.userId, t.createdAt),
]);

/* ═══════════════════════════ RELATIONS ═══════════════════════════ */

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  parent: one(categories, { fields: [categories.parentId], references: [categories.id], relationName: 'tree' }),
  children: many(categories, { relationName: 'tree' }),
  products: many(products),
}));

export const productsRelations = relations(products, ({ one, many }) => ({
  category: one(categories, { fields: [products.categoryId], references: [categories.id] }),
  images: many(productImages),
  variants: many(productVariants),
  attributeValues: many(productAttributeValues),
  reviews: many(reviews),
}));

export const productVariantsRelations = relations(productVariants, ({ one, many }) => ({
  product: one(products, { fields: [productVariants.productId], references: [products.id] }),
  size: one(sizes, { fields: [productVariants.sizeId], references: [sizes.id] }),
  color: one(colors, { fields: [productVariants.colorId], references: [colors.id] }),
  reservations: many(stockReservations),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  customer: one(customers, { fields: [orders.customerId], references: [customers.id] }),
  items: many(orderItems),
  history: many(orderStatusHistory),
  paymentEvents: many(paymentEvents),
  paymentAttempts: many(paymentAttempts),
  reservations: many(stockReservations),
  returnRequests: many(returnRequests),
}));

export const paymentAttemptsRelations = relations(paymentAttempts, ({ one }) => ({
  order: one(orders, { fields: [paymentAttempts.orderId], references: [orders.id] }),
}));

export const returnRequestsRelations = relations(returnRequests, ({ one, many }) => ({
  order: one(orders, { fields: [returnRequests.orderId], references: [orders.id] }),
  customer: one(customers, { fields: [returnRequests.customerId], references: [customers.id] }),
  items: many(returnRequestItems),
}));

export const returnRequestItemsRelations = relations(returnRequestItems, ({ one }) => ({
  request: one(returnRequests, {
    fields: [returnRequestItems.returnRequestId],
    references: [returnRequests.id],
  }),
  orderItem: one(orderItems, {
    fields: [returnRequestItems.orderItemId],
    references: [orderItems.id],
  }),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
  product: one(products, { fields: [orderItems.productId], references: [products.id] }),
  variant: one(productVariants, { fields: [orderItems.variantId], references: [productVariants.id] }),
}));

export const customersRelations = relations(customers, ({ many }) => ({
  addresses: many(addresses),
  orders: many(orders),
  reviews: many(reviews),
  wishlist: many(wishlistItems),
}));

/* ═══════════════════════════════════════════════════════════════════
   ДОДАТКОВИЙ SQL, який Drizzle не виражає декларативно.
   Помістити у міграцію вручну.
   ═══════════════════════════════════════════════════════════════════

-- 1. Розширення — ОКРЕМОЮ РАННЬОЮ МІГРАЦІЄЮ, до будь-яких залежних індексів.
--
--    ПІДТВЕРДЖЕНО ГЕНЕРАЦІЄЮ, не теорією: `drizzle-kit generate` створює
--    міграцію 0000 на 1014 рядків, у якій НЕМАЄ жодного CREATE EXTENSION,
--    але є три індекси з gin_trgm_ops (np_settlements, np_warehouses,
--    products). На порожній БД ця міграція ВПАДЕ.
--
--    Тому: створити міграцію 0000_extensions.sql ВРУЧНУ і перенумерувати
--    згенеровану в 0001. Drizzle сам розширень не додає й порядку не знає.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- для access-токенів замовлень

-- 2. Номери. lpad() задає КІНЦЕВУ довжину, тому обрізає довші значення:
--    після 999 999 замовлень номер став би конфліктувати з UNIQUE.
CREATE SEQUENCE order_number_seq START 1;

CREATE OR REPLACE FUNCTION next_order_number() RETURNS text AS $$
DECLARE v text;
BEGIN
  v := nextval('order_number_seq')::text;
  RETURN 'LS-' || to_char(now(), 'YYYY') || '-' ||
         lpad(v, greatest(6, length(v)), '0');
END;
$$ LANGUAGE plpgsql;

-- 2b. Номер запиту на повернення
CREATE SEQUENCE return_request_seq START 1;

CREATE OR REPLACE FUNCTION next_return_number() RETURNS text AS $$
DECLARE v text;
BEGIN
  v := nextval('return_request_seq')::text;
  RETURN 'RET-' || to_char(now(), 'YYYY') || '-' ||
         lpad(v, greatest(5, length(v)), '0');
END;
$$ LANGUAGE plpgsql;

-- Тести обов'язкові на межах 99999/100000 і 999999/1000000.

-- 3. ПОШУК: український hunspell + тригер (НЕ generated column).
--
--    Вбудованої конфігурації 'ukrainian' у Postgres немає, але образ ми
--    будуємо самі. У Dockerfile Postgres покласти uk_ua.affix / uk_ua.dict
--    у $SHAREDIR/tsearch_data.
--
--    ЧОМУ ТРИГЕР, А НЕ GENERATED ALWAYS: generated column вимагає
--    IMMUTABLE-виразу. `unaccent()` — STABLE (залежить від словника).
--    Конфігурація з кастомним словником — так само. Міграція б упала.
CREATE TEXT SEARCH DICTIONARY ukrainian_hunspell (
  TEMPLATE  = ispell,
  DictFile  = uk_ua,
  AffFile   = uk_ua,
  StopWords = ukrainian
);

CREATE TEXT SEARCH CONFIGURATION ukrainian (COPY = simple);

ALTER TEXT SEARCH CONFIGURATION ukrainian
  ALTER MAPPING FOR word, hword, hword_part
  WITH ukrainian_hunspell, simple;   -- simple як fallback для невідомих слів

CREATE OR REPLACE FUNCTION products_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('ukrainian', unaccent(coalesce(NEW.name_uk, ''))), 'A') ||
    setweight(to_tsvector('english',   unaccent(coalesce(NEW.name_en, ''))), 'A') ||
    setweight(to_tsvector('simple',    unaccent(coalesce(NEW.brand,   ''))), 'B') ||
    setweight(to_tsvector('simple',    coalesce(NEW.sku,     '')),           'B') ||
    setweight(to_tsvector('ukrainian', unaccent(coalesce(NEW.short_description_uk, ''))), 'C') ||
    setweight(to_tsvector('english',   unaccent(coalesce(NEW.short_description_en, ''))), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER products_search_vector_trg
  BEFORE INSERT OR UPDATE OF name_uk, name_en, brand, sku,
                             short_description_uk, short_description_en
  ON products FOR EACH ROW EXECUTE FUNCTION products_search_vector_update();

-- Backfill після створення тригера.
-- УВАГА: `SET updated_at = updated_at` НЕ спрацює. PostgreSQL визначає
-- запуск column-specific тригера за колонками в SET, а не за фактом
-- оновлення рядка. Міграція пройшла б успішно, а старі товари лишилися б
-- із порожнім вектором — і перевірка на новому товарі дефект не побачила б.
UPDATE products SET name_uk = name_uk;

-- Потрібен також файл стоп-слів: StopWords = ukrainian очікує
-- ukrainian.stop у $SHAREDIR/tsearch_data. Dockerfile мусить класти
-- uk_ua.affix, uk_ua.dict І ukrainian.stop — інакше CREATE TEXT SEARCH
-- DICTIONARY впаде.

-- 3b. Нормалізовані колонки для trigram-fallback.
--     Індекс мусить стояти на ТОМУ САМОМУ виразі, який шукається —
--     індекс на сирому name_uk не використовується запитом
--     через unaccent(name_uk).
ALTER TABLE products
  ADD COLUMN search_norm text
  GENERATED ALWAYS AS (
    lower(coalesce(name_uk, '') || ' ' || coalesce(name_en, '') || ' ' ||
          coalesce(brand, '')   || ' ' || coalesce(sku, ''))
  ) STORED;
-- ^ GENERATED тут допустимий: lower() і || — IMMUTABLE, unaccent НЕ використано.
--
-- STORED вказано ЯВНО і це обов'язково: у PostgreSQL 18 generated columns
-- за замовчуванням VIRTUAL (обчислюються при читанні). Віртуальна колонка
-- не індексується, тому GIN-індекс нижче просто не побудувався б.

CREATE INDEX products_search_norm_trgm_idx
  ON products USING gin (search_norm gin_trgm_ops);

-- Пріоритет у запиті: точний SKU → full-text → word_similarity fallback
-- (оператор <<% з pg_trgm, а не similarity по всьому рядку — інакше
--  коротке слово проти довгої назви дає слабкий score).

-- 3c. Предметні синоніми замість нового пошукового сервісу.
--     Для обмеженого каталогу дешевше за Meilisearch:
--   CREATE TEXT SEARCH DICTIONARY ukrainian_synonyms (
--     TEMPLATE = synonym, SYNONYMS = lingerie_uk
--   );

-- 4. updated_at
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
-- навісити на products, product_variants, orders, categories, customers, carts

-- 5. АТОМАРНЕ РЕЗЕРВУВАННЯ (ADR-3).
--    Єдиний правильний спосіб. Ніколи не SELECT-потім-UPDATE.
--    Нуль рядків => товару немає => відкат транзакції.
--
--    UPDATE product_variants
--       SET reserved_quantity = reserved_quantity + $2
--     WHERE id = $1
--       AND is_active = true
--       AND stock_quantity - reserved_quantity >= $2
--    RETURNING id;

-- 6. Матеріалізовані в'юшки для звітів (фаза 8),
--    REFRESH CONCURRENTLY воркером щогодини:
--      mv_daily_sales, mv_product_performance, mv_size_velocity, mv_customer_ltv

-- 7. Звірка денормалізованого reserved_quantity (воркер stock:reconcile).
--    Розбіжність => алерт, не тихе виправлення:
--
--    SELECT v.id, v.reserved_quantity, coalesce(sum(r.quantity), 0) AS actual
--      FROM product_variants v
--      LEFT JOIN stock_reservations r
--             ON r.variant_id = v.id AND r.released_at IS NULL
--     GROUP BY v.id, v.reserved_quantity
--    HAVING v.reserved_quantity <> coalesce(sum(r.quantity), 0);

-- 8. Часткові UNIQUE для ліміту промокоду на клієнта створити
--    окремим виразом, залежно від per_customer_limit.

-- 8b. FK з orders.current_payment_attempt_id -> payment_attempts.id
--     додається ОКРЕМОЮ міграцією після створення обох таблиць
--     (циклічне посилання):
--
--     ALTER TABLE orders
--       ADD CONSTRAINT orders_current_attempt_fk
--       FOREIGN KEY (current_payment_attempt_id)
--       REFERENCES payment_attempts(id) ON DELETE SET NULL;

-- 8c. ЗВІРКА СУМ (воркер orders:reconcile-totals, ADR-15).
--     Ці інваріанти НЕ виражаються як CHECK — вони cross-table.
--     Розбіжність у копійку ламає фіскальний чек і часткове повернення,
--     тому звірка алертить, а не виправляє тихо:
--
--     SELECT o.id, o.order_number, o.subtotal, o.discount_total,
--            sum(i.line_total) AS lines_total,
--            sum(i.line_discount) AS lines_discount
--       FROM orders o JOIN order_items i ON i.order_id = o.id
--      GROUP BY o.id, o.order_number, o.subtotal, o.discount_total
--     HAVING o.discount_total <> sum(i.line_discount)
--         OR o.subtotal <> sum(i.line_total) + sum(i.line_discount);

-- 9. Очистка переглядів товарів (воркер, щодня).
--    Без цього таблиця росте необмежено:
--
--    DELETE FROM product_views WHERE viewed_on < current_date - interval '90 days';

-- 10. Індекс для звіту «переглядали, але не купували» (фаза 10).
--     Створювати разом зі звітом, не раніше — до наповнення даними він
--     тільки сповільнює вставку.
   ═══════════════════════════════════════════════════════════════════ */
