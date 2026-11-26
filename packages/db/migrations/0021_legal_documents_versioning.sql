-- The table was created in 0001 and no code has written to it. Rows that might exist anyway are kept:
-- they were the only thing a reader could ever have seen, so they become published versions.
ALTER TABLE "legal_documents" ADD COLUMN "title" varchar(200) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "legal_documents" ADD COLUMN "status" varchar(12) DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "legal_documents" ADD COLUMN "body_source" text;--> statement-breakpoint
ALTER TABLE "legal_documents" ADD COLUMN "file_key" varchar(300);--> statement-breakpoint
ALTER TABLE "legal_documents" ADD COLUMN "file_size" integer;--> statement-breakpoint
ALTER TABLE "legal_documents" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "legal_documents" ADD COLUMN "published_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "legal_documents" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "legal_documents" SET "kind" = CASE "kind" WHEN 'offer' THEN 'terms' WHEN 'delivery' THEN 'delivery_payment' ELSE "kind" END,
  "title" = CASE WHEN btrim("title") = '' THEN "kind" ELSE "title" END,
  "status" = 'published', "published_at" = "created_at";--> statement-breakpoint
ALTER TABLE "legal_documents" ALTER COLUMN "title" DROP DEFAULT;--> statement-breakpoint
CREATE UNIQUE INDEX "legal_docs_published_start_uq" ON "legal_documents" USING btree ("kind","locale","effective_from") WHERE "legal_documents"."status" = 'published';--> statement-breakpoint
ALTER TABLE "legal_documents" ADD CONSTRAINT "legal_docs_kind" CHECK ("legal_documents"."kind" IN ('terms', 'privacy', 'delivery_payment', 'returns', 'about', 'faq', 'contacts'));--> statement-breakpoint
ALTER TABLE "legal_documents" ADD CONSTRAINT "legal_docs_locale" CHECK ("legal_documents"."locale" IN ('uk', 'en'));--> statement-breakpoint
ALTER TABLE "legal_documents" ADD CONSTRAINT "legal_docs_status" CHECK ("legal_documents"."status" IN ('draft', 'published'));--> statement-breakpoint
ALTER TABLE "legal_documents" ADD CONSTRAINT "legal_docs_version_format" CHECK ("legal_documents"."version" ~ '^[1-9][0-9]{0,5}$');--> statement-breakpoint
ALTER TABLE "legal_documents" ADD CONSTRAINT "legal_docs_title_nonblank" CHECK (char_length(btrim("legal_documents"."title")) > 0);--> statement-breakpoint
ALTER TABLE "legal_documents" ADD CONSTRAINT "legal_docs_body_size" CHECK (char_length(coalesce("legal_documents"."body_html", '')) <= 200000 AND char_length(coalesce("legal_documents"."body_source", '')) <= 100000);--> statement-breakpoint
ALTER TABLE "legal_documents" ADD CONSTRAINT "legal_docs_file_pair" CHECK (("legal_documents"."file_url" IS NULL) = ("legal_documents"."file_key" IS NULL));--> statement-breakpoint
ALTER TABLE "legal_documents" ADD CONSTRAINT "legal_docs_published_stamp" CHECK ("legal_documents"."status" <> 'published' OR "legal_documents"."published_at" IS NOT NULL);--> statement-breakpoint
-- A published version is history that return requests and accepted consents point at (`policy_version`):
-- its text, its dates and its identity never change and it is never deleted. A correction is a new version.
-- Drafts are free. The database says it, so the admin code, a worker and a manual UPDATE all obey it.
CREATE FUNCTION legal_documents_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'published' THEN
      RAISE EXCEPTION 'a published legal document is never deleted' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'published' AND (
       NEW.status <> 'published'
       OR ROW(NEW.kind, NEW.version, NEW.locale, NEW.title, NEW.body_source, NEW.body_html, NEW.file_url,
              NEW.file_key, NEW.file_size, NEW.effective_from, NEW.published_at, NEW.published_by_user_id)
          IS DISTINCT FROM
          ROW(OLD.kind, OLD.version, OLD.locale, OLD.title, OLD.body_source, OLD.body_html, OLD.file_url,
              OLD.file_key, OLD.file_size, OLD.effective_from, OLD.published_at, OLD.published_by_user_id)) THEN
    RAISE EXCEPTION 'a published legal document is immutable: publish a new version' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER legal_documents_guard BEFORE UPDATE OR DELETE ON legal_documents
  FOR EACH ROW EXECUTE FUNCTION legal_documents_guard();--> statement-breakpoint
CREATE TRIGGER legal_documents_touch_updated_at BEFORE UPDATE ON legal_documents
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
