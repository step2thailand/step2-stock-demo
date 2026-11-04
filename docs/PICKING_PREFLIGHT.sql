-- WANGANUBAL INVENTORY: Picking preflight (READ ONLY)
-- Run this BEFORE 202611040001_picking_tasks_and_staging.sql.
-- Every statement below is SELECT-only; it does not change tables, stock, or transactions.

-- 1) Required tables and key columns.
WITH required(table_name, column_name) AS (
  VALUES
    ('products','id'),
    ('locations','id'),
    ('locations','location_code'),
    ('locations','is_active'),
    ('stock_balances','id'),
    ('stock_balances','product_id'),
    ('stock_balances','location_id'),
    ('stock_balances','quantity'),
    ('stock_balances','reserved_quantity'),
    ('stock_balances','damaged_quantity'),
    ('stock_transactions','id'),
    ('stock_transactions','idempotency_key'),
    ('stock_transactions','transaction_type'),
    ('stock_transactions','product_id'),
    ('stock_transactions','quantity'),
    ('stock_transactions','from_location_id'),
    ('stock_transactions','to_location_id'),
    ('stock_transactions','notes'),
    ('stock_transactions','status')
)
SELECT
  r.table_name,
  r.column_name,
  (c.column_name IS NOT NULL) AS exists
FROM required r
LEFT JOIN information_schema.columns c
  ON c.table_schema = 'public'
 AND c.table_name = r.table_name
 AND c.column_name = r.column_name
ORDER BY r.table_name, r.column_name;

-- 2) Confirm process_stock_transaction has the exact signature used by Picking.
SELECT
  n.nspname AS schema_name,
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS identity_arguments,
  pg_get_function_result(p.oid) AS return_type,
  p.prosecdef AS security_definer
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'process_stock_transaction';

-- 3) Check STAGING location. Zero rows means it must be created before Picking can run.
SELECT id, location_code, is_active
FROM public.locations
WHERE location_code = 'STAGING';

-- 4) Confirm the existing stock balance totals for later before/after comparison.
-- These are read-only baseline figures; no product names or customer information are exposed.
SELECT
  count(*) AS balance_rows,
  coalesce(sum(quantity), 0) AS physical_quantity_total,
  coalesce(sum(reserved_quantity), 0) AS reserved_quantity_total,
  coalesce(sum(damaged_quantity), 0) AS damaged_quantity_total
FROM public.stock_balances;

-- 5) Confirm there are no pre-existing picking tables with unexpected shapes.
-- A fresh installation should return zero rows here.
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN (
    'pick_tasks',
    'pick_task_lines',
    'pick_task_invoice_lines',
    'pick_task_move_events'
  )
ORDER BY table_name, ordinal_position;
