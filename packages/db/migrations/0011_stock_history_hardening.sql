ALTER TABLE "stock_adjustments" DROP CONSTRAINT "stock_adjustments_user_id_auth_users_id_fk";
--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD COLUMN "request_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_adjustments_request_uq" ON "stock_adjustments" USING btree ("request_id");--> statement-breakpoint
-- The history is append-only. The app role may read and add rows, never rewrite or delete them
-- (init/01-roles.sh grants DML on every new table, so it is taken back here).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'store_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "stock_adjustments" FROM store_app;
  END IF;
END
$$;
--> statement-breakpoint
-- A second line of defence that also covers the owner and migrate roles: nothing rewrites history.
CREATE FUNCTION stock_adjustments_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stock_adjustments is append-only' USING ERRCODE = 'restrict_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER stock_adjustments_no_rewrite
  BEFORE UPDATE OR DELETE ON "stock_adjustments"
  FOR EACH ROW EXECUTE FUNCTION stock_adjustments_append_only();
--> statement-breakpoint
CREATE TRIGGER stock_adjustments_no_truncate
  BEFORE TRUNCATE ON "stock_adjustments"
  FOR EACH STATEMENT EXECUTE FUNCTION stock_adjustments_append_only();
