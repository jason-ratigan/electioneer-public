import { all } from '../db.js';

const latestSnapshots = `
  SELECT DISTINCT ON (snapshot.contest_id)
    snapshot.id,
    snapshot.contest_id,
    snapshot.reporting_basis,
    snapshot.reporting_value,
    snapshot.reported_units,
    snapshot.total_units,
    batch.reported_at,
    batch.retrieved_at,
    batch.status,
    source.name AS source_name
  FROM result_snapshots snapshot
  JOIN result_batches batch ON batch.id = snapshot.batch_id
  JOIN data_sources source ON source.id = batch.source_id
  ORDER BY
    snapshot.contest_id,
    batch.reported_at DESC NULLS LAST,
    batch.retrieved_at DESC,
    batch.id DESC
`;

function numberOrZero(value) {
  return value == null ? 0 : Number(value);
}

function groupContests(rows) {
  const contests = new Map();
  for (const row of rows) {
    if (!contests.has(row.contest_id)) {
      contests.set(row.contest_id, {
        id: row.contest_id,
        name: row.contest_name,
        districtLabel: row.district_label,
        office: { slug: row.office_slug, name: row.office_name },
        cycle: row.cycle,
        stage: row.stage,
        electionDate: row.election_date,
        state: {
          id: row.state_id,
          name: row.state_name,
          abbreviation: row.state_abbreviation,
          fips: row.state_fips
        },
        reporting: row.reporting_value == null ? null : Number(row.reporting_value),
        reportingBasis: row.reporting_basis,
        reportedUnits: row.reported_units,
        totalUnits: row.total_units,
        resultStatus: row.result_status,
        source: row.source_name,
        retrievedAt: row.retrieved_at,
        totalVotes: 0,
        choices: []
      });
    }
    const contest = contests.get(row.contest_id);
    if (row.choice_id) {
      const votes = numberOrZero(row.votes);
      contest.totalVotes += votes;
      contest.choices.push({
        id: row.choice_id,
        candidateId: row.candidate_id,
        ballotName: row.ballot_name,
        party: row.party_name,
        partyAbbreviation: row.party_abbreviation,
        votes
      });
    }
  }
  for (const contest of contests.values()) {
    contest.choices.sort((left, right) => right.votes - left.votes || left.ballotName.localeCompare(right.ballotName));
  }
  return [...contests.values()];
}

function rowsToFeatureCollection(rows, level) {
  const features = new Map();
  for (const row of rows) {
    if (!features.has(row.geography_id)) {
      features.set(row.geography_id, {
        type: 'Feature',
        id: row.geography_id,
        geometry: row.geometry,
        properties: {
          geographyId: row.geography_id,
          level,
          name: row.geography_name,
          abbreviation: row.geography_abbreviation,
          fips: row.geography_fips,
          reporting: row.reporting_value == null ? null : Number(row.reporting_value),
          reportingBasis: row.reporting_basis,
          isEstimated: row.is_estimated,
          totalVotes: 0,
          choices: []
        }
      });
    }
    const properties = features.get(row.geography_id).properties;
    const votes = numberOrZero(row.votes);
    properties.totalVotes += votes;
    properties.choices.push({
      id: row.choice_id,
      candidateId: row.candidate_id,
      ballotName: row.ballot_name,
      party: row.party_name,
      partyAbbreviation: row.party_abbreviation,
      votes
    });
  }
  for (const item of features.values()) {
    item.properties.choices.sort((left, right) => right.votes - left.votes || left.ballotName.localeCompare(right.ballotName));
  }
  return { type: 'FeatureCollection', features: [...features.values()] };
}

function rowsToDistrictFeatureCollection(rows) {
  const features = new Map();
  for (const row of rows) {
    if (!features.has(row.geography_id)) {
      features.set(row.geography_id, {
        type: 'Feature',
        id: row.geography_id,
        geometry: row.geometry,
        properties: {
          geographyId: row.geography_id,
          stateFips: row.state_fips,
          stateAbbreviation: row.state_abbreviation,
          stateName: row.state_name,
          districtCode: row.district_code,
          districtLabel: row.district_label,
          contestId: row.contest_id,
          totalVotes: 0,
          choices: []
        }
      });
    }
    const properties = features.get(row.geography_id).properties;
    if (row.choice_id) {
      const votes = numberOrZero(row.votes);
      properties.totalVotes += votes;
      properties.choices.push({
        id: row.choice_id,
        candidateId: row.candidate_id,
        ballotName: row.ballot_name,
        party: row.party_name,
        partyAbbreviation: row.party_abbreviation,
        votes
      });
    }
  }
  for (const item of features.values()) {
    item.properties.choices.sort((left, right) => right.votes - left.votes || left.ballotName.localeCompare(right.ballotName));
  }
  return { type: 'FeatureCollection', features: [...features.values()] };
}

export const electionHubRepository = {
  async options() {
    const rows = await all(`
      SELECT DISTINCT
        office.slug AS office_slug,
        office.name AS office_name,
        election.cycle,
        election.stage
      FROM contests contest
      JOIN offices office ON office.id = contest.office_id
      JOIN election_events election ON election.id = contest.election_id
      JOIN result_snapshots snapshot ON snapshot.contest_id = contest.id
      WHERE office.slug IN ('president', 'governor', 'us_house', 'us_senate')
      UNION
      SELECT 'president', 'President', cycle, 'general'
      FROM presidential_electoral_states
      ORDER BY office_name, cycle DESC, stage
    `);
    const [{ poll_count: pollCount }] = await all('SELECT COUNT(*)::INTEGER AS poll_count FROM polls');
    const [{ live_count: liveCount }] = await all(`
      SELECT COUNT(*)::INTEGER AS live_count
      FROM result_batches
      WHERE status IN ('unofficial_partial', 'unofficial_complete')
    `);
    const offices = new Map();
    for (const row of rows) {
      if (!offices.has(row.office_slug)) {
        offices.set(row.office_slug, { slug: row.office_slug, name: row.office_name, cycles: [], stages: [] });
      }
      const office = offices.get(row.office_slug);
      if (!office.cycles.includes(row.cycle)) office.cycles.push(row.cycle);
      if (!office.stages.includes(row.stage)) office.stages.push(row.stage);
    }
    return {
      offices: [...offices.values()],
      modes: {
        historical: rows.length > 0,
        polls: pollCount > 0,
        electionNight: liveCount > 0
      }
    };
  },

  async overview({ office, cycle, stage }) {
    const rows = await all(`
      WITH latest AS (${latestSnapshots}),
      ranked_contests AS (
        SELECT
          contest.id,
          ROW_NUMBER() OVER (
            PARTITION BY
              contest.election_id,
              contest.office_id,
              CASE
                WHEN office.slug = 'us_house' AND district.state_fips = '11' THEN 'dc-at-large'
                ELSE contest.district_geography_id::TEXT
              END
            ORDER BY
              latest.reported_at DESC NULLS LAST,
              latest.retrieved_at DESC,
              latest.id DESC
          ) AS recency_rank
        FROM contests contest
        JOIN offices office ON office.id = contest.office_id
        JOIN geographies district ON district.id = contest.district_geography_id
        JOIN latest ON latest.contest_id = contest.id
      ),
      selected_contests AS (
        SELECT id FROM ranked_contests WHERE recency_rank = 1
      )
      SELECT
        contest.id::TEXT AS contest_id,
        contest.name AS contest_name,
        contest.district_label,
        office.slug AS office_slug,
        office.name AS office_name,
        election.cycle,
        election.stage,
        TO_CHAR(election.end_date, 'YYYY-MM-DD') AS election_date,
        state.id::TEXT AS state_id,
        state.name AS state_name,
        state.abbreviation AS state_abbreviation,
        state.state_fips,
        latest.reporting_value,
        latest.reporting_basis,
        latest.reported_units,
        latest.total_units,
        latest.status AS result_status,
        latest.source_name,
        latest.retrieved_at,
        choice.id::TEXT AS choice_id,
        candidate.candidate_id::TEXT AS candidate_id,
        choice.ballot_name,
        party.name AS party_name,
        party.abbreviation AS party_abbreviation,
        total.votes
      FROM contests contest
      JOIN selected_contests selected ON selected.id = contest.id
      JOIN offices office ON office.id = contest.office_id
      JOIN election_events election ON election.id = contest.election_id
      JOIN geographies district ON district.id = contest.district_geography_id
      JOIN geographies state
        ON state.geography_type = 'state'
        AND state.state_fips = district.state_fips
      JOIN latest ON latest.contest_id = contest.id
      LEFT JOIN contest_choices choice ON choice.contest_id = contest.id
      LEFT JOIN parties party ON party.id = choice.party_id
      LEFT JOIN LATERAL (
        SELECT candidate_id
        FROM contest_choice_candidates
        WHERE contest_choice_id = choice.id
        ORDER BY ticket_position
        LIMIT 1
      ) candidate ON TRUE
      LEFT JOIN vote_totals total
        ON total.snapshot_id = latest.id
        AND total.reporting_unit_id = contest.district_geography_id
        AND total.contest_choice_id = choice.id
        AND total.vote_status = 'reported'
        AND total.vote_type = 'total'
        AND total.round = 0
      WHERE office.slug = $1
        AND election.cycle = $2
        AND election.stage = $3
      ORDER BY state.name, contest.district_label NULLS FIRST, total.votes DESC NULLS LAST, choice.ballot_name
    `, [office, cycle, stage]);
    return groupContests(rows);
  },

  async districtResults({ cycle, stage }) {
    const rows = await all(`
      WITH latest AS (${latestSnapshots}),
      ranked_contests AS (
        SELECT
          contest.id,
          contest.district_geography_id,
          ROW_NUMBER() OVER (
            PARTITION BY
              contest.election_id,
              CASE
                WHEN district.state_fips = '11' THEN 'dc-at-large'
                ELSE contest.district_geography_id::TEXT
              END
            ORDER BY
              latest.reported_at DESC NULLS LAST,
              latest.retrieved_at DESC,
              latest.id DESC
          ) AS recency_rank
        FROM contests contest
        JOIN offices office ON office.id = contest.office_id
        JOIN election_events election ON election.id = contest.election_id
        JOIN geographies district ON district.id = contest.district_geography_id
        JOIN latest ON latest.contest_id = contest.id
        WHERE office.slug = 'us_house'
          AND election.cycle = $1
          AND election.stage = $2
      ),
      selected_contests AS (
        SELECT id, district_geography_id
        FROM ranked_contests
        WHERE recency_rank = 1
      ),
      eligible_districts AS (
        SELECT
          district.id,
          district.name,
          district.abbreviation,
          district.state_fips,
          version.geom,
          selected.id AS contest_id,
          ROW_NUMBER() OVER (
            PARTITION BY district.state_fips, district.abbreviation
            ORDER BY (selected.id IS NOT NULL) DESC, district.id
          ) AS geography_rank
        FROM geographies district
        JOIN geography_versions version
          ON version.geography_id = district.id
          AND version.valid_from <= MAKE_DATE($1, 11, 3)
          AND (version.valid_to IS NULL OR version.valid_to >= MAKE_DATE($1, 11, 3))
        LEFT JOIN selected_contests selected ON selected.district_geography_id = district.id
        WHERE district.geography_type = 'congressional_district'
      )
      SELECT
        district.id::TEXT AS geography_id,
        ST_AsGeoJSON(district.geom)::JSON AS geometry,
        district.state_fips,
        state.abbreviation AS state_abbreviation,
        state.name AS state_name,
        CASE
          WHEN district.abbreviation LIKE '%-AL' THEN 'AL'
          ELSE REGEXP_REPLACE(district.abbreviation, '^.*-', '')
        END AS district_code,
        COALESCE(contest.district_label,
          CASE
            WHEN district.abbreviation LIKE '%-AL' THEN 'At-Large'
            ELSE 'District ' || (REGEXP_REPLACE(district.abbreviation, '^.*-', '')::INTEGER)::TEXT
          END
        ) AS district_label,
        contest.id::TEXT AS contest_id,
        choice.id::TEXT AS choice_id,
        candidate.candidate_id::TEXT AS candidate_id,
        choice.ballot_name,
        party.name AS party_name,
        party.abbreviation AS party_abbreviation,
        total.votes
      FROM eligible_districts district
      JOIN geographies state
        ON state.geography_type = 'state' AND state.state_fips = district.state_fips
      LEFT JOIN contests contest ON contest.id = district.contest_id
      LEFT JOIN latest ON latest.contest_id = contest.id
      LEFT JOIN contest_choices choice ON choice.contest_id = contest.id
      LEFT JOIN parties party ON party.id = choice.party_id
      LEFT JOIN LATERAL (
        SELECT candidate_id
        FROM contest_choice_candidates
        WHERE contest_choice_id = choice.id
        ORDER BY ticket_position
        LIMIT 1
      ) candidate ON TRUE
      LEFT JOIN vote_totals total
        ON total.snapshot_id = latest.id
        AND total.reporting_unit_id = contest.district_geography_id
        AND total.contest_choice_id = choice.id
        AND total.vote_status = 'reported'
        AND total.vote_type = 'total'
        AND total.round = 0
      WHERE district.geography_rank = 1
      ORDER BY state.name, district_code, total.votes DESC NULLS LAST, choice.ballot_name
    `, [cycle, stage]);
    return rowsToDistrictFeatureCollection(rows);
  },

  async geographicResults({ contestId, level }) {
    const rows = level === 'county'
      ? await all(`
          WITH latest AS (${latestSnapshots}),
          contest_info AS (
            SELECT
              contest.id,
              election.end_date AS election_date,
              district.state_fips,
              latest.id AS snapshot_id,
              latest.reporting_value,
              latest.reporting_basis
            FROM contests contest
            JOIN election_events election ON election.id = contest.election_id
            JOIN geographies district ON district.id = contest.district_geography_id
            JOIN latest ON latest.contest_id = contest.id
            WHERE contest.id = $1::UUID
          ),
          county_choices AS (
            SELECT
              county.id AS geography_id,
              county.name AS geography_name,
              county.abbreviation AS geography_abbreviation,
              county.state_fips || county.county_fips AS geography_fips,
              ST_AsGeoJSON(version.geom)::JSON AS geometry,
              info.reporting_value,
              info.reporting_basis,
              choice.id AS choice_id,
              candidate.candidate_id,
              choice.ballot_name,
              party.name AS party_name,
              party.abbreviation AS party_abbreviation,
              SUM(total.votes)::BIGINT AS votes,
              BOOL_OR(total.is_estimated) AS is_estimated
            FROM contest_info info
            JOIN geographies county
              ON county.geography_type IN ('county', 'county_equivalent')
              AND county.state_fips = info.state_fips
            JOIN geography_versions version
              ON version.geography_id = county.id
              AND version.valid_from <= info.election_date
              AND (version.valid_to IS NULL OR version.valid_to >= info.election_date)
            JOIN LATERAL (
              SELECT direct.contest_choice_id, direct.votes, direct.is_estimated
              FROM vote_totals direct
              WHERE direct.snapshot_id = info.snapshot_id
                AND direct.reporting_unit_id = county.id
                AND direct.vote_status = 'reported'
                AND direct.vote_type = 'total'
                AND direct.round = 0
              UNION ALL
              SELECT derived.contest_choice_id, derived.votes, derived.is_estimated
              FROM geography_relationships relationship
              JOIN vote_totals derived
                ON derived.snapshot_id = info.snapshot_id
                AND derived.reporting_unit_id = relationship.child_geography_id
                AND derived.vote_status = 'reported'
                AND derived.vote_type = 'total'
                AND derived.round = 0
              WHERE relationship.parent_geography_id = county.id
                AND relationship.relationship_type = 'contains'
                AND relationship.valid_from <= info.election_date
                AND (relationship.valid_to IS NULL OR relationship.valid_to >= info.election_date)
                AND NOT EXISTS (
                  SELECT 1
                  FROM vote_totals direct_exists
                  WHERE direct_exists.snapshot_id = info.snapshot_id
                    AND direct_exists.reporting_unit_id = county.id
                    AND direct_exists.vote_status = 'reported'
                    AND direct_exists.vote_type = 'total'
                    AND direct_exists.round = 0
                )
            ) total ON TRUE
            JOIN contest_choices choice ON choice.id = total.contest_choice_id
            LEFT JOIN parties party ON party.id = choice.party_id
            LEFT JOIN LATERAL (
              SELECT candidate_id
              FROM contest_choice_candidates
              WHERE contest_choice_id = choice.id
              ORDER BY ticket_position
              LIMIT 1
            ) candidate ON TRUE
            GROUP BY
              county.id, county.name, county.abbreviation, county.state_fips, county.county_fips,
              version.geom, info.reporting_value, info.reporting_basis,
              choice.id, candidate.candidate_id, choice.ballot_name, party.name, party.abbreviation
          )
          SELECT
            geography_id::TEXT,
            geography_name,
            geography_abbreviation,
            geography_fips,
            geometry,
            reporting_value,
            reporting_basis,
            choice_id::TEXT,
            candidate_id::TEXT,
            ballot_name,
            party_name,
            party_abbreviation,
            votes,
            is_estimated
          FROM county_choices
          ORDER BY geography_name, votes DESC, ballot_name
        `, [contestId])
      : await all(`
          WITH latest AS (${latestSnapshots}),
          contest_info AS (
            SELECT
              contest.id,
              election.end_date AS election_date,
              district.state_fips,
              latest.id AS snapshot_id,
              latest.reporting_value,
              latest.reporting_basis
            FROM contests contest
            JOIN election_events election ON election.id = contest.election_id
            JOIN geographies district ON district.id = contest.district_geography_id
            JOIN latest ON latest.contest_id = contest.id
            WHERE contest.id = $1::UUID
          )
          SELECT
            precinct.id::TEXT AS geography_id,
            precinct.name AS geography_name,
            precinct.abbreviation AS geography_abbreviation,
            precinct.state_fips || COALESCE(precinct.county_fips, '') || precinct.abbreviation AS geography_fips,
            ST_AsGeoJSON(version.geom)::JSON AS geometry,
            info.reporting_value,
            info.reporting_basis,
            choice.id::TEXT AS choice_id,
            candidate.candidate_id::TEXT AS candidate_id,
            choice.ballot_name,
            party.name AS party_name,
            party.abbreviation AS party_abbreviation,
            total.votes,
            total.is_estimated
          FROM contest_info info
          JOIN geographies precinct
            ON precinct.geography_type = 'precinct'
            AND precinct.state_fips = info.state_fips
          JOIN geography_versions version
            ON version.geography_id = precinct.id
            AND version.valid_from <= info.election_date
            AND (version.valid_to IS NULL OR version.valid_to >= info.election_date)
          JOIN vote_totals total
            ON total.snapshot_id = info.snapshot_id
            AND total.reporting_unit_id = precinct.id
            AND total.vote_status = 'reported'
            AND total.vote_type = 'total'
            AND total.round = 0
          JOIN contest_choices choice ON choice.id = total.contest_choice_id
          LEFT JOIN parties party ON party.id = choice.party_id
          LEFT JOIN LATERAL (
            SELECT candidate_id
            FROM contest_choice_candidates
            WHERE contest_choice_id = choice.id
            ORDER BY ticket_position
            LIMIT 1
          ) candidate ON TRUE
          ORDER BY precinct.name, total.votes DESC, choice.ballot_name
        `, [contestId]);
    return rowsToFeatureCollection(rows, level);
  }
};
