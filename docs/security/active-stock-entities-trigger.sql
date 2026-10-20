-- WANGANUBAL INVENTORY security hardening
-- Apply manually in Supabase SQL Editor after reviewing this migration.
-- This migration does not alter stock balances or existing transaction rows.
--
-- Prevents new stock transactions from referencing inactive/missing products
-- or inactive/missing locations. Duplicate idempotency keys are allowed to
-- reach process_stock_transaction's existing duplicate/signature checks.

BEGIN;

CREATE OR REPLACE FUNCTION public.enforce_active_stock_entities()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_is_active boolean;
BEGIN
  -- Let the existing RPC handle duplicate-key signature/status validation.
  IF EXISTS (
    SELECT 1
    FROM public.stock_transactions AS st
    WHERE st.idempotency_key = NEW.idempotency_key
  ) THEN
    RETURN NEW;
  END IF;

  SELECT p.is_active
    INTO v_is_active
  FROM public.products AS p
  WHERE p.id = NEW.product_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product does not exist'
      USING ERRCODE = '23503';
  END IF;

  IF v_is_active IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Inactive products cannot be used for stock transactions'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.transaction_type IN ('OUT', 'MOVE') THEN
    SELECT l.is_active
      INTO v_is_active
    FROM public.locations AS l
    WHERE l.id = NEW.from_location_id
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Source location does not exist'
        USING ERRCODE = '23503';
    END IF;

    IF v_is_active IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'Inactive source locations cannot be used for stock transactions'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.transaction_type IN ('IN', 'MOVE') THEN
    SELECT l.is_active
      INTO v_is_active
    FROM public.locations AS l
    WHERE l.id = NEW.to_location_id
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Destination location does not exist'
        USING ERRCODE = '23503';
    END IF;

    IF v_is_active IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'Inactive destination locations cannot be used for stock transactions'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.enforce_active_stock_entities() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_active_stock_entities() FROM anon, authenticated;

DROP TRIGGER IF EXISTS enforce_active_stock_entities_before_insert
  ON public.stock_transactions;

CREATE TRIGGER enforce_active_stock_entities_before_insert
BEFORE INSERT ON public.stock_transactions
FOR EACH ROW
EXECUTE FUNCTION public.enforce_active_stock_entities();

COMMIT;
