-- Людські номери замовлень і запитів на повернення.
--
-- lpad() задає КІНЦЕВУ довжину й обрізає довші значення: після 999 999
-- замовлень `lpad(v, 6, '0')` віддав би '100000' для 1 000 000 — дубль, і
-- UNIQUE orders_number_uq почав би відкидати checkout. greatest() робить
-- ширину мінімальною, а не фіксованою.
CREATE SEQUENCE order_number_seq START 1;--> statement-breakpoint

CREATE OR REPLACE FUNCTION next_order_number() RETURNS text AS $$
DECLARE v text;
BEGIN
  v := nextval('order_number_seq')::text;
  RETURN 'LS-' || to_char(now(), 'YYYY') || '-' ||
         lpad(v, greatest(6, length(v)), '0');
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE SEQUENCE return_request_seq START 1;--> statement-breakpoint

CREATE OR REPLACE FUNCTION next_return_number() RETURNS text AS $$
DECLARE v text;
BEGIN
  v := nextval('return_request_seq')::text;
  RETURN 'RET-' || to_char(now(), 'YYYY') || '-' ||
         lpad(v, greatest(5, length(v)), '0');
END;
$$ LANGUAGE plpgsql;
