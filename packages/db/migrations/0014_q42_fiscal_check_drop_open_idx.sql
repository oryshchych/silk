DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "fiscal_documents" WHERE "kind" = 'return' AND "refund_operation_id" IS NULL) THEN
    RAISE EXCEPTION '0014: a return receipt has no refund operation; resolve it by hand before migrating'
      USING DETAIL = (SELECT string_agg("id"::text, ',') FROM "fiscal_documents" WHERE "kind" = 'return' AND "refund_operation_id" IS NULL);
  END IF;
END
$$;
--> statement-breakpoint
DROP INDEX "payment_attempts_open_idx";--> statement-breakpoint
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_docs_return_has_refund" CHECK (
    "fiscal_documents"."kind" <> 'return' OR "fiscal_documents"."refund_operation_id" IS NOT NULL
  );