-- Rollback for KOMUI production Supabase hardening.
-- Restores the captured 2026-06-25 public access model.
-- This intentionally restores insecure access and is emergency-only.
--
-- Required session gate:
--   SET komui.approve_production_rollback = 'YES';

BEGIN;

DO $guard$
BEGIN
  IF current_setting('komui.approve_production_rollback', true)
       IS DISTINCT FROM 'YES' THEN
    RAISE EXCEPTION
      'Refusing production rollback: set komui.approve_production_rollback=YES';
  END IF;
END
$guard$;

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
  END LOOP;
END
$policies$;

GRANT ALL PRIVILEGES ON TABLE
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
  public.merch_expenses,
  public.merch_storefront_products,
  public.merch_products_backup_20260622,
  public.merch_products_backup_v2
TO anon, authenticated;

CREATE POLICY anon_all_merch_colors
  ON public.merch_colors FOR ALL TO anon
  USING (true) WITH CHECK (true);
CREATE POLICY authenticated_all_merch_colors
  ON public.merch_colors FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

CREATE POLICY anon_all_merch_decoration_types
  ON public.merch_decoration_types FOR ALL TO anon
  USING (true) WITH CHECK (true);
CREATE POLICY authenticated_all_merch_decoration_types
  ON public.merch_decoration_types FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

CREATE POLICY anon_all_merch_designs
  ON public.merch_designs FOR ALL TO anon
  USING (true) WITH CHECK (true);
CREATE POLICY authenticated_all_merch_designs
  ON public.merch_designs FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

CREATE POLICY expense_categories_all
  ON public.merch_expense_categories FOR ALL TO PUBLIC
  USING (true) WITH CHECK (true);
CREATE POLICY expenses_all
  ON public.merch_expenses FOR ALL TO PUBLIC
  USING (true) WITH CHECK (true);

CREATE POLICY anon_all_merch_fabric_types
  ON public.merch_fabric_types FOR ALL TO anon
  USING (true) WITH CHECK (true);
CREATE POLICY authenticated_all_merch_fabric_types
  ON public.merch_fabric_types FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

CREATE POLICY anon_all_merch_inventory
  ON public.merch_inventory FOR ALL TO anon
  USING (true) WITH CHECK (true);
CREATE POLICY authenticated_all_merch_inventory
  ON public.merch_inventory FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

CREATE POLICY ozon_finance_ops_all
  ON public.merch_ozon_finance_operations FOR ALL TO PUBLIC
  USING (true) WITH CHECK (true);
CREATE POLICY ozon_order_items_all
  ON public.merch_ozon_order_items FOR ALL TO PUBLIC
  USING (true) WITH CHECK (true);
CREATE POLICY ozon_orders_all
  ON public.merch_ozon_orders FOR ALL TO PUBLIC
  USING (true) WITH CHECK (true);
CREATE POLICY print_inventory_all
  ON public.merch_print_inventory FOR ALL TO PUBLIC
  USING (true) WITH CHECK (true);

CREATE POLICY anon_all_merch_product_categories
  ON public.merch_product_categories FOR ALL TO anon
  USING (true) WITH CHECK (true);
CREATE POLICY authenticated_all_merch_product_categories
  ON public.merch_product_categories FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

CREATE POLICY anon_all_merch_products
  ON public.merch_products FOR ALL TO anon
  USING (true) WITH CHECK (true);
CREATE POLICY authenticated_all_merch_products
  ON public.merch_products FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

CREATE POLICY anon_all_merch_sizes
  ON public.merch_sizes FOR ALL TO anon
  USING (true) WITH CHECK (true);
CREATE POLICY authenticated_all_merch_sizes
  ON public.merch_sizes FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

CREATE POLICY anon_all_merch_transactions
  ON public.merch_transactions FOR ALL TO anon
  USING (true) WITH CHECK (true);
CREATE POLICY authenticated_all_merch_transactions
  ON public.merch_transactions FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

CREATE POLICY anon_all_merch_warehouses
  ON public.merch_warehouses FOR ALL TO anon
  USING (true) WITH CHECK (true);
CREATE POLICY authenticated_all_merch_warehouses
  ON public.merch_warehouses FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

CREATE POLICY anon_all_merch_workshop_order_items
  ON public.merch_workshop_order_items FOR ALL TO anon
  USING (true) WITH CHECK (true);
CREATE POLICY authenticated_all_merch_workshop_order_items
  ON public.merch_workshop_order_items FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

CREATE POLICY anon_all_merch_workshop_orders
  ON public.merch_workshop_orders FOR ALL TO anon
  USING (true) WITH CHECK (true);
CREATE POLICY authenticated_all_merch_workshop_orders
  ON public.merch_workshop_orders FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

GRANT USAGE ON SEQUENCE
  public.merch_cdek_events_id_seq,
  public.merch_cdek_shipments_id_seq,
  public.merch_customer_order_items_id_seq,
  public.merch_payment_attempts_id_seq,
  public.merch_payment_events_id_seq
TO anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.notify_vercel_storefront_changed()
TO PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.update_inventory_timestamp()
TO PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  private.merch_set_updated_at()
TO PUBLIC;

COMMIT;
