DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "shipment_operations"
     WHERE "state" IN ('pending', 'in_flight', 'unknown', 'succeeded')
     GROUP BY "order_id" HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '0013: an order has more than one live shipment operation; resolve them by hand before migrating';
  END IF;
END
$$;
--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_one_live_uq" ON "shipment_operations" USING btree ("order_id") WHERE "shipment_operations"."state" IN ('pending', 'in_flight', 'unknown', 'succeeded');