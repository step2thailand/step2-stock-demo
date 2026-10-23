-- WANGANUBAL INVENTORY: stock status foundation
-- Safe migration: preserves existing stock_balances.quantity values.
-- Run this migration in Supabase SQL Editor before deploying UI code that uses these fields.

ALTER TABLE public.stock_balances
  ADD COLUMN IF NOT EXISTS reserved_quantity integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS damaged_quantity integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_balances_reserved_quantity_nonnegative'
      AND conrelid = 'public.stock_balances'::regclass
  ) THEN
    ALTER TABLE public.stock_balances
      ADD CONSTRAINT stock_balances_reserved_quantity_nonnegative
      CHECK (reserved_quantity >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_balances_damaged_quantity_nonnegative'
      AND conrelid = 'public.stock_balances'::regclass
  ) THEN
    ALTER TABLE public.stock_balances
      ADD CONSTRAINT stock_balances_damaged_quantity_nonnegative
      CHECK (damaged_quantity >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_balances_status_quantities_within_total'
      AND conrelid = 'public.stock_balances'::regclass
  ) THEN
    ALTER TABLE public.stock_balances
      ADD CONSTRAINT stock_balances_status_quantities_within_total
      CHECK (reserved_quantity + damaged_quantity <= quantity);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.stock_status_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  product_id uuid NOT NULL REFERENCES public.products(id),
  location_id uuid NOT NULL REFERENCES public.locations(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  from_status text NOT NULL CHECK (from_status IN ('available', 'reserved', 'damaged')),
  to_status text NOT NULL CHECK (to_status IN ('available', 'reserved', 'damaged')),
  notes text,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_status_transactions_different_statuses
    CHECK (from_status <> to_status)
);

ALTER TABLE public.stock_status_transactions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'stock_status_transactions'
      AND policyname = 'Authenticated users can read stock status history'
  ) THEN
    CREATE POLICY "Authenticated users can read stock status history"
      ON public.stock_status_transactions
      FOR SELECT TO authenticated
      USING (auth.uid() IS NOT NULL);
  END IF;
END $$;

GRANT SELECT ON public.stock_status_transactions TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.stock_status_transactions FROM anon, authenticated;

-- Preserve the existing IN/OUT/MOVE API. OUT and MOVE now use available quantity only.
CREATE OR REPLACE FUNCTION public.process_stock_transaction(
  p_idempotency_key text,
  p_transaction_type text,
  p_product_id uuid,
  p_quantity integer,
  p_from_location_id uuid,
  p_to_location_id uuid,
  p_notes text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_tx_id uuid;
  v_existing public.stock_transactions%ROWTYPE;
  v_updated_rows integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
    RAISE EXCEPTION 'Idempotency key is required';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be greater than zero';
  END IF;
  IF p_transaction_type NOT IN ('IN', 'OUT', 'MOVE') THEN
    RAISE EXCEPTION 'Unsupported transaction type';
  END IF;

  IF p_transaction_type = 'IN' THEN
    IF p_from_location_id IS NOT NULL OR p_to_location_id IS NULL THEN
      RAISE EXCEPTION 'IN requires destination only';
    END IF;
  ELSIF p_transaction_type = 'OUT' THEN
    IF p_from_location_id IS NULL OR p_to_location_id IS NOT NULL THEN
      RAISE EXCEPTION 'OUT requires source only';
    END IF;
  ELSE
    IF p_from_location_id IS NULL OR p_to_location_id IS NULL
       OR p_from_location_id = p_to_location_id THEN
      RAISE EXCEPTION 'MOVE requires two different locations';
    END IF;
  END IF;

  INSERT INTO public.stock_transactions (
    idempotency_key, transaction_type, product_id, quantity,
    from_location_id, to_location_id, notes, status
  )
  VALUES (
    p_idempotency_key, p_transaction_type, p_product_id, p_quantity,
    p_from_location_id, p_to_location_id, p_notes, 'POSTED'
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_tx_id;

  IF v_tx_id IS NULL THEN
    SELECT * INTO v_existing
    FROM public.stock_transactions
    WHERE idempotency_key = p_idempotency_key;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Could not resolve duplicate transaction';
    END IF;

    IF v_existing.transaction_type IS DISTINCT FROM p_transaction_type
       OR v_existing.product_id IS DISTINCT FROM p_product_id
       OR v_existing.quantity IS DISTINCT FROM p_quantity
       OR v_existing.from_location_id IS DISTINCT FROM p_from_location_id
       OR v_existing.to_location_id IS DISTINCT FROM p_to_location_id
       OR v_existing.notes IS DISTINCT FROM p_notes THEN
      RAISE EXCEPTION 'Idempotency key reused with different data';
    END IF;

    IF v_existing.status = 'POSTED' THEN
      RETURN v_existing.id;
    END IF;
    RAISE EXCEPTION 'Existing transaction is not POSTED';
  END IF;

  IF p_transaction_type = 'IN' THEN
    INSERT INTO public.stock_balances (
      product_id, location_id, quantity, updated_at
    )
    VALUES (p_product_id, p_to_location_id, p_quantity, now())
    ON CONFLICT (product_id, location_id)
    DO UPDATE SET
      quantity = public.stock_balances.quantity + EXCLUDED.quantity,
      updated_at = now();

  ELSIF p_transaction_type = 'OUT' THEN
    UPDATE public.stock_balances
    SET quantity = quantity - p_quantity, updated_at = now()
    WHERE product_id = p_product_id
      AND location_id = p_from_location_id
      AND quantity - reserved_quantity - damaged_quantity >= p_quantity;

    GET DIAGNOSTICS v_updated_rows = ROW_COUNT;
    IF v_updated_rows = 0 THEN
      RAISE EXCEPTION 'Insufficient available stock at source location';
    END IF;

  ELSE
    UPDATE public.stock_balances
    SET quantity = quantity - p_quantity, updated_at = now()
    WHERE product_id = p_product_id
      AND location_id = p_from_location_id
      AND quantity - reserved_quantity - damaged_quantity >= p_quantity;

    GET DIAGNOSTICS v_updated_rows = ROW_COUNT;
    IF v_updated_rows = 0 THEN
      RAISE EXCEPTION 'Insufficient available stock at source location';
    END IF;

    INSERT INTO public.stock_balances (
      product_id, location_id, quantity, updated_at
    )
    VALUES (p_product_id, p_to_location_id, p_quantity, now())
    ON CONFLICT (product_id, location_id)
    DO UPDATE SET
      quantity = public.stock_balances.quantity + EXCLUDED.quantity,
      updated_at = now();
  END IF;

  RETURN v_tx_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.process_stock_transaction(text, text, uuid, integer, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.process_stock_transaction(text, text, uuid, integer, uuid, uuid, text) TO authenticated;

-- Change stock between statuses without changing the physical total quantity.
CREATE OR REPLACE FUNCTION public.process_stock_status_change(
  p_idempotency_key text,
  p_product_id uuid,
  p_location_id uuid,
  p_quantity integer,
  p_from_status text,
  p_to_status text,
  p_notes text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_tx_id uuid;
  v_existing public.stock_status_transactions%ROWTYPE;
  v_balance public.stock_balances%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
    RAISE EXCEPTION 'Idempotency key is required';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be greater than zero';
  END IF;
  IF p_from_status NOT IN ('available', 'reserved', 'damaged')
     OR p_to_status NOT IN ('available', 'reserved', 'damaged')
     OR p_from_status = p_to_status THEN
    RAISE EXCEPTION 'Invalid stock status transition';
  END IF;

  INSERT INTO public.stock_status_transactions (
    idempotency_key, product_id, location_id, quantity,
    from_status, to_status, notes, created_by
  )
  VALUES (
    p_idempotency_key, p_product_id, p_location_id, p_quantity,
    p_from_status, p_to_status, p_notes, auth.uid()
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_tx_id;

  IF v_tx_id IS NULL THEN
    SELECT * INTO v_existing
    FROM public.stock_status_transactions
    WHERE idempotency_key = p_idempotency_key;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Could not resolve duplicate status transaction';
    END IF;
    IF v_existing.product_id IS DISTINCT FROM p_product_id
       OR v_existing.location_id IS DISTINCT FROM p_location_id
       OR v_existing.quantity IS DISTINCT FROM p_quantity
       OR v_existing.from_status IS DISTINCT FROM p_from_status
       OR v_existing.to_status IS DISTINCT FROM p_to_status
       OR v_existing.notes IS DISTINCT FROM p_notes THEN
      RAISE EXCEPTION 'Idempotency key reused with different data';
    END IF;
    RETURN v_existing.id;
  END IF;

  SELECT * INTO v_balance
  FROM public.stock_balances
  WHERE product_id = p_product_id AND location_id = p_location_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No stock balance found for this product and location';
  END IF;

  IF p_from_status = 'available'
     AND v_balance.quantity - v_balance.reserved_quantity - v_balance.damaged_quantity < p_quantity THEN
    RAISE EXCEPTION 'Insufficient available stock for status change';
  ELSIF p_from_status = 'reserved' AND v_balance.reserved_quantity < p_quantity THEN
    RAISE EXCEPTION 'Insufficient reserved stock';
  ELSIF p_from_status = 'damaged' AND v_balance.damaged_quantity < p_quantity THEN
    RAISE EXCEPTION 'Insufficient damaged stock';
  END IF;

  IF p_from_status = 'reserved' THEN
    UPDATE public.stock_balances
    SET reserved_quantity = reserved_quantity - p_quantity, updated_at = now()
    WHERE id = v_balance.id;
  ELSIF p_from_status = 'damaged' THEN
    UPDATE public.stock_balances
    SET damaged_quantity = damaged_quantity - p_quantity, updated_at = now()
    WHERE id = v_balance.id;
  END IF;

  IF p_to_status = 'reserved' THEN
    UPDATE public.stock_balances
    SET reserved_quantity = reserved_quantity + p_quantity, updated_at = now()
    WHERE id = v_balance.id;
  ELSIF p_to_status = 'damaged' THEN
    UPDATE public.stock_balances
    SET damaged_quantity = damaged_quantity + p_quantity, updated_at = now()
    WHERE id = v_balance.id;
  END IF;

  RETURN v_tx_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.process_stock_status_change(text, uuid, uuid, integer, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.process_stock_status_change(text, uuid, uuid, integer, text, text, text) TO authenticated;
