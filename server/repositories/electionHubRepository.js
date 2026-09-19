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
      ORDER BY office.name, election.cycle DESC, election.stage
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
      WITH latest AS (${latestSnapshots})
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
            JOIN geography_relationships relationship
              ON relationship.parent_geography_id = county.id
              AND relationship.relationship_type = 'contains'
              AND relationship.valid_from <= info.election_date
              AND (relationship.valid_to IS NULL OR relationship.valid_to >= info.election_date)
            JOIN vote_totals total
              ON total.snapshot_id = info.snapshot_id
              AND total.reporting_unit_id = relationship.child_geography_id
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
