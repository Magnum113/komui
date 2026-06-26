\pset tuples_only on
\pset format unaligned

SELECT jsonb_build_object(
  'merch_warehouses', (SELECT count(*) FROM public.merch_warehouses),
  'merch_product_categories', (SELECT count(*) FROM public.merch_product_categories),
  'merch_fabric_types', (SELECT count(*) FROM public.merch_fabric_types),
  'merch_colors', (SELECT count(*) FROM public.merch_colors),
  'merch_sizes', (SELECT count(*) FROM public.merch_sizes),
  'merch_designs', (SELECT count(*) FROM public.merch_designs),
  'merch_decoration_types', (SELECT count(*) FROM public.merch_decoration_types),
  'merch_products', (SELECT count(*) FROM public.merch_products),
  'merch_inventory', (SELECT count(*) FROM public.merch_inventory),
  'merch_workshop_orders', (SELECT count(*) FROM public.merch_workshop_orders),
  'merch_workshop_order_items', (SELECT count(*) FROM public.merch_workshop_order_items),
  'merch_transactions', (SELECT count(*) FROM public.merch_transactions),
  'merch_ozon_orders', (SELECT count(*) FROM public.merch_ozon_orders),
  'merch_ozon_order_items', (SELECT count(*) FROM public.merch_ozon_order_items),
  'merch_print_inventory', (SELECT count(*) FROM public.merch_print_inventory),
  'merch_expense_categories', (SELECT count(*) FROM public.merch_expense_categories),
  'merch_expenses', (SELECT count(*) FROM public.merch_expenses),
  'merch_ozon_finance_operations', (SELECT count(*) FROM public.merch_ozon_finance_operations),
  'merch_storefront_products', (SELECT count(*) FROM public.merch_storefront_products),
  'merch_products_backup_20260622', (SELECT count(*) FROM public.merch_products_backup_20260622),
  'merch_products_backup_v2', (SELECT count(*) FROM public.merch_products_backup_v2),
  'merch_customer_orders', (SELECT count(*) FROM public.merch_customer_orders),
  'merch_customer_order_items', (SELECT count(*) FROM public.merch_customer_order_items),
  'merch_payment_attempts', (SELECT count(*) FROM public.merch_payment_attempts),
  'merch_payment_events', (SELECT count(*) FROM public.merch_payment_events),
  'merch_cdek_shipments', (SELECT count(*) FROM public.merch_cdek_shipments),
  'merch_cdek_events', (SELECT count(*) FROM public.merch_cdek_events),
  'merch_promo_codes', (SELECT count(*) FROM public.merch_promo_codes),
  'merch_promo_redemptions', (SELECT count(*) FROM public.merch_promo_redemptions)
) AS row_counts;

SELECT jsonb_build_object(
  'active_storefront_products',
    (SELECT count(*) FROM public.merch_storefront_products WHERE is_active),
  'inventory_quantity_total',
    (SELECT coalesce(sum(quantity), 0) FROM public.merch_inventory),
  'print_inventory_quantity_total',
    (SELECT coalesce(sum(quantity), 0) FROM public.merch_print_inventory),
  'ozon_orders_total',
    (SELECT count(*) FROM public.merch_ozon_orders),
  'ozon_items_quantity_total',
    (SELECT coalesce(sum(quantity), 0) FROM public.merch_ozon_order_items),
  'ozon_finance_amount_total',
    (SELECT coalesce(sum(amount), 0) FROM public.merch_ozon_finance_operations),
  'customer_orders_total',
    (SELECT count(*) FROM public.merch_customer_orders),
  'customer_orders_amount_total',
    (SELECT coalesce(sum(total_amount), 0) FROM public.merch_customer_orders),
  'payment_attempts_total',
    (SELECT count(*) FROM public.merch_payment_attempts),
  'promo_redemptions_total',
    (SELECT count(*) FROM public.merch_promo_redemptions)
) AS control_totals;

WITH cols AS (
  SELECT
    table_schema, table_name, ordinal_position, column_name, data_type,
    udt_schema, udt_name, is_nullable, column_default, is_identity,
    identity_generation
  FROM information_schema.columns
  WHERE table_schema IN ('public', 'private')
),
cons AS (
  SELECT
    n.nspname, c.relname, con.conname, con.contype,
    pg_get_constraintdef(con.oid, true) AS def
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'private')
),
idx AS (
  SELECT schemaname, tablename, indexname, indexdef
  FROM pg_indexes
  WHERE schemaname IN ('public', 'private')
),
funcs AS (
  SELECT
    n.nspname, p.proname,
    pg_get_function_identity_arguments(p.oid) AS args,
    pg_get_functiondef(p.oid) AS def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public', 'private')
),
trg AS (
  SELECT
    event_object_schema, event_object_table, trigger_name, action_timing,
    event_manipulation, action_statement
  FROM information_schema.triggers
  WHERE trigger_schema IN ('public', 'private')
)
SELECT jsonb_build_object(
  'column_count', (SELECT count(*) FROM cols),
  'columns_md5', (
    SELECT md5(string_agg(row(cols.*)::text, E'\n'
      ORDER BY table_schema, table_name, ordinal_position))
    FROM cols
  ),
  'constraint_count', (SELECT count(*) FROM cons),
  'constraints_md5', (
    SELECT md5(string_agg(row(cons.*)::text, E'\n'
      ORDER BY nspname, relname, conname))
    FROM cons
  ),
  'index_count', (SELECT count(*) FROM idx),
  'indexes_md5', (
    SELECT md5(string_agg(row(idx.*)::text, E'\n'
      ORDER BY schemaname, tablename, indexname))
    FROM idx
  ),
  'function_count', (SELECT count(*) FROM funcs),
  'functions_md5', (
    SELECT md5(string_agg(row(funcs.*)::text, E'\n'
      ORDER BY nspname, proname, args))
    FROM funcs
  ),
  'trigger_count', (SELECT count(*) FROM trg),
  'triggers_md5', (
    SELECT md5(string_agg(row(trg.*)::text, E'\n'
      ORDER BY event_object_schema, event_object_table, trigger_name,
      event_manipulation))
    FROM trg
  )
) AS schema_fingerprints;

SELECT jsonb_build_object(
  'tables', (
    SELECT count(*)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'private')
      AND c.relkind IN ('r', 'p')
  ),
  'sequences', (
    SELECT count(*)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'private')
      AND c.relkind = 'S'
  ),
  'policies', (
    SELECT count(*)
    FROM pg_policies
    WHERE schemaname IN ('public', 'private')
  ),
  'supabase_roles', (
    SELECT count(*)
    FROM pg_roles
    WHERE rolname IN ('anon', 'authenticated', 'service_role')
  ),
  'vercel_trigger', (
    SELECT count(*)
    FROM information_schema.triggers
    WHERE trigger_schema = 'public'
      AND trigger_name = 'storefront_products_redeploy'
  ),
  'vercel_function', (
    SELECT count(*)
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'notify_vercel_storefront_changed'
  )
) AS cleanup_status;

SELECT jsonb_build_object(
  'foreign_keys', count(*) FILTER (WHERE con.contype = 'f'),
  'unvalidated_foreign_keys',
    count(*) FILTER (WHERE con.contype = 'f' AND NOT con.convalidated)
)
FROM pg_constraint con
JOIN pg_namespace n ON n.oid = con.connamespace
WHERE n.nspname IN ('public', 'private');
