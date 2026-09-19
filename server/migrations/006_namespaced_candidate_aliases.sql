DO $$
DECLARE
  constraint_record RECORD;
BEGIN
  FOR constraint_record IN
    SELECT
      namespace.nspname AS schema_name,
      relation.relname AS table_name,
      constraint_definition.conname AS constraint_name
    FROM pg_constraint constraint_definition
    JOIN pg_class relation ON relation.oid = constraint_definition.conrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE constraint_definition.contype = 'u'
      AND namespace.nspname = 'public'
      AND relation.relname IN (
        'candidate_source_ids',
        'geography_source_ids',
        'election_source_ids',
        'contest_source_ids',
        'contest_choice_source_ids'
      )
      AND PG_GET_CONSTRAINTDEF(constraint_definition.oid) NOT LIKE '%identifier_namespace%'
  LOOP
    EXECUTE FORMAT(
      'ALTER TABLE %I.%I DROP CONSTRAINT %I',
      constraint_record.schema_name,
      constraint_record.table_name,
      constraint_record.constraint_name
    );
  END LOOP;
END $$;
