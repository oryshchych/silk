CREATE TYPE "public"."admin_role" AS ENUM('owner', 'admin', 'manager', 'content');--> statement-breakpoint
CREATE TYPE "public"."attribute_type" AS ENUM('select', 'multiselect', 'boolean', 'text');--> statement-breakpoint
CREATE TYPE "public"."product_badge" AS ENUM('none', 'new', 'sale', 'bestseller', 'last_units');--> statement-breakpoint
CREATE TYPE "public"."delivery_method" AS ENUM('np_warehouse', 'np_courier', 'ukrposhta', 'pickup');--> statement-breakpoint
CREATE TYPE "public"."fiscal_status" AS ENUM('not_required', 'pending', 'issued', 'failed', 'refund_issued');--> statement-breakpoint
CREATE TYPE "public"."fit_feedback" AS ENUM('small', 'true_to_size', 'large');--> statement-breakpoint
CREATE TYPE "public"."gift_card_status" AS ENUM('pending_issue', 'active', 'depleted', 'expired', 'void');--> statement-breakpoint
CREATE TYPE "public"."gift_card_txn" AS ENUM('issue', 'redeem', 'refund', 'adjust', 'void');--> statement-breakpoint
CREATE TYPE "public"."np_warehouse_type" AS ENUM('branch', 'postomat', 'cargo');--> statement-breakpoint
CREATE TYPE "public"."operation_state" AS ENUM('pending', 'in_flight', 'succeeded', 'failed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'returned');--> statement-breakpoint
CREATE TYPE "public"."payment_provider" AS ENUM('mono', 'wayforpay', 'cod', 'bank_transfer', 'gift_card');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'authorized', 'paid', 'failed', 'expired', 'refunded', 'partially_refunded');--> statement-breakpoint
CREATE TYPE "public"."product_kind" AS ENUM('physical', 'gift_card');--> statement-breakpoint
CREATE TYPE "public"."promo_scope" AS ENUM('all', 'category', 'product');--> statement-breakpoint
CREATE TYPE "public"."promo_type" AS ENUM('percent', 'fixed', 'free_shipping');--> statement-breakpoint
CREATE TYPE "public"."relation_kind" AS ENUM('similar', 'cross_sell', 'up_sell', 'accessory');--> statement-breakpoint
CREATE TYPE "public"."return_reason" AS ENUM('defect', 'wrong_item', 'not_as_described', 'changed_mind', 'wrong_size', 'other');--> statement-breakpoint
CREATE TYPE "public"."return_status" AS ENUM('requested', 'approved', 'rejected', 'in_transit', 'received', 'refunded', 'closed');--> statement-breakpoint
CREATE TYPE "public"."size_system" AS ENUM('bra', 'panty', 'apparel', 'onesize');--> statement-breakpoint
CREATE TABLE "addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"recipient_name" varchar(240) NOT NULL,
	"phone" varchar(20) NOT NULL,
	"delivery_method" "delivery_method" NOT NULL,
	"settlement_ref" varchar(64),
	"settlement_name" varchar(240),
	"warehouse_ref" varchar(64),
	"warehouse_name" text,
	"street" varchar(240),
	"house" varchar(40),
	"apartment" varchar(40),
	"postcode" varchar(10),
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_users" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"role" "admin_role" DEFAULT 'manager' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attribute_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attribute_id" uuid NOT NULL,
	"slug" varchar(80) NOT NULL,
	"value_uk" varchar(160) NOT NULL,
	"value_en" varchar(160) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attributes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(64) NOT NULL,
	"name_uk" varchar(120) NOT NULL,
	"name_en" varchar(120) NOT NULL,
	"type" "attribute_type" DEFAULT 'select' NOT NULL,
	"is_filterable" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid,
	"action" varchar(60) NOT NULL,
	"entity" varchar(60) NOT NULL,
	"entity_id" varchar(64),
	"diff" jsonb,
	"ip" varchar(45),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_credentials" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"password_hash" text NOT NULL,
	"password_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failed_attempts" smallint DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auth_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"sid" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"mfa_satisfied_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" varchar(45),
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_totp" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"secret_encrypted" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"last_used_step" integer
);
--> statement-breakpoint
CREATE TABLE "auth_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"email_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "banners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title_uk" varchar(200),
	"title_en" varchar(200),
	"subtitle_uk" varchar(300),
	"subtitle_en" varchar(300),
	"image_desktop_url" text NOT NULL,
	"image_mobile_url" text NOT NULL,
	"cta_label_uk" varchar(80),
	"cta_label_en" varchar(80),
	"href" text,
	"position" varchar(40) DEFAULT 'home_hero' NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blog_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(200) NOT NULL,
	"title_uk" varchar(300) NOT NULL,
	"title_en" varchar(300) NOT NULL,
	"excerpt_uk" varchar(500),
	"excerpt_en" varchar(500),
	"content_uk" text,
	"content_en" text,
	"cover_url" text,
	"author" varchar(160),
	"tags" text[],
	"meta_title_uk" varchar(200),
	"meta_title_en" varchar(200),
	"meta_description_uk" varchar(400),
	"meta_description_en" varchar(400),
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cart_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cart_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cart_items_qty_positive" CHECK ("cart_items"."quantity" > 0 AND "cart_items"."quantity" <= 99)
);
--> statement-breakpoint
CREATE TABLE "carts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" varchar(64) NOT NULL,
	"customer_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"promo_code" varchar(64),
	"converted_order_id" uuid,
	"converted_at" timestamp with time zone,
	"abandoned_email_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"slug" varchar(160) NOT NULL,
	"name_uk" varchar(200) NOT NULL,
	"name_en" varchar(200) NOT NULL,
	"description_uk" text,
	"description_en" text,
	"seo_text_uk" text,
	"seo_text_en" text,
	"image_url" text,
	"size_system" "size_system",
	"depth" smallint DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"meta_title_uk" varchar(200),
	"meta_title_en" varchar(200),
	"meta_description_uk" varchar(400),
	"meta_description_en" varchar(400),
	"noindex" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_no_self_parent" CHECK ("categories"."parent_id" IS NULL OR "categories"."parent_id" <> "categories"."id"),
	CONSTRAINT "categories_depth_range" CHECK ("categories"."depth" BETWEEN 0 AND 3)
);
--> statement-breakpoint
CREATE TABLE "checkout_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cart_id" uuid NOT NULL,
	"cart_version" integer NOT NULL,
	"customer_id" uuid,
	"owner_token" varchar(64) NOT NULL,
	"payload_fingerprint" varchar(64),
	"order_id" uuid,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "colors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(80) NOT NULL,
	"name_uk" varchar(80) NOT NULL,
	"name_en" varchar(80) NOT NULL,
	"hex" varchar(7) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "colors_hex_format" CHECK ("colors"."hex" ~ '^#[0-9A-Fa-f]{6}$')
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"email" varchar(320) NOT NULL,
	"phone" varchar(20),
	"first_name" varchar(120),
	"last_name" varchar(120),
	"birth_date" timestamp,
	"accepts_marketing" boolean DEFAULT false NOT NULL,
	"preferred_bra_size_id" uuid,
	"preferred_apparel_size_id" uuid,
	"tags" text[],
	"admin_note" text,
	"locale" varchar(5) DEFAULT 'uk' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_email_format" CHECK ("customers"."email" ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);
--> statement-breakpoint
CREATE TABLE "fiscal_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"parent_document_id" uuid,
	"refund_operation_id" uuid,
	"state" "operation_state" DEFAULT 'pending' NOT NULL,
	"provider" varchar(40),
	"local_reference" uuid DEFAULT gen_random_uuid() NOT NULL,
	"fiscal_number" varchar(64),
	"receipt_url" text,
	"amount" integer NOT NULL,
	"items_snapshot" jsonb,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"last_error" text,
	"issued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fiscal_docs_kind" CHECK ("fiscal_documents"."kind" IN ('sale', 'return')),
	CONSTRAINT "fiscal_docs_return_has_parent" CHECK (
    "fiscal_documents"."kind" <> 'return' OR "fiscal_documents"."parent_document_id" IS NOT NULL
  )
);
--> statement-breakpoint
CREATE TABLE "gift_card_transactions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"gift_card_id" uuid NOT NULL,
	"type" "gift_card_txn" NOT NULL,
	"order_id" uuid,
	"payment_attempt_id" uuid,
	"amount" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"performed_by_user_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gift_card_txn_balance_nonneg" CHECK ("gift_card_transactions"."balance_after" >= 0)
);
--> statement-breakpoint
CREATE TABLE "gift_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" text NOT NULL,
	"last4" varchar(4) NOT NULL,
	"status" "gift_card_status" DEFAULT 'pending_issue' NOT NULL,
	"initial_amount" integer NOT NULL,
	"balance" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'UAH' NOT NULL,
	"issued_by_order_id" uuid,
	"issued_to_email" varchar(320),
	"issued_to_name" varchar(240),
	"sender_name" varchar(240),
	"message" text,
	"expires_at" timestamp with time zone,
	"issued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gift_cards_initial_positive" CHECK ("gift_cards"."initial_amount" > 0),
	CONSTRAINT "gift_cards_balance_range" CHECK ("gift_cards"."balance" >= 0 AND "gift_cards"."balance" <= "gift_cards"."initial_amount")
);
--> statement-breakpoint
CREATE TABLE "legal_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" varchar(40) NOT NULL,
	"version" varchar(20) NOT NULL,
	"locale" varchar(5) NOT NULL,
	"body_html" text,
	"file_url" text,
	"effective_from" timestamp with time zone NOT NULL,
	"uploaded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legal_docs_has_content" CHECK ("legal_documents"."body_html" IS NOT NULL OR "legal_documents"."file_url" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "newsletter_subscribers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"locale" varchar(5) DEFAULT 'uk' NOT NULL,
	"source" varchar(60),
	"confirmed_at" timestamp with time zone,
	"unsubscribed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "np_settlements" (
	"ref" varchar(64) PRIMARY KEY NOT NULL,
	"name_uk" varchar(240) NOT NULL,
	"area_name_uk" varchar(240),
	"region_name_uk" varchar(240),
	"settlement_type_uk" varchar(80),
	"warehouses_count" integer DEFAULT 0 NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "np_warehouses" (
	"ref" varchar(64) PRIMARY KEY NOT NULL,
	"settlement_ref" varchar(64) NOT NULL,
	"number" varchar(20) NOT NULL,
	"description_uk" text NOT NULL,
	"type" "np_warehouse_type" DEFAULT 'branch' NOT NULL,
	"max_weight_kg" real,
	"latitude" real,
	"longitude" real,
	"schedule_uk" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid,
	"variant_id" uuid,
	"product_uid_snapshot" uuid NOT NULL,
	"variant_uid_snapshot" uuid NOT NULL,
	"name_snapshot" varchar(300) NOT NULL,
	"sku_snapshot" varchar(64) NOT NULL,
	"brand_snapshot" varchar(120),
	"size_label" varchar(20) NOT NULL,
	"size_system_snapshot" varchar(20),
	"color_name" varchar(80) NOT NULL,
	"category_path_snapshot" text,
	"image_url_snapshot" text,
	"uktzed_snapshot" varchar(20),
	"unit_price" integer NOT NULL,
	"line_discount" integer DEFAULT 0 NOT NULL,
	"unit_cost_snapshot" integer,
	"quantity" integer NOT NULL,
	"line_total" integer NOT NULL,
	CONSTRAINT "order_items_qty_positive" CHECK ("order_items"."quantity" > 0),
	CONSTRAINT "order_items_discount_nonneg" CHECK ("order_items"."line_discount" >= 0),
	CONSTRAINT "order_items_line_math" CHECK (
    "order_items"."line_total" = "order_items"."unit_price" * "order_items"."quantity" - "order_items"."line_discount"
    AND "order_items"."line_total" >= 0
  )
);
--> statement-breakpoint
CREATE TABLE "order_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"from_status" varchar(40),
	"to_status" varchar(40) NOT NULL,
	"field" varchar(20) DEFAULT 'status' NOT NULL,
	"changed_by_user_id" uuid,
	"source" varchar(40) NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"order_number" varchar(32) NOT NULL,
	"checkout_intent_id" uuid,
	"customer_id" uuid,
	"status" "order_status" DEFAULT 'pending' NOT NULL,
	"payment_status" "payment_status" DEFAULT 'pending' NOT NULL,
	"payment_provider" "payment_provider",
	"current_payment_attempt_id" uuid,
	"provider_payment_id" varchar(128),
	"fiscal_status" "fiscal_status" DEFAULT 'not_required' NOT NULL,
	"fiscal_receipt_id" varchar(128),
	"fiscal_receipt_url" text,
	"fiscal_error" text,
	"fiscal_attempts" smallint DEFAULT 0 NOT NULL,
	"customer_email" varchar(320) NOT NULL,
	"customer_phone" varchar(20) NOT NULL,
	"customer_name" varchar(240) NOT NULL,
	"delivery_method" "delivery_method" NOT NULL,
	"delivery_settlement_ref" varchar(64),
	"delivery_settlement_name" varchar(240),
	"delivery_warehouse_ref" varchar(64),
	"delivery_warehouse_name" text,
	"delivery_address" text,
	"ttn" varchar(40),
	"subtotal" integer NOT NULL,
	"discount_total" integer DEFAULT 0 NOT NULL,
	"shipping_total" integer DEFAULT 0 NOT NULL,
	"adjustment_total" integer DEFAULT 0 NOT NULL,
	"total" integer NOT NULL,
	"captured_total" integer DEFAULT 0 NOT NULL,
	"refunded_total" integer DEFAULT 0 NOT NULL,
	"shipping_cost_actual" integer,
	"shipping_paid_by" varchar(10) DEFAULT 'recipient' NOT NULL,
	"access_token_hash" text,
	"currency" varchar(3) DEFAULT 'UAH' NOT NULL,
	"promo_code" varchar(64),
	"locale" varchar(5) DEFAULT 'uk' NOT NULL,
	"comment" text,
	"admin_note" text,
	"ip" varchar(45),
	"user_agent" text,
	"utm_source" varchar(120),
	"utm_medium" varchar(120),
	"utm_campaign" varchar(200),
	"paid_at" timestamp with time zone,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_total_nonneg" CHECK ("orders"."total" >= 0),
	CONSTRAINT "orders_discount_nonneg" CHECK ("orders"."discount_total" >= 0),
	CONSTRAINT "orders_refund_lte_captured" CHECK ("orders"."refunded_total" <= "orders"."captured_total"),
	CONSTRAINT "orders_captured_nonneg" CHECK ("orders"."captured_total" >= 0),
	CONSTRAINT "orders_shipping_payer" CHECK ("orders"."shipping_paid_by" IN ('recipient', 'sender')),
	CONSTRAINT "orders_total_math" CHECK (
    "orders"."total" = "orders"."subtotal" - "orders"."discount_total" + "orders"."shipping_total" + "orders"."adjustment_total"
  )
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"topic" varchar(80) NOT NULL,
	"payload" jsonb NOT NULL,
	"dedup_key" varchar(200),
	"attempts" smallint DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(160) NOT NULL,
	"title_uk" varchar(300) NOT NULL,
	"title_en" varchar(300) NOT NULL,
	"content_uk" text,
	"content_en" text,
	"meta_title_uk" varchar(200),
	"meta_title_en" varchar(200),
	"meta_description_uk" varchar(400),
	"meta_description_en" varchar(400),
	"noindex" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"order_id" uuid NOT NULL,
	"attempt_number" smallint NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"local_reference" uuid DEFAULT gen_random_uuid() NOT NULL,
	"external_id" varchar(128),
	"redirect_url" text,
	"state" "operation_state" DEFAULT 'pending' NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"amount" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'UAH' NOT NULL,
	"captured_amount" integer DEFAULT 0 NOT NULL,
	"failure_reason" text,
	"expires_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_attempts_num_positive" CHECK ("payment_attempts"."attempt_number" > 0),
	CONSTRAINT "payment_attempts_amount_positive" CHECK ("payment_attempts"."amount" > 0),
	CONSTRAINT "payment_attempts_captured_lte" CHECK ("payment_attempts"."captured_amount" <= "payment_attempts"."amount")
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"order_id" uuid,
	"payment_attempt_id" uuid,
	"provider" "payment_provider" NOT NULL,
	"message_key" varchar(200) NOT NULL,
	"state_version" timestamp with time zone,
	"event_type" varchar(80),
	"mapped_status" "payment_status",
	"amount" integer,
	"currency" varchar(3),
	"raw_payload" jsonb NOT NULL,
	"applied_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_attribute_values" (
	"product_id" uuid NOT NULL,
	"attribute_value_id" uuid NOT NULL,
	CONSTRAINT "product_attribute_values_product_id_attribute_value_id_pk" PRIMARY KEY("product_id","attribute_value_id")
);
--> statement-breakpoint
CREATE TABLE "product_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"color_id" uuid,
	"url" text NOT NULL,
	"variants" jsonb,
	"alt_uk" varchar(300),
	"alt_en" varchar(300),
	"width" integer,
	"height" integer,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"size_id" uuid NOT NULL,
	"color_id" uuid NOT NULL,
	"sku" varchar(64) NOT NULL,
	"barcode" varchar(64),
	"price_override" integer,
	"stock_quantity" integer DEFAULT 0 NOT NULL,
	"reserved_quantity" integer DEFAULT 0 NOT NULL,
	"weight_grams" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variants_stock_nonneg" CHECK ("product_variants"."stock_quantity" >= 0),
	CONSTRAINT "variants_reserved_nonneg" CHECK ("product_variants"."reserved_quantity" >= 0),
	CONSTRAINT "variants_price_positive" CHECK ("product_variants"."price_override" IS NULL OR "product_variants"."price_override" > 0)
);
--> statement-breakpoint
CREATE TABLE "product_views" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"product_id" uuid NOT NULL,
	"session_hash" varchar(64) NOT NULL,
	"viewed_on" date DEFAULT current_date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku" varchar(64) NOT NULL,
	"slug" varchar(200) NOT NULL,
	"brand" varchar(120) NOT NULL,
	"kind" "product_kind" DEFAULT 'physical' NOT NULL,
	"category_id" uuid NOT NULL,
	"name_uk" varchar(300) NOT NULL,
	"name_en" varchar(300) NOT NULL,
	"short_description_uk" varchar(500),
	"short_description_en" varchar(500),
	"description_uk" text,
	"description_en" text,
	"composition_uk" text,
	"composition_en" text,
	"care_uk" text,
	"care_en" text,
	"base_price" integer NOT NULL,
	"compare_at_price" integer,
	"cost_price" integer,
	"weight_grams" integer DEFAULT 200 NOT NULL,
	"uktzed_code" varchar(20),
	"is_active" boolean DEFAULT false NOT NULL,
	"is_featured" boolean DEFAULT false NOT NULL,
	"badge" "product_badge" DEFAULT 'none' NOT NULL,
	"rating_avg" real,
	"reviews_count" integer DEFAULT 0 NOT NULL,
	"fit_true_count" integer DEFAULT 0 NOT NULL,
	"fit_total_count" integer DEFAULT 0 NOT NULL,
	"meta_title_uk" varchar(200),
	"meta_title_en" varchar(200),
	"meta_description_uk" varchar(400),
	"meta_description_en" varchar(400),
	"og_image_url" text,
	"noindex" boolean DEFAULT false NOT NULL,
	"search_vector" "tsvector",
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_price_positive" CHECK ("products"."base_price" > 0),
	CONSTRAINT "products_compare_gt_price" CHECK (
    "products"."compare_at_price" IS NULL OR "products"."compare_at_price" > "products"."base_price"
  ),
	CONSTRAINT "products_cost_nonneg" CHECK ("products"."cost_price" IS NULL OR "products"."cost_price" >= 0),
	CONSTRAINT "products_weight_by_kind" CHECK (
    ("products"."kind" <> 'physical' AND "products"."weight_grams" >= 0)
    OR ("products"."kind" = 'physical' AND "products"."weight_grams" > 0)
  ),
	CONSTRAINT "products_rating_range" CHECK ("products"."rating_avg" IS NULL OR "products"."rating_avg" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "promo_code_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"promo_code_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"customer_id" uuid,
	"discount_amount" integer NOT NULL,
	"state" varchar(20) DEFAULT 'consumed' NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_redemption_state" CHECK ("promo_code_redemptions"."state" IN ('consumed', 'released'))
);
--> statement-breakpoint
CREATE TABLE "promo_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(64) NOT NULL,
	"description" varchar(300),
	"type" "promo_type" NOT NULL,
	"value" integer NOT NULL,
	"max_discount_amount" integer,
	"min_order_total" integer DEFAULT 0 NOT NULL,
	"max_uses" integer,
	"uses_count" integer DEFAULT 0 NOT NULL,
	"per_customer_limit" integer,
	"scope" "promo_scope" DEFAULT 'all' NOT NULL,
	"scope_category_id" uuid,
	"scope_product_id" uuid,
	"stackable" boolean DEFAULT false NOT NULL,
	"excludes_discounted_items" boolean DEFAULT false NOT NULL,
	"first_order_only" boolean DEFAULT false NOT NULL,
	"excludes_gift_cards" boolean DEFAULT true NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_value_range" CHECK (
    ("promo_codes"."type" <> 'percent') OR ("promo_codes"."value" BETWEEN 1 AND 100)
  ),
	CONSTRAINT "promo_uses_lte_max" CHECK ("promo_codes"."max_uses" IS NULL OR "promo_codes"."uses_count" <= "promo_codes"."max_uses"),
	CONSTRAINT "promo_uses_nonneg" CHECK ("promo_codes"."uses_count" >= 0),
	CONSTRAINT "promo_dates_order" CHECK (
    "promo_codes"."starts_at" IS NULL OR "promo_codes"."ends_at" IS NULL OR "promo_codes"."starts_at" < "promo_codes"."ends_at"
  ),
	CONSTRAINT "promo_cap_only_percent" CHECK (
    "promo_codes"."max_discount_amount" IS NULL OR "promo_codes"."type" = 'percent'
  ),
	CONSTRAINT "promo_per_customer_positive" CHECK (
    "promo_codes"."per_customer_limit" IS NULL OR "promo_codes"."per_customer_limit" > 0
  )
);
--> statement-breakpoint
CREATE TABLE "redirects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_path" varchar(500) NOT NULL,
	"to_path" varchar(500) NOT NULL,
	"status_code" smallint DEFAULT 301 NOT NULL,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "redirects_status_valid" CHECK ("redirects"."status_code" IN (301, 302, 410)),
	CONSTRAINT "redirects_not_loop" CHECK ("redirects"."from_path" <> "redirects"."to_path")
);
--> statement-breakpoint
CREATE TABLE "refund_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"payment_attempt_id" uuid,
	"return_request_id" uuid,
	"amount" integer NOT NULL,
	"state" "operation_state" DEFAULT 'pending' NOT NULL,
	"local_reference" uuid DEFAULT gen_random_uuid() NOT NULL,
	"provider_reference" varchar(200),
	"initiated_by_user_id" uuid,
	"reason" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "refund_amount_positive" CHECK ("refund_operations"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "related_products" (
	"product_id" uuid NOT NULL,
	"related_id" uuid NOT NULL,
	"kind" "relation_kind" DEFAULT 'similar' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "related_products_product_id_related_id_kind_pk" PRIMARY KEY("product_id","related_id","kind"),
	CONSTRAINT "related_not_self" CHECK ("related_products"."product_id" <> "related_products"."related_id")
);
--> statement-breakpoint
CREATE TABLE "return_request_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"return_request_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"received_quantity" integer DEFAULT 0 NOT NULL,
	"restocked_quantity" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "return_items_qty_positive" CHECK ("return_request_items"."quantity" > 0),
	CONSTRAINT "return_items_received_lte" CHECK ("return_request_items"."received_quantity" <= "return_request_items"."quantity"),
	CONSTRAINT "return_items_restocked_lte" CHECK ("return_request_items"."restocked_quantity" <= "return_request_items"."received_quantity")
);
--> statement-breakpoint
CREATE TABLE "return_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_number" varchar(32) NOT NULL,
	"order_id" uuid NOT NULL,
	"customer_id" uuid,
	"status" "return_status" DEFAULT 'requested' NOT NULL,
	"reason" "return_reason" NOT NULL,
	"policy_version" varchar(20) NOT NULL,
	"customer_comment" text,
	"photo_urls" text[],
	"admin_note" text,
	"refund_amount" integer,
	"restock" boolean DEFAULT false NOT NULL,
	"resolved_by_user_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"order_id" uuid,
	"rating" smallint NOT NULL,
	"title" varchar(200),
	"body" text,
	"size_bought" varchar(20),
	"fit_feedback" "fit_feedback",
	"photo_urls" text[],
	"is_approved" boolean DEFAULT false NOT NULL,
	"moderated_by_user_id" uuid,
	"admin_reply" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_rating_range" CHECK ("reviews"."rating" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" varchar(120) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipment_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"carrier" varchar(40) NOT NULL,
	"state" "operation_state" DEFAULT 'pending' NOT NULL,
	"local_reference" uuid DEFAULT gen_random_uuid() NOT NULL,
	"provider_document_ref" varchar(64),
	"ttn" varchar(40),
	"declared_cost" integer,
	"weight_grams" integer,
	"quoted_cost" integer,
	"request_snapshot" jsonb,
	"response_snapshot" jsonb,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sizes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"system" "size_system" NOT NULL,
	"label" varchar(20) NOT NULL,
	"band" smallint,
	"cup" varchar(4),
	"eu_label" varchar(20),
	"us_label" varchar(20),
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "sizes_bra_has_band_cup" CHECK (
    ("sizes"."system" <> 'bra') OR ("sizes"."band" IS NOT NULL AND "sizes"."cup" IS NOT NULL)
  ),
	CONSTRAINT "sizes_band_cup_only_bra" CHECK (
    ("sizes"."system" = 'bra') OR ("sizes"."band" IS NULL AND "sizes"."cup" IS NULL)
  ),
	CONSTRAINT "sizes_band_range" CHECK ("sizes"."band" IS NULL OR "sizes"."band" BETWEEN 60 AND 110)
);
--> statement-breakpoint
CREATE TABLE "stock_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"variant_id" uuid NOT NULL,
	"email" varchar(320) NOT NULL,
	"locale" varchar(5) DEFAULT 'uk' NOT NULL,
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"variant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"expires_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"release_reason" varchar(20),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservations_qty_positive" CHECK ("stock_reservations"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "webhook_quarantine" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(40) NOT NULL,
	"raw_body" text NOT NULL,
	"headers" jsonb,
	"reason" varchar(120) NOT NULL,
	"source_ip" varchar(45),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wishlist_items" (
	"customer_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wishlist_items_customer_id_product_id_pk" PRIMARY KEY("customer_id","product_id")
);
--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribute_values" ADD CONSTRAINT "attribute_values_attribute_id_attributes_id_fk" FOREIGN KEY ("attribute_id") REFERENCES "public"."attributes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_credentials" ADD CONSTRAINT "auth_credentials_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_recovery_codes" ADD CONSTRAINT "auth_recovery_codes_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_totp" ADD CONSTRAINT "auth_totp_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_converted_order_id_orders_id_fk" FOREIGN KEY ("converted_order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_intents" ADD CONSTRAINT "checkout_intents_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_intents" ADD CONSTRAINT "checkout_intents_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_intents" ADD CONSTRAINT "checkout_intents_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_preferred_bra_size_id_sizes_id_fk" FOREIGN KEY ("preferred_bra_size_id") REFERENCES "public"."sizes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_preferred_apparel_size_id_sizes_id_fk" FOREIGN KEY ("preferred_apparel_size_id") REFERENCES "public"."sizes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_parent_document_id_fiscal_documents_id_fk" FOREIGN KEY ("parent_document_id") REFERENCES "public"."fiscal_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_refund_operation_id_refund_operations_id_fk" FOREIGN KEY ("refund_operation_id") REFERENCES "public"."refund_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_transactions" ADD CONSTRAINT "gift_card_transactions_gift_card_id_gift_cards_id_fk" FOREIGN KEY ("gift_card_id") REFERENCES "public"."gift_cards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_transactions" ADD CONSTRAINT "gift_card_transactions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_transactions" ADD CONSTRAINT "gift_card_transactions_payment_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_issued_by_order_id_orders_id_fk" FOREIGN KEY ("issued_by_order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_attribute_values" ADD CONSTRAINT "product_attribute_values_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_attribute_values" ADD CONSTRAINT "product_attribute_values_attribute_value_id_attribute_values_id_fk" FOREIGN KEY ("attribute_value_id") REFERENCES "public"."attribute_values"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_color_id_colors_id_fk" FOREIGN KEY ("color_id") REFERENCES "public"."colors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_size_id_sizes_id_fk" FOREIGN KEY ("size_id") REFERENCES "public"."sizes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_color_id_colors_id_fk" FOREIGN KEY ("color_id") REFERENCES "public"."colors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_views" ADD CONSTRAINT "product_views_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_code_redemptions" ADD CONSTRAINT "promo_code_redemptions_promo_code_id_promo_codes_id_fk" FOREIGN KEY ("promo_code_id") REFERENCES "public"."promo_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_code_redemptions" ADD CONSTRAINT "promo_code_redemptions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_code_redemptions" ADD CONSTRAINT "promo_code_redemptions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_scope_category_id_categories_id_fk" FOREIGN KEY ("scope_category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_scope_product_id_products_id_fk" FOREIGN KEY ("scope_product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_operations" ADD CONSTRAINT "refund_operations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_operations" ADD CONSTRAINT "refund_operations_payment_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "related_products" ADD CONSTRAINT "related_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "related_products" ADD CONSTRAINT "related_products_related_id_products_id_fk" FOREIGN KEY ("related_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_request_items" ADD CONSTRAINT "return_request_items_return_request_id_return_requests_id_fk" FOREIGN KEY ("return_request_id") REFERENCES "public"."return_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_request_items" ADD CONSTRAINT "return_request_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_operations" ADD CONSTRAINT "shipment_operations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_notifications" ADD CONSTRAINT "stock_notifications_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "addresses_customer_idx" ON "addresses" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "addresses_one_default_uq" ON "addresses" USING btree ("customer_id") WHERE "addresses"."is_default" = true;--> statement-breakpoint
CREATE INDEX "admin_users_active_idx" ON "admin_users" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_values_uq" ON "attribute_values" USING btree ("attribute_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "attributes_code_uq" ON "attributes" USING btree ("code");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_log" USING btree ("entity","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_user_idx" ON "audit_log" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "auth_recovery_user_idx" ON "auth_recovery_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_active_idx" ON "auth_sessions" USING btree ("expires_at") WHERE "auth_sessions"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_users_email_uq" ON "auth_users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "banners_position_idx" ON "banners" USING btree ("position","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "blog_slug_uq" ON "blog_posts" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "blog_published_idx" ON "blog_posts" USING btree ("published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cart_items_uq" ON "cart_items" USING btree ("cart_id","variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "carts_token_uq" ON "carts" USING btree ("token");--> statement-breakpoint
CREATE INDEX "carts_customer_idx" ON "carts" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "carts_abandoned_idx" ON "carts" USING btree ("updated_at") WHERE "carts"."abandoned_email_sent_at" IS NULL AND "carts"."converted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_slug_uq" ON "categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "categories_parent_idx" ON "categories" USING btree ("parent_id","sort_order");--> statement-breakpoint
CREATE INDEX "categories_active_idx" ON "categories" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_intent_cart_uq" ON "checkout_intents" USING btree ("cart_id","cart_version") WHERE "checkout_intents"."completed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "checkout_intent_expiry_idx" ON "checkout_intents" USING btree ("expires_at") WHERE "checkout_intents"."completed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "colors_slug_uq" ON "colors" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_email_uq" ON "customers" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_user_uq" ON "customers" USING btree ("user_id") WHERE "customers"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "customers_phone_idx" ON "customers" USING btree ("phone");--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_docs_local_ref_uq" ON "fiscal_documents" USING btree ("local_reference");--> statement-breakpoint
CREATE INDEX "fiscal_docs_order_idx" ON "fiscal_documents" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "fiscal_docs_open_idx" ON "fiscal_documents" USING btree ("created_at") WHERE "fiscal_documents"."state" IN ('pending', 'in_flight', 'unknown', 'failed');--> statement-breakpoint
CREATE INDEX "gift_card_txn_card_idx" ON "gift_card_transactions" USING btree ("gift_card_id","created_at");--> statement-breakpoint
CREATE INDEX "gift_card_txn_order_idx" ON "gift_card_transactions" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gift_card_txn_redeem_uq" ON "gift_card_transactions" USING btree ("gift_card_id","payment_attempt_id") WHERE "gift_card_transactions"."type" = 'redeem';--> statement-breakpoint
CREATE UNIQUE INDEX "gift_cards_hash_uq" ON "gift_cards" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "gift_cards_status_idx" ON "gift_cards" USING btree ("status");--> statement-breakpoint
CREATE INDEX "gift_cards_order_idx" ON "gift_cards" USING btree ("issued_by_order_id");--> statement-breakpoint
CREATE INDEX "gift_cards_expiry_idx" ON "gift_cards" USING btree ("expires_at") WHERE "gift_cards"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "legal_docs_uq" ON "legal_documents" USING btree ("kind","version","locale");--> statement-breakpoint
CREATE INDEX "legal_docs_current_idx" ON "legal_documents" USING btree ("kind","locale","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "newsletter_email_uq" ON "newsletter_subscribers" USING btree ("email");--> statement-breakpoint
CREATE INDEX "np_settlements_name_trgm_idx" ON "np_settlements" USING gin ("name_uk" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "np_settlements_count_idx" ON "np_settlements" USING btree ("warehouses_count");--> statement-breakpoint
CREATE INDEX "np_warehouses_settlement_idx" ON "np_warehouses" USING btree ("settlement_ref","type");--> statement-breakpoint
CREATE INDEX "np_warehouses_desc_trgm_idx" ON "np_warehouses" USING gin ("description_uk" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_items_product_idx" ON "order_items" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "order_items_variant_idx" ON "order_items" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "osh_order_idx" ON "order_status_history" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_number_uq" ON "orders" USING btree ("order_number");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_intent_uq" ON "orders" USING btree ("checkout_intent_id") WHERE "orders"."checkout_intent_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "orders_created_idx" ON "orders" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "orders_customer_idx" ON "orders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "orders_phone_idx" ON "orders" USING btree ("customer_phone");--> statement-breakpoint
CREATE INDEX "orders_ttn_idx" ON "orders" USING btree ("ttn");--> statement-breakpoint
CREATE INDEX "orders_provider_payment_idx" ON "orders" USING btree ("provider_payment_id");--> statement-breakpoint
CREATE INDEX "orders_unpaid_idx" ON "orders" USING btree ("created_at") WHERE "orders"."payment_status" = 'pending';--> statement-breakpoint
CREATE INDEX "orders_no_ttn_idx" ON "orders" USING btree ("created_at") WHERE "orders"."ttn" IS NULL;--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "outbox" USING btree ("created_at") WHERE "outbox"."published_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_dedup_uq" ON "outbox" USING btree ("dedup_key") WHERE "outbox"."dedup_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pages_slug_uq" ON "pages" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_order_num_uq" ON "payment_attempts" USING btree ("order_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_local_ref_uq" ON "payment_attempts" USING btree ("local_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_external_uq" ON "payment_attempts" USING btree ("provider","external_id") WHERE "payment_attempts"."external_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payment_attempts_order_idx" ON "payment_attempts" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "payment_attempts_open_idx" ON "payment_attempts" USING btree ("created_at") WHERE "payment_attempts"."state" IN ('pending', 'in_flight', 'unknown');--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_idem_uq" ON "payment_events" USING btree ("provider","message_key");--> statement-breakpoint
CREATE INDEX "payment_events_order_idx" ON "payment_events" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "payment_events_attempt_idx" ON "payment_events" USING btree ("payment_attempt_id");--> statement-breakpoint
CREATE INDEX "payment_events_unapplied_idx" ON "payment_events" USING btree ("created_at") WHERE "payment_events"."applied_at" IS NULL;--> statement-breakpoint
CREATE INDEX "pav_value_idx" ON "product_attribute_values" USING btree ("attribute_value_id");--> statement-breakpoint
CREATE INDEX "product_images_product_idx" ON "product_images" USING btree ("product_id","sort_order");--> statement-breakpoint
CREATE INDEX "product_images_color_idx" ON "product_images" USING btree ("product_id","color_id");--> statement-breakpoint
CREATE UNIQUE INDEX "variants_combo_uq" ON "product_variants" USING btree ("product_id","size_id","color_id");--> statement-breakpoint
CREATE UNIQUE INDEX "variants_sku_uq" ON "product_variants" USING btree ("sku");--> statement-breakpoint
CREATE INDEX "variants_product_idx" ON "product_variants" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "variants_size_idx" ON "product_variants" USING btree ("size_id");--> statement-breakpoint
CREATE INDEX "variants_color_idx" ON "product_variants" USING btree ("color_id");--> statement-breakpoint
CREATE INDEX "variants_available_idx" ON "product_variants" USING btree ("product_id") WHERE "product_variants"."stock_quantity" - "product_variants"."reserved_quantity" > 0 AND "product_variants"."is_active" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "product_views_dedup_uq" ON "product_views" USING btree ("product_id","session_hash","viewed_on");--> statement-breakpoint
CREATE INDEX "product_views_product_idx" ON "product_views" USING btree ("product_id","viewed_on");--> statement-breakpoint
CREATE INDEX "product_views_cleanup_idx" ON "product_views" USING btree ("viewed_on");--> statement-breakpoint
CREATE UNIQUE INDEX "products_slug_uq" ON "products" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "products_sku_uq" ON "products" USING btree ("sku");--> statement-breakpoint
CREATE INDEX "products_catalog_idx" ON "products" USING btree ("category_id","is_active","published_at");--> statement-breakpoint
CREATE INDEX "products_brand_idx" ON "products" USING btree ("brand");--> statement-breakpoint
CREATE INDEX "products_featured_idx" ON "products" USING btree ("is_featured") WHERE "products"."is_featured" = true;--> statement-breakpoint
CREATE INDEX "products_search_idx" ON "products" USING gin ("search_vector");--> statement-breakpoint
CREATE UNIQUE INDEX "promo_redemption_order_uq" ON "promo_code_redemptions" USING btree ("promo_code_id","order_id");--> statement-breakpoint
CREATE INDEX "promo_redemption_customer_idx" ON "promo_code_redemptions" USING btree ("promo_code_id","customer_id") WHERE "promo_code_redemptions"."state" = 'consumed';--> statement-breakpoint
CREATE UNIQUE INDEX "promo_codes_code_uq" ON "promo_codes" USING btree (upper("code"));--> statement-breakpoint
CREATE INDEX "promo_codes_active_idx" ON "promo_codes" USING btree ("is_active","ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "redirects_from_uq" ON "redirects" USING btree ("from_path");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_local_ref_uq" ON "refund_operations" USING btree ("local_reference");--> statement-breakpoint
CREATE INDEX "refund_order_idx" ON "refund_operations" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "refund_open_idx" ON "refund_operations" USING btree ("created_at") WHERE "refund_operations"."state" IN ('pending', 'in_flight', 'unknown');--> statement-breakpoint
CREATE UNIQUE INDEX "return_items_uq" ON "return_request_items" USING btree ("return_request_id","order_item_id");--> statement-breakpoint
CREATE INDEX "return_items_order_idx" ON "return_request_items" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "return_requests_number_uq" ON "return_requests" USING btree ("request_number");--> statement-breakpoint
CREATE INDEX "return_requests_order_idx" ON "return_requests" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "return_requests_status_idx" ON "return_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "return_requests_open_idx" ON "return_requests" USING btree ("created_at") WHERE "return_requests"."status" IN ('requested', 'approved', 'in_transit', 'received');--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_product_customer_uq" ON "reviews" USING btree ("product_id","customer_id");--> statement-breakpoint
CREATE INDEX "reviews_product_approved_idx" ON "reviews" USING btree ("product_id") WHERE "reviews"."is_approved" = true;--> statement-breakpoint
CREATE INDEX "reviews_pending_idx" ON "reviews" USING btree ("created_at") WHERE "reviews"."is_approved" = false;--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_local_ref_uq" ON "shipment_operations" USING btree ("local_reference");--> statement-breakpoint
CREATE INDEX "shipment_order_idx" ON "shipment_operations" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "shipment_open_idx" ON "shipment_operations" USING btree ("created_at") WHERE "shipment_operations"."state" IN ('pending', 'in_flight', 'unknown');--> statement-breakpoint
CREATE UNIQUE INDEX "sizes_system_label_uq" ON "sizes" USING btree ("system","label");--> statement-breakpoint
CREATE INDEX "sizes_band_cup_idx" ON "sizes" USING btree ("band","cup");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_notif_uq" ON "stock_notifications" USING btree ("variant_id","email");--> statement-breakpoint
CREATE INDEX "stock_notif_pending_idx" ON "stock_notifications" USING btree ("variant_id") WHERE "stock_notifications"."notified_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_active_uq" ON "stock_reservations" USING btree ("order_id","variant_id") WHERE "stock_reservations"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX "reservations_expiry_idx" ON "stock_reservations" USING btree ("expires_at") WHERE "stock_reservations"."released_at" IS NULL AND "stock_reservations"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "reservations_variant_idx" ON "stock_reservations" USING btree ("variant_id") WHERE "stock_reservations"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX "webhook_quarantine_created_idx" ON "webhook_quarantine" USING btree ("created_at");