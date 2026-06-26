\set ON_ERROR_STOP on

DROP TRIGGER IF EXISTS storefront_products_redeploy
  ON public.merch_storefront_products;
DROP FUNCTION IF EXISTS public.notify_vercel_storefront_changed();

DO $drop_policies$
DECLARE
  policy record;
BEGIN
  FOR policy IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname IN ('public', 'private')
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I.%I',
      policy.policyname,
      policy.schemaname,
      policy.tablename
    );
  END LOOP;
END
$drop_policies$;

DO $disable_rls$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'private')
      AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I DISABLE ROW LEVEL SECURITY',
      item.schema_name,
      item.table_name
    );
    EXECUTE format(
      'ALTER TABLE %I.%I NO FORCE ROW LEVEL SECURITY',
      item.schema_name,
      item.table_name
    );
  END LOOP;
END
$disable_rls$;

ALTER SCHEMA public OWNER TO komui_owner;
ALTER SCHEMA private OWNER TO komui_owner;
REVOKE ALL ON SCHEMA public, private FROM PUBLIC;
GRANT USAGE ON SCHEMA public, private TO komui_app, komui_backup;
GRANT USAGE, CREATE ON SCHEMA public, private TO komui_owner;

DO $owners$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT n.nspname AS schema_name, c.relname AS object_name, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'private')
      AND c.relkind IN ('r', 'p', 'S', 'v', 'm')
      AND (
        c.relkind <> 'S'
        OR NOT EXISTS (
          SELECT 1
          FROM pg_depend d
          WHERE d.classid = 'pg_class'::regclass
            AND d.objid = c.oid
            AND d.deptype IN ('a', 'i')
        )
      )
  LOOP
    EXECUTE format(
      'ALTER %s %I.%I OWNER TO komui_owner',
      CASE item.relkind
        WHEN 'S' THEN 'SEQUENCE'
        WHEN 'v' THEN 'VIEW'
        WHEN 'm' THEN 'MATERIALIZED VIEW'
        ELSE 'TABLE'
      END,
      item.schema_name,
      item.object_name
    );
  END LOOP;
END
$owners$;

DO $function_owners$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT
      n.nspname AS schema_name,
      p.proname AS function_name,
      pg_get_function_identity_arguments(p.oid) AS arguments
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'private')
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%I(%s) OWNER TO komui_owner',
      item.schema_name,
      item.function_name,
      item.arguments
    );
  END LOOP;
END
$function_owners$;

DO $validate_foreign_keys$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT
      n.nspname AS schema_name,
      c.relname AS table_name,
      con.conname AS constraint_name
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'private')
      AND con.contype = 'f'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I VALIDATE CONSTRAINT %I',
      item.schema_name,
      item.table_name,
      item.constraint_name
    );
  END LOOP;
END
$validate_foreign_keys$;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public, private
  FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public, private
  FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public, private
  FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public, private
  FROM anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public, private
  FROM anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public, private
  FROM anon, authenticated, service_role;
REVOKE ALL ON SCHEMA public, private
  FROM anon, authenticated, service_role;

DO $app_table_grants$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'private')
      AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format(
      'GRANT SELECT ON TABLE %I.%I TO komui_backup',
      item.schema_name,
      item.table_name
    );

    IF item.table_name NOT LIKE 'merch_products_backup_%' THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO komui_app',
        item.schema_name,
        item.table_name
      );
    END IF;
  END LOOP;
END
$app_table_grants$;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public, private
  TO komui_app;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public, private
  TO komui_backup;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public, private
  TO komui_app;

ALTER DEFAULT PRIVILEGES FOR ROLE komui_owner IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE komui_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO komui_app;
ALTER DEFAULT PRIVILEGES FOR ROLE komui_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO komui_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE komui_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO komui_app;
ALTER DEFAULT PRIVILEGES FOR ROLE komui_owner IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO komui_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE komui_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO komui_app;

ALTER DEFAULT PRIVILEGES FOR ROLE komui_owner IN SCHEMA private
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE komui_owner IN SCHEMA private
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO komui_app;
ALTER DEFAULT PRIVILEGES FOR ROLE komui_owner IN SCHEMA private
  GRANT SELECT ON TABLES TO komui_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE komui_owner IN SCHEMA private
  GRANT USAGE, SELECT ON SEQUENCES TO komui_app;
ALTER DEFAULT PRIVILEGES FOR ROLE komui_owner IN SCHEMA private
  GRANT SELECT ON SEQUENCES TO komui_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE komui_owner IN SCHEMA private
  GRANT EXECUTE ON FUNCTIONS TO komui_app;

DROP ROLE IF EXISTS anon;
DROP ROLE IF EXISTS authenticated;
DROP ROLE IF EXISTS service_role;

VACUUM (ANALYZE);
