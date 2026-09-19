DO $$
DECLARE
  table_record RECORD;
  has_rows BOOLEAN;
BEGIN
  FOR table_record IN
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN ('data_sources', 'offices', 'schema_migrations', 'spatial_ref_sys')
  LOOP
    EXECUTE FORMAT('SELECT EXISTS (SELECT 1 FROM %I.%I LIMIT 1)', table_record.schemaname, table_record.tablename)
      INTO has_rows;
    IF has_rows THEN
      RAISE EXCEPTION 'UUID migration requires empty application tables; %.% contains data', table_record.schemaname, table_record.tablename;
    END IF;
  END LOOP;
END $$;

CREATE TEMP TABLE uuid_fk_constraints ON COMMIT DROP AS
SELECT
  namespace.nspname AS schema_name,
  relation.relname AS table_name,
  constraint_record.conname AS constraint_name,
  PG_GET_CONSTRAINTDEF(constraint_record.oid) AS definition
FROM pg_constraint constraint_record
JOIN pg_class relation ON relation.oid = constraint_record.conrelid
JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
WHERE constraint_record.contype IN ('f', 'c')
  AND namespace.nspname = 'public';

DO $$
DECLARE
  constraint_record RECORD;
BEGIN
  FOR constraint_record IN SELECT * FROM uuid_fk_constraints
  LOOP
    EXECUTE FORMAT(
      'ALTER TABLE %I.%I DROP CONSTRAINT %I',
      constraint_record.schema_name,
      constraint_record.table_name,
      constraint_record.constraint_name
    );
  END LOOP;
END $$;

CREATE TEMP TABLE uuid_columns ON COMMIT DROP AS
SELECT
  table_schema,
  table_name,
  column_name,
  column_name = 'id' AS receives_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND data_type = 'bigint'
  AND (column_name = 'id' OR column_name LIKE '%\_id' ESCAPE '\');

DO $$
DECLARE
  column_record RECORD;
BEGIN
  FOR column_record IN SELECT * FROM uuid_columns ORDER BY receives_default DESC, table_name, column_name
  LOOP
    IF column_record.receives_default THEN
      EXECUTE FORMAT(
        'ALTER TABLE %I.%I ALTER COLUMN %I DROP IDENTITY IF EXISTS',
        column_record.table_schema,
        column_record.table_name,
        column_record.column_name
      );
      EXECUTE FORMAT(
        'ALTER TABLE %I.%I ALTER COLUMN %I TYPE UUID USING gen_random_uuid()',
        column_record.table_schema,
        column_record.table_name,
        column_record.column_name
      );
      EXECUTE FORMAT(
        'ALTER TABLE %I.%I ALTER COLUMN %I SET DEFAULT gen_random_uuid()',
        column_record.table_schema,
        column_record.table_name,
        column_record.column_name
      );
    ELSE
      EXECUTE FORMAT(
        'ALTER TABLE %I.%I ALTER COLUMN %I TYPE UUID USING NULL::UUID',
        column_record.table_schema,
        column_record.table_name,
        column_record.column_name
      );
    END IF;
  END LOOP;
END $$;

ALTER TABLE ingestion_runs ALTER COLUMN id SET DEFAULT gen_random_uuid();

DO $$
DECLARE
  constraint_record RECORD;
BEGIN
  FOR constraint_record IN SELECT * FROM uuid_fk_constraints
  LOOP
    EXECUTE FORMAT(
      'ALTER TABLE %I.%I ADD CONSTRAINT %I %s',
      constraint_record.schema_name,
      constraint_record.table_name,
      constraint_record.constraint_name,
      constraint_record.definition
    );
  END LOOP;
END $$;
