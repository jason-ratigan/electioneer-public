import { all } from '../db.js';

const electionTypeExpression = `
  CASE
    WHEN e.stage = 'primary' AND o.slug = 'president' THEN 'presidential_primary'
    WHEN e.stage = 'general' AND o.slug = 'president' THEN 'presidential_general'
    ELSE e.stage
  END
`;

export const electionRepository = {
  listRaces: ({ type, cycle, office, query }) => all(`
    SELECT
      c.id::TEXT AS id,
      e.cycle,
      ${electionTypeExpression} AS election_type,
      g.geography_type AS election_level,
      COALESCE(o.name, c.name) AS office,
      g.name AS jurisdiction,
      c.contest_type = 'ballot_measure' AS is_ballot_measure,
      latest.reporting,
      latest.reporting_basis,
      latest.observed_at,
      latest.source,
      latest.batch_status
    FROM contests c
    JOIN election_events e ON e.id = c.election_id
    LEFT JOIN offices o ON o.id = c.office_id
    JOIN geographies g ON g.id = c.district_geography_id
    LEFT JOIN LATERAL (
      SELECT
        rs.reporting_value AS reporting,
        rs.reporting_basis,
        rb.reported_at AS observed_at,
        ds.name AS source,
        rb.status AS batch_status
      FROM result_snapshots rs
      JOIN result_batches rb ON rb.id = rs.batch_id
      JOIN data_sources ds ON ds.id = rb.source_id
      WHERE rs.contest_id = c.id
      ORDER BY rb.reported_at DESC NULLS LAST, rb.retrieved_at DESC, rb.id DESC
      LIMIT 1
    ) latest ON TRUE
    WHERE ($1::TEXT IS NULL OR ${electionTypeExpression} = $1)
      AND ($2::INTEGER IS NULL OR e.cycle = $2)
      AND ($3::TEXT IS NULL OR COALESCE(o.name, c.name) = $3)
      AND ($4::TEXT IS NULL OR g.name ILIKE '%' || $4 || '%' OR c.name ILIKE '%' || $4 || '%')
    ORDER BY e.cycle DESC, COALESCE(o.name, c.name), g.name
  `, [type, cycle, office, query]),
  archiveFacets: async () => ({
    cycles: (await all('SELECT DISTINCT cycle FROM election_events ORDER BY cycle DESC')).map(row => row.cycle),
    offices: (await all(`
      SELECT DISTINCT COALESCE(o.name, c.name) AS office
      FROM contests c
      LEFT JOIN offices o ON o.id = c.office_id
      ORDER BY office
    `)).map(row => row.office)
  }),
  raceHistory: id => all(`
    SELECT
      rs.id::TEXT AS id,
      rb.reported_at AS observed_at,
      rb.retrieved_at,
      rb.status,
      rs.reporting_basis,
      rs.reporting_value AS reporting,
      rs.reported_units,
      rs.total_units,
      ds.name AS source,
      totals.total_votes,
      COALESCE(totals.choices, '[]'::JSONB) AS choices
    FROM result_snapshots rs
    JOIN contests c ON c.id = rs.contest_id
    JOIN result_batches rb ON rb.id = rs.batch_id
    JOIN data_sources ds ON ds.id = rb.source_id
    LEFT JOIN LATERAL (
      SELECT
        SUM(choice_total.votes)::BIGINT AS total_votes,
        JSONB_AGG(
          JSONB_BUILD_OBJECT(
            'choiceId', choice_total.choice_id::TEXT,
            'ballotName', choice_total.ballot_name,
            'votes', choice_total.votes
          ) ORDER BY choice_total.votes DESC, choice_total.ballot_name
        ) AS choices
      FROM (
        SELECT cc.id AS choice_id, cc.ballot_name, SUM(vt.votes)::BIGINT AS votes
        FROM vote_totals vt
        JOIN contest_choices cc ON cc.id = vt.contest_choice_id
        WHERE vt.snapshot_id = rs.id
          AND vt.reporting_unit_id = c.district_geography_id
          AND vt.vote_status = 'reported'
        GROUP BY cc.id, cc.ballot_name
      ) choice_total
    ) totals ON TRUE
    WHERE rs.contest_id = $1::UUID
    ORDER BY rb.reported_at NULLS FIRST, rb.retrieved_at, rb.id
  `, [id]),
  recentIngestRuns: () => all(`
    SELECT
      ir.id,
      ds.slug AS source,
      ir.started_at,
      ir.completed_at,
      ir.status,
      ir.rows_read,
      ir.rows_added,
      ir.rows_updated,
      ir.warning_count,
      ir.parser_name,
      ir.parser_version,
      ir.message
    FROM ingestion_runs ir
    JOIN data_sources ds ON ds.id = ir.source_id
    ORDER BY ir.started_at DESC
    LIMIT 20
  `),
  storage: async () => {
    const [stats] = await all(`
      SELECT
        (SELECT COUNT(*)::INTEGER FROM contests) AS contests,
        (SELECT COUNT(*)::INTEGER FROM vote_totals) AS vote_totals,
        (SELECT COUNT(*)::INTEGER FROM result_snapshots) AS result_snapshots,
        (SELECT COUNT(*)::INTEGER FROM geographies) AS geographies,
        (SELECT COUNT(*)::INTEGER FROM ingestion_runs) AS ingestion_runs,
        pg_database_size(current_database())::TEXT AS bytes
    `);
    const bytes = Number(stats.bytes);
    return { ...stats, bytes, megabytes: Number((bytes / 1048576).toFixed(2)) };
  }
};
