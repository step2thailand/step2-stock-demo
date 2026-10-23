-- WANGANUBAL INVENTORY: product brand/category support
-- Safe migration: adds nullable classification fields and a separate admin-only RPC.
-- Existing products and stock balances are preserved.
-- Review this file and run it in Supabase SQL Editor BEFORE testing the updated UI branch.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS brand_name text,
  ADD COLUMN IF NOT EXISTS category_name text;

CREATE OR REPLACE FUNCTION public.set_product_classification(
  p_product_id uuid,
  p_brand_name text DEFAULT NULL,
  p_category_name text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT public.is_app_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  UPDATE public.products
  SET
    brand_name = NULLIF(btrim(p_brand_name), ''),
    category_name = NULLIF(btrim(p_category_name), '')
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product not found';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_product_classification(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_product_classification(uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_product_classification(uuid, text, text) TO authenticated;
