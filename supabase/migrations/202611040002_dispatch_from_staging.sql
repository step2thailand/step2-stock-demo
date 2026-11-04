-- WANGANUBAL INVENTORY: dispatch picked goods from STAGING
-- Draft migration for review. Do NOT apply until the Dispatch workflow is approved.
-- Dispatch records an OUT transaction only after an authenticated user confirms handover.
-- Partial dispatch is supported; the task becomes CLOSED only when every picked unit is dispatched.

CREATE TABLE IF NOT EXISTS public.pick_task_dispatch_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  task_line_id uuid NOT NULL REFERENCES public.pick_task_lines(id) ON DELETE RESTRICT,
  stock_transaction_id uuid NOT NULL REFERENCES public.stock_transactions(id) ON DELETE RESTRICT,
  from_location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0),
  dispatched_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pick_task_dispatch_events_line_idx
  ON public.pick_task_dispatch_events (task_line_id, created_at DESC);

ALTER TABLE public.pick_task_dispatch_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'pick_task_dispatch_events'
      AND policyname = 'pick_task_dispatch_events_authenticated_read'
  ) THEN
    CREATE POLICY pick_task_dispatch_events_authenticated_read
      ON public.pick_task_dispatch_events
      FOR SELECT TO authenticated
      USING (auth.uid() IS NOT NULL);
  END IF;
END $$;

GRANT SELECT ON public.pick_task_dispatch_events TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.pick_task_dispatch_events FROM anon, authenticated;

-- Dispatch a quantity previously picked for one reservation line.
-- The function is idempotent and atomically records the OUT stock transaction
-- plus its task-line audit event. A task stays READY for partial dispatch and
-- changes to CLOSED only after every picked unit on every line is dispatched.
CREATE OR REPLACE FUNCTION public.dispatch_pick_task_line(
  p_idempotency_key text,
  p_task_line_id uuid,
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
  v_existing public.pick_task_dispatch_events%ROWTYPE;
  v_dispatched_quantity integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'Idempotency key is required';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be positive';
  END IF;

  SELECT * INTO v_existing
  FROM public.pick_task_dispatch_events
  WHERE idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_existing.task_line_id <> p_task_line_id
       OR v_existing.quantity <> p_quantity THEN
      RAISE EXCEPTION 'Idempotency key reused with different dispatch data';
    END IF;
    RETURN v_existing.stock_transaction_id;
  END IF;

  -- Keep the same line-then-task lock order as the Picking RPC.
  SELECT * INTO v_line
  FROM public.pick_task_lines
  WHERE id = p_task_line_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Picking task line not found';
  END IF;

  -- Recheck after locking to make concurrent retries safe.
  SELECT * INTO v_existing
  FROM public.pick_task_dispatch_events
  WHERE idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_existing.task_line_id <> p_task_line_id
       OR v_existing.quantity <> p_quantity THEN
      RAISE EXCEPTION 'Idempotency key reused with different dispatch data';
    END IF;
    RETURN v_existing.stock_transaction_id;
  END IF;

  SELECT * INTO v_task
  FROM public.pick_tasks
  WHERE id = v_line.task_id
  FOR UPDATE;

  IF NOT FOUND OR v_task.status <> 'READY' THEN
    RAISE EXCEPTION 'Picking task must be READY before dispatch';
  END IF;

  SELECT COALESCE(SUM(quantity), 0)::integer
  INTO v_dispatched_quantity
  FROM public.pick_task_dispatch_events
  WHERE task_line_id = v_line.id;

  IF v_line.picked_quantity < v_line.requested_quantity THEN
    RAISE EXCEPTION 'All requested quantities must be picked before dispatch';
  END IF;

  IF v_dispatched_quantity + p_quantity > v_line.picked_quantity THEN
    RAISE EXCEPTION 'Dispatch quantity cannot exceed the picked quantity remaining';
  END IF;

  SELECT id INTO v_staging_location_id
  FROM public.locations
  WHERE location_code = 'STAGING'
    AND is_active = true
  LIMIT 1;

  IF v_staging_location_id IS NULL THEN
    RAISE EXCEPTION 'Active location_code STAGING is required before dispatch';
  END IF;

  v_stock_transaction_id := public.process_stock_transaction(
    'DISPATCH:' || p_idempotency_key,
    'OUT',
    v_line.product_id,
    p_quantity,
    v_staging_location_id,
    NULL,
    COALESCE(p_notes, 'Dispatch ' || v_task.source_document_no)
  );

  INSERT INTO public.pick_task_dispatch_events (
    idempotency_key,
    task_line_id,
    stock_transaction_id,
    from_location_id,
    quantity,
    dispatched_by
  ) VALUES (
    p_idempotency_key,
    v_line.id,
    v_stock_transaction_id,
    v_staging_location_id,
    p_quantity,
    auth.uid()
  );

  IF NOT EXISTS (
    SELECT 1
    FROM public.pick_task_lines l
    WHERE l.task_id = v_task.id
      AND (
        l.picked_quantity < l.requested_quantity
        OR COALESCE((
          SELECT SUM(e.quantity)
          FROM public.pick_task_dispatch_events e
          WHERE e.task_line_id = l.id
        ), 0) < l.picked_quantity
      )
  ) THEN
    UPDATE public.pick_tasks
    SET status = 'CLOSED',
        updated_at = now()
    WHERE id = v_task.id;
  END IF;

  RETURN v_stock_transaction_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.dispatch_pick_task_line(text, uuid, integer, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dispatch_pick_task_line(text, uuid, integer, text)
  TO authenticated;
