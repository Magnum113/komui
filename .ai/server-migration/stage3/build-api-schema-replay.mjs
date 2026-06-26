import { readFile, writeFile, chmod } from "node:fs/promises";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error("Usage: build-api-schema-replay.mjs migrations.json schema.sql");
}

const migrations = JSON.parse(await readFile(inputPath, "utf8"));
const excluded = new Set([
  "enable_rls_on_merch_products_backups",
  "add_storefront_redeploy_webhook",
]);

const chunks = [
  "\\set ON_ERROR_STOP on\n",
  `
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$roles$;
`,
];

for (const migration of migrations) {
  if (excluded.has(migration.name)) continue;
  chunks.push(`\n-- migration ${migration.version} ${migration.name}\n`);
  for (const statement of migration.statements ?? []) {
    const sql = String(statement).trimEnd();
    chunks.push(sql, sql.endsWith(";") ? "\n" : ";\n");
  }
}

chunks.push(`
-- Backup tables were created operationally and are absent from migration history.
CREATE TABLE public.merch_products_backup_20260622 (
  id uuid,
  category_id uuid,
  fabric_id uuid,
  color_id uuid,
  size_id uuid,
  design_id uuid,
  decoration_type_id uuid,
  sku text,
  is_blank boolean,
  cost_price numeric,
  sale_price numeric,
  created_at timestamptz,
  legacy_skus text[],
  ozon_sku bigint,
  design_version text,
  hoodie_fit text,
  hoodie_fabric text
);

CREATE TABLE public.merch_products_backup_v2 (
  LIKE public.merch_products_backup_20260622
);
`);

await writeFile(outputPath, chunks.join(""), { mode: 0o600 });
await chmod(outputPath, 0o600);

console.log(
  JSON.stringify({
    migrations: migrations.length,
    excluded: [...excluded],
    output: outputPath,
  }),
);
