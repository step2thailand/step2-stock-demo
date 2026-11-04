-- WANGANUBAL INVENTORY: picking tasks and staging allocations
-- Draft migration for review. It does NOT alter existing stock quantities.
-- Before enabling Picking, create an active location with location_code = 'STAGING'
-- using the existing location-management process (or confirm the location schema first).

CREATE TABLE IF NOT EXISTS public.pick_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_system text NOT NULL DEFAULT 'MANUAL',
  source_document_type text NOT NULL DEFAULT 'RESERVATION',
  source_document_no text NOT NULL,
  source_document_id text,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'IN_PROGRESS', 'READY', 'CANCELLED', 'CLOSED')),
  notes text,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pick_tasks_source_document_unique
    UNIQUE (source_system, source_document_type, source_document_no)
);

CREATE TABLE IF NOT EXISTS public.pick_task_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.pick_tasks(id) ON DELETE RESTRICT,
  source_line_id text NOT NULL,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  requested_quantity integer NOT NULL CHECK (requested_quantity > 0),
  picked_quantity integer NOT NULL DEFAULT 0
    CHECK (picked_quantity >= 0 AND picked_quantity <= requested_quantity),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pick_task_lines_source_line_unique UNIQUE (task_id, source_line_id)
);

-- One reservation may be fulfilled by multiple invoices; each invoice line is
-- linked back to the originating reservation/picking line.
CREATE TABLE IF NOT EXISTS public.pick_task_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_line_id uuid NOT NULL REFERENCES public.pick_task_lines(id) ON DELETE RESTRICT,
  invoice_system text NOT NULL DEFAULT 'BUSINESS_PLUS',
  invoice_document_no text NOT NULL,
  invoice_line_id text NOT NULL,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  invoiced_quantity integer NOT NULL CHECK (invoiced_quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pick_task_invoice_line_unique
    UNIQUE (invoice_system, invoice_document_no, invoice_line_id)
);

CREATE TABLE IF NOT EXISTS public.pick_task_move_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  task_line_id uuid NOT NULL REFERENCES public.pick_task_lines(id) ON DELETE RESTRICT,
  stock_transaction_id uuid NOT NULL REFERENCES public.stock_transactions(id) ON DELETE RESTRICT,
  from_location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
  to_location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pick_tasks_status_created_idx
  ON public.pick_tasks (status, created_at DESC);
CREATE INDEX IF NOT EXISTS pick_task_lines_task_idx
  ON public.pick_task_lines (task_id);
CREATE INDEX IF NOT EXISTS pick_task_invoice_lines_task_line_idx
  ON public.pick_task_invoice_lines (task_line_id);
CREATE INDEX IF NOT EXISTS pick_task_move_events_line_idx
  ON public.pick_task_move_events (task_line_id, created_at DESC);

ALTER TABLE public.pick_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pick_task_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pick_task_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pick_task_move_events ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pick_tasks', 'pick_task_lines', 'pick_task_invoice_lines', 'pick_task_move_events'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = t
        AND policyname = t || '_authenticated_read'
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL)',
        t || '_authenticated_read', t
      );
    END IF;
  END LOOP;
END $$;

GRANT SELECT ON public.pick_tasks, public.pick_task_lines,
  public.pick_task_invoice_lines, public.pick_task_move_events TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.pick_tasks, public.pick_task_lines,
  public.pick_task_invoice_lines, public.pick_task_move_events FROM anon, authenticated;

-- Create a picking task from an ERP reservation (or manual document).
-- p_lines is a JSON array: [{ "source_line_id":"...", "product_id":"uuid", "requested_quantity":2 }]
CREATE OR REPLACE FUNCTION public.create_pick_task(
  p_source_system text,
  p_source_document_type text,
  p_source_document_no text,
  p_source_document_id text,
  p_lines jsonb,
  p_notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_task_id uuid;
  v_line jsonb;
  v_source_line_id text;
  v_product_id uuid;
  v_qty integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_source_document_no IS NULL OR btrim(p_source_document_no) = '' THEN
    RAISE EXCEPTION 'Source document number is required';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'At least one picking line is required';
  END IF;

  SELECT id INTO v_task_id
  FROM public.pick_tasks
  WHERE source_system = coalesce(nullif(btrim(p_source_system), ''), 'MANUAL')
    AND source_document_type = coalesce(nullif(btrim(p_source_document_type), ''), 'RESERVATION')
    AND source_document_no = btrim(p_source_document_no);

  IF v_task_id IS NOT NULL THEN
    RAISE EXCEPTION 'Picking task already exists for this source document';
  END IF;

  INSERT INTO public.pick_tasks (
    source_system, source_document_type, source_document_no,
    source_document_id, notes, created_by
  ) VALUES (
    coalesce(nullif(btrim(p_source_system), ''), 'MANUAL'),
    coalesce(nullif(btrim(p_source_document_type), ''), 'RESERVATION'),
    btrim(p_source_document_no), nullif(btrim(p_source_document_id), ''),
    p_notes, auth.uid()
  ) RETURNING id INTO v_task_id;

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines)
  LOOP
    v_source_line_id := nullif(btrim(v_line->>'source_line_id'), '');
    v_product_id := (v_line->>'product_id')::uuid;
    v_qty := (v_line->>'requested_quantity')::integer;
    IF v_source_line_id IS NULL OR v_product_id IS NULL OR v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'Each line requires source_line_id, product_id and positive requested_quantity';
    END IF;
    INSERT INTO public.pick_task_lines (task_id, source_line_id, product_id, requested_quantity)
    VALUES (v_task_id, v_source_line_id, v_product_id, v_qty);
  END LOOP;

  RETURN v_task_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_pick_task(text, text, text, text, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_pick_task(text, text, text, text, jsonb, text) TO authenticated;

-- Move a partial/full picked quantity from storage to the dedicated STAGING location.
-- Stock is moved, never issued OUT. The physical total remains unchanged.
CREATE OR REPLACE FUNCTION public.pick_task_move_to_staging(
  p_idempotency_key text,
  p_task_line_id uuid,
  p_from_location_id uuid,
  p_quantity integer,
  p_notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_line public.pick_task_lines%ROWTYPE;
  v_task public.pick_tasks%ROWTYPE;
  v_staging_location_id uuid;
  v_stock_transaction_id uuid;
  v_existing public.pick_task_move_events%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'Idempotency key is required';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN RAISE EXCEPTION 'Quantity must be positive'; END IF;

  SELECT * INTO v_existing
  FROM public.pick_task_move_events
  WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.task_line_id <> p_task_line_id
       OR v_existing.from_location_id <> p_from_location_id
       OR v_existing.quantity <> p_quantity THEN
      RAISE EXCEPTION 'Idempotency key reused with different picking data';
    END IF;
    RETURN v_existing.stock_transaction_id;
  END IF;

  SELECT * INTO v_line
  FROM public.pick_task_lines
  WHERE id = p_task_line_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Picking task line not found'; END IF;

  -- Recheck after acquiring the line lock: concurrent retries with the same
  -- idempotency key must return the original transaction, not attempt a second move.
  SELECT * INTO v_existing
  FROM public.pick_task_move_events
  WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.task_line_id <> p_task_line_id
       OR v_existing.from_location_id <> p_from_location_id
       OR v_existing.quantity <> p_quantity THEN
      RAISE EXCEPTION 'Idempotency key reused with different picking data';
    END IF;
    RETURN v_existing.stock_transaction_id;
  END IF;

  SELECT * INTO v_task FROM public.pick_tasks WHERE id = v_line.task_id FOR UPDATE;
  IF NOT FOUND OR v_task.status IN ('CANCELLED', 'CLOSED') THEN
    RAISE EXCEPTION 'Picking task is not open';
  END IF;
  IF v_line.picked_quantity + p_quantity > v_line.requested_quantity THEN
    RAISE EXCEPTION 'Picked quantity cannot exceed requested quantity';
  END IF;

  SELECT id INTO v_staging_location_id
  FROM public.locations
  WHERE location_code = 'STAGING' AND is_active = true
  LIMIT 1;
  IF v_staging_location_id IS NULL THEN
    RAISE EXCEPTION 'Active location_code STAGING is required before picking';
  END IF;
  IF p_from_location_id = v_staging_location_id THEN
    RAISE EXCEPTION 'Source location cannot be STAGING';
  END IF;

  v_stock_transaction_id := public.process_stock_transaction(
    'PICK:' || p_idempotency_key, 'MOVE', v_line.product_id, p_quantity,
    p_from_location_id, v_staging_location_id,
    coalesce(p_notes, 'Picking task ' || v_task.source_document_no)
  );

  INSERT INTO public.pick_task_move_events (
    idempotency_key, task_line_id, stock_transaction_id,
    from_location_id, to_location_id, quantity, created_by
  ) VALUES (
    p_idempotency_key, p_task_line_id, v_stock_transaction_id,
    p_from_location_id, v_staging_location_id, p_quantity, auth.uid()
  );

  UPDATE public.pick_task_lines
  SET picked_quantity = picked_quantity + p_quantity, updated_at = now()
  WHERE id = p_task_line_id;

  UPDATE public.pick_tasks
  SET status = CASE
      WHEN EXISTS (
        SELECT 1 FROM public.pick_task_lines l
        WHERE l.task_id = v_task.id AND l.picked_quantity < l.requested_quantity
      ) THEN 'IN_PROGRESS'
      ELSE 'READY'
    END,
    updated_at = now()
  WHERE id = v_task.id;

  RETURN v_stock_transaction_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.pick_task_move_to_staging(text, uuid, uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pick_task_move_to_staging(text, uuid, uuid, integer, text) TO authenticated;
