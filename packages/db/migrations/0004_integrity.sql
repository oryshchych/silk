-- Інваріанти, які Drizzle не виражає декларативно: складені FK і цикл
-- orders ↔ payment_attempts. Прості FK із 0001 лишаються — складені їх
-- доповнюють, а не замінюють (інакше снапшот drizzle-kit розійдеться з БД).
--
-- Складений FK із MATCH SIMPLE (дефолт) не перевіряється, коли будь-яка
-- його колонка NULL — тому опційні посилання fiscal_documents працюють.

-- 1. Позиція повернення належить тому самому замовленню, що й запит.
ALTER TABLE order_items ADD CONSTRAINT order_items_id_order_uq
  UNIQUE (id, order_id);--> statement-breakpoint

ALTER TABLE return_request_items
  ADD CONSTRAINT rri_item_belongs_to_order_fk
  FOREIGN KEY (order_item_id, order_id)
  REFERENCES order_items (id, order_id);--> statement-breakpoint

ALTER TABLE return_requests ADD CONSTRAINT return_requests_id_order_uq
  UNIQUE (id, order_id);--> statement-breakpoint

ALTER TABLE return_request_items
  ADD CONSTRAINT rri_request_same_order_fk
  FOREIGN KEY (return_request_id, order_id)
  REFERENCES return_requests (id, order_id);--> statement-breakpoint

-- 2. Фіскальні документи. Чек повернення посилається на чек продажу ТОГО
--    САМОГО замовлення, а операція повернення — того самого замовлення.
--    Інакше чек повернення можна прив'язати до чужого чека продажу, і
--    фіскальна історія замовлення перестає сходитися.
ALTER TABLE fiscal_documents ADD CONSTRAINT fiscal_docs_id_order_uq
  UNIQUE (id, order_id);--> statement-breakpoint

ALTER TABLE fiscal_documents
  ADD CONSTRAINT fiscal_docs_parent_same_order_fk
  FOREIGN KEY (parent_document_id, order_id)
  REFERENCES fiscal_documents (id, order_id)
  ON DELETE RESTRICT;--> statement-breakpoint

ALTER TABLE refund_operations ADD CONSTRAINT refund_ops_id_order_uq
  UNIQUE (id, order_id);--> statement-breakpoint

ALTER TABLE fiscal_documents
  ADD CONSTRAINT fiscal_docs_refund_same_order_fk
  FOREIGN KEY (refund_operation_id, order_id)
  REFERENCES refund_operations (id, order_id)
  ON DELETE RESTRICT;--> statement-breakpoint

-- 3. orders.current_payment_attempt_id → payment_attempts.id.
--    Циклічне посилання, тому окремо, після створення обох таблиць.
ALTER TABLE orders
  ADD CONSTRAINT orders_current_attempt_fk
  FOREIGN KEY (current_payment_attempt_id)
  REFERENCES payment_attempts (id) ON DELETE SET NULL;
