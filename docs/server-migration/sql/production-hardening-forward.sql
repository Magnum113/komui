-- KOMUI production Supabase hardening.
-- SNAPSHOT: 2026-06-25.
-- DO NOT APPLY without a tested backup, staging rehearsal and explicit approval.
--
-- Required session gate:
--   SET komui.approve_production_hardening = 'YES';
--
-- Without the gate the transaction fails before any change.

BEGIN;

DO $guard$
BEGIN
  IF current_setting('komui.approve_production_hardening', true)
       IS DISTINCT FROM 'YES' THEN
    RAISE EXCEPTION
      'Refusing production hardening: set komui.approve_production_hardening=YES';
  END IF;
END
$guard$;

REVOKE ALL PRIVILEGES ON TABLE
  public.merch_warehouses,
  public.merch_product_categories,
  public.merch_fabric_types,
  public.merch_colors,
  public.merch_sizes,
  public.merch_decoration_types,
  public.merch_designs,
  public.merch_products,
  public.merch_inventory,
  public.merch_transactions,
  public.merch_print_inventory,
  public.merch_workshop_orders,
  public.merch_workshop_order_items,
  public.merch_ozon_orders,
  public.merch_ozon_order_items,
  public.merch_ozon_finance_operations,
  public.merch_expense_categories,
  public.merch_expenses
FROM anon, authenticated;

DROP POLICY IF EXISTS anon_all_merch_colors
  ON public.merch_colors;
DROP POLICY IF EXISTS authenticated_all_merch_colors
  ON public.merch_colors;
DROP POLICY IF EXISTS anon_all_merch_decoration_types
  ON public.merch_decoration_types;
DROP POLICY IF EXISTS authenticated_all_merch_decoration_types
  ON public.merch_decoration_types;
DROP POLICY IF EXISTS anon_all_merch_designs
  ON public.merch_designs;
DROP POLICY IF EXISTS authenticated_all_merch_designs
  ON public.merch_designs;
DROP POLICY IF EXISTS expense_categories_all
  ON public.merch_expense_categories;
DROP POLICY IF EXISTS expenses_all
  ON public.merch_expenses;
DROP POLICY IF EXISTS anon_all_merch_fabric_types
  ON public.merch_fabric_types;
DROP POLICY IF EXISTS authenticated_all_merch_fabric_types
  ON public.merch_fabric_types;
DROP POLICY IF EXISTS anon_all_merch_inventory
  ON public.merch_inventory;
DROP POLICY IF EXISTS authenticated_all_merch_inventory
  ON public.merch_inventory;
DROP POLICY IF EXISTS ozon_finance_ops_all
  ON public.merch_ozon_finance_operations;
DROP POLICY IF EXISTS ozon_order_items_all
  ON public.merch_ozon_order_items;
DROP POLICY IF EXISTS ozon_orders_all
  ON public.merch_ozon_orders;
DROP POLICY IF EXISTS print_inventory_all
  ON public.merch_print_inventory;
DROP POLICY IF EXISTS anon_all_merch_product_categories
  ON public.merch_product_categories;
DROP POLICY IF EXISTS authenticated_all_merch_product_categories
  ON public.merch_product_categories;
DROP POLICY IF EXISTS anon_all_merch_products
  ON public.merch_products;
DROP POLICY IF EXISTS authenticated_all_merch_products
  ON public.merch_products;
DROP POLICY IF EXISTS anon_all_merch_sizes
  ON public.merch_sizes;
DROP POLICY IF EXISTS authenticated_all_merch_sizes
  ON public.merch_sizes;
DROP POLICY IF EXISTS anon_all_merch_transactions
  ON public.merch_transactions;
DROP POLICY IF EXISTS authenticated_all_merch_transactions
  ON public.merch_transactions;
DROP POLICY IF EXISTS anon_all_merch_warehouses
  ON public.merch_warehouses;
DROP POLICY IF EXISTS authenticated_all_merch_warehouses
  ON public.merch_warehouses;
DROP POLICY IF EXISTS anon_all_merch_workshop_order_items
  ON public.merch_workshop_order_items;
DROP POLICY IF EXISTS authenticated_all_merch_workshop_order_items
  ON public.merch_workshop_order_items;
DROP POLICY IF EXISTS anon_all_merch_workshop_orders
  ON public.merch_workshop_orders;
DROP POLICY IF EXISTS authenticated_all_merch_workshop_orders
  ON public.merch_workshop_orders;

DO $policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'merch_warehouses',
    'merch_product_categories',
    'merch_fabric_types',
    'merch_colors',
    'merch_sizes',
    'merch_decoration_types',
    'merch_designs',
    'merch_products',
    'merch_inventory',
    'merch_transactions',
    'merch_print_inventory',
    'merch_workshop_orders',
    'merch_workshop_order_items',
    'merch_ozon_orders',
    'merch_ozon_order_items',
    'merch_ozon_finance_operations',
    'merch_expense_categories',
    'merch_expenses'
  ]
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.%I',
      'No direct client access',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)',
      'No direct client access',
      table_name
    );
  END LOOP;
END
$policies$;

REVOKE ALL PRIVILEGES ON TABLE
  public.merch_storefront_products
FROM anon, authenticated;

GRANT SELECT ON TABLE
  public.merch_storefront_products
TO anon, authenticated;

REVOKE ALL PRIVILEGES ON TABLE
  public.merch_products_backup_20260622,
  public.merch_products_backup_v2
FROM anon, authenticated;

REVOKE USAGE ON SEQUENCE
  public.merch_cdek_events_id_seq,
  public.merch_cdek_shipments_id_seq,
  public.merch_customer_order_items_id_seq,
  public.merch_payment_attempts_id_seq,
  public.merch_payment_events_id_seq
FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION
  public.notify_vercel_storefront_changed()
FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION
  public.update_inventory_timestamp()
FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION
  private.merch_set_updated_at()
FROM PUBLIC, anon, authenticated;

COMMIT;
