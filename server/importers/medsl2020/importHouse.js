import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { db } from '../../db.js';
import { candidateUuid } from '../../identity/candidateUuid.js';

const parserName = 'medsl-2020-house';
const parserVersion = '1.0.0';
const namespace = 'medsl:2020:house';
const electionDate = '2020-11-03';
const countyAggregationMethod = 'Summed from MEDSL precinct rows after combining voting modes and candidate fusion-party lines.';

async function row(client, sql, params = []) {
  const result = await client.query(sql, params);
  if (result.rows.length !== 1) throw new Error(`Expected one database row; received ${result.rows.length}`);
  return result.rows[0];
}

async function sourceId(client) {
  return (await row(client, "SELECT id FROM data_sources WHERE slug = 'medsl'")).id;
}

async function linkSourceId(client, table, entityColumn, entityId, source, sourceIdentifier) {
  const allowed = new Map([
    ['geography_source_ids', 'geography_id'],
    ['candidate_source_ids', 'candidate_id'],
    ['election_source_ids', 'election_id'],
    ['contest_source_ids', 'contest_id'],
    ['contest_choice_source_ids', 'contest_choice_id']
  ]);
  if (allowed.get(table) !== entityColumn) throw new Error(`Unsupported source-ID table: ${table}`);
  const linked = await client.query(`
    INSERT INTO ${table} (${entityColumn}, source_id, identifier_namespace, source_identifier)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (source_id, identifier_namespace, source_identifier) DO NOTHING
    RETURNING ${entityColumn}
  `, [entityId, source, namespace, sourceIdentifier]);
  if (linked.rows.length) return;
  const existing = await row(client, `
    SELECT ${entityColumn}
    FROM ${table}
    WHERE source_id = $1 AND identifier_namespace = $2 AND source_identifier = $3
  `, [source, namespace, sourceIdentifier]);
  if (String(existing[entityColumn]) !== String(entityId)) {
    throw new Error(`${table} identifier ${sourceIdentifier} is already mapped to another entity`);
  }
}

async function ensureArtifact(client, source, archive) {
  const existing = await client.query(`
    SELECT id FROM source_artifacts WHERE source_id = $1 AND sha256 = $2
  `, [source, archive.sha256]);
  if (existing.rows.length) return existing.rows[0].id;
  return (await row(client, `
    INSERT INTO source_artifacts (
      source_id, uri, retrieved_at, sha256, byte_size, content_type,
      source_version, metadata
    ) VALUES ($1, $2, $3, $4, $5, 'application/zip', '2020 general', $6::JSONB)
    RETURNING id
  `, [
    source,
    pathToFileURL(archive.resolvedPath).href,
    archive.retrievedAt,
    archive.sha256,
    archive.byteSize,
    JSON.stringify({
      filename: 'us_house_2020.zip',
      dataFile: 'HOUSE_precinct_general.csv',
      csvByteSize: archive.csvByteSize
    })
  ])).id;
}

async function ensureElection(client, source, state, stateGeographyId) {
  const existing = await client.query(`
    SELECT id
    FROM election_events
    WHERE scope_geography_id = $1 AND cycle = 2020 AND stage = 'general'
      AND end_date = $2
    ORDER BY id
    LIMIT 1
  `, [stateGeographyId, electionDate]);
  const electionId = existing.rows[0]?.id || (await row(client, `
    INSERT INTO election_events (
      name, cycle, stage, start_date, end_date, scope_geography_id, metadata
    ) VALUES ($1, 2020, 'general', $2, $2, $3, $4::JSONB)
    RETURNING id
  `, [
    `2020 ${state.name} General Election`,
    electionDate,
    stateGeographyId,
    JSON.stringify({
      source: 'MEDSL 2020 official precinct returns',
      sourceMarksSpecial: parsedContest.special
    })
  ])).id;
  await linkSourceId(client, 'election_source_ids', 'election_id', electionId, source,
    `2020-general:${state.abbreviation}`);
  return electionId;
}

async function ensureDistrict(client, source, state, stateGeographyId, contest) {
  const name = contest.district === 'AL'
    ? `${state.name} Congressional District At-Large`
    : `${state.name} Congressional District ${Number(contest.district)}`;
  const abbreviation = contest.district === 'AL'
    ? `${state.abbreviation}-AL`
    : `${state.abbreviation}-${contest.district}`;
  const district = await row(client, `
    INSERT INTO geographies (
      geography_type, name, abbreviation, state_fips, metadata
    ) VALUES ('congressional_district', $1, $2, $3, $4::JSONB)
    ON CONFLICT (geography_type, state_fips, county_fips, name) DO UPDATE SET
      abbreviation = EXCLUDED.abbreviation,
      metadata = geographies.metadata || EXCLUDED.metadata
    RETURNING id
  `, [
    name,
    abbreviation,
    state.stateFips,
    JSON.stringify({ districtLabel: contest.districtLabel })
  ]);
  await linkSourceId(client, 'geography_source_ids', 'geography_id', district.id, source,
    `${state.abbreviation}:congressional-district:${contest.district}`);
  await client.query(`
    INSERT INTO geography_relationships (
      parent_geography_id, child_geography_id, relationship_type, valid_from, valid_to
    ) VALUES ($1, $2, 'contains', $3, $3)
    ON CONFLICT (parent_geography_id, child_geography_id, relationship_type, valid_from)
    DO UPDATE SET valid_to = EXCLUDED.valid_to
  `, [stateGeographyId, district.id, electionDate]);
  return district.id;
}

async function ensureContest(client, source, electionId, officeId, districtId, parsedContest) {
  const existing = await client.query(`
    SELECT id, name, district_label
    FROM contests
    WHERE election_id = $1 AND office_id = $2 AND district_geography_id = $3
    ORDER BY id
  `, [electionId, officeId, districtId]);
  let preferredExisting = existing.rows[0];
  if (existing.rows.length > 1) {
    preferredExisting = parsedContest.sourceIdentifier === 'DC:AL'
      ? existing.rows.find(item => /delegate/i.test(`${item.name} ${item.district_label || ''}`))
      : null;
    if (!preferredExisting) {
      throw new Error(`${parsedContest.sourceIdentifier} maps to multiple existing contests`);
    }
  }
  const contestId = preferredExisting?.id || (await row(client, `
    INSERT INTO contests (
      election_id, office_id, district_geography_id, name, district_label,
      contest_type, vote_variation, number_elected, votes_allowed, metadata
    ) VALUES ($1, $2, $3, $4, $5, 'candidate', 'plurality', $6, $6, $7::JSONB)
    RETURNING id
  `, [
    electionId,
    officeId,
    districtId,
    parsedContest.name,
    parsedContest.districtLabel,
    parsedContest.magnitude,
    JSON.stringify({ source: 'MEDSL 2020 official precinct returns' })
  ])).id;
  await linkSourceId(client, 'contest_source_ids', 'contest_id', contestId, source,
    parsedContest.sourceIdentifier);
  return contestId;
}

async function ensureParty(client, party) {
  if (!party) return null;
  return (await row(client, `
    INSERT INTO parties (name, abbreviation)
    VALUES ($1, $2)
    ON CONFLICT (name) DO UPDATE SET abbreviation = COALESCE(parties.abbreviation, EXCLUDED.abbreviation)
    RETURNING id
  `, [party.name, party.abbreviation])).id;
}

async function ensureCandidate(client, source, state, contest, choice) {
  if (!choice.candidateSlug) return null;
  const canonicalKey = `${choice.candidateSlug}-${state.abbreviation.toLowerCase()}`;
  const expectedId = candidateUuid(canonicalKey);
  const candidate = await row(client, `
    INSERT INTO candidates (id, canonical_key, canonical_name, metadata)
    VALUES ($1, $2, $3, $4::JSONB)
    ON CONFLICT (canonical_key) DO UPDATE SET canonical_name = candidates.canonical_name
    RETURNING id
  `, [
    expectedId,
    canonicalKey,
    choice.canonicalName,
    JSON.stringify({ identityResolution: 'state-scoped normalized MEDSL candidate identity' })
  ]);
  if (candidate.id !== expectedId) {
    throw new Error(`Candidate ${canonicalKey} has noncanonical UUID ${candidate.id}; expected ${expectedId}`);
  }
  await linkSourceId(client, 'candidate_source_ids', 'candidate_id', candidate.id, source,
    `${contest.sourceIdentifier}:${choice.sourceIdentifier}`);
  return candidate.id;
}

async function ensureChoice(client, source, officeId, state, contestId, parsedContest, choice) {
  const partyId = await ensureParty(client, choice.party);
  const candidateId = await ensureCandidate(client, source, state, parsedContest, choice);
  let choiceId;
  if (candidateId) {
    const existing = await client.query(`
      SELECT candidate_choice.contest_choice_id AS id
      FROM contest_choice_candidates candidate_choice
      JOIN contest_choices contest_choice ON contest_choice.id = candidate_choice.contest_choice_id
      WHERE contest_choice.contest_id = $1 AND candidate_choice.candidate_id = $2
      ORDER BY candidate_choice.ticket_position
      LIMIT 1
    `, [contestId, candidateId]);
    choiceId = existing.rows[0]?.id;
  }
  if (!choiceId) {
    choiceId = (await row(client, `
      INSERT INTO contest_choices (
        contest_id, ballot_name, choice_type, party_id, is_write_in, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6::JSONB)
      ON CONFLICT (contest_id, ballot_name, party_id) DO UPDATE SET
        is_write_in = contest_choices.is_write_in OR EXCLUDED.is_write_in,
        metadata = contest_choices.metadata || EXCLUDED.metadata
      RETURNING id
    `, [
      contestId,
      choice.ballotName,
      choice.choiceType,
      partyId,
      choice.isWriteIn,
      JSON.stringify({ medslChoice: choice.sourceIdentifier })
    ])).id;
    if (candidateId) {
      await client.query(`
        INSERT INTO contest_choice_candidates (contest_choice_id, candidate_id, office_id)
        VALUES ($1, $2, $3)
        ON CONFLICT DO NOTHING
      `, [choiceId, candidateId, officeId]);
    }
  }
  await linkSourceId(client, 'contest_choice_source_ids', 'contest_choice_id', choiceId, source,
    `${parsedContest.sourceIdentifier}:${choice.sourceIdentifier}`);
  return choiceId;
}

async function countyMap(client, stateFips) {
  const result = await client.query(`
    SELECT id, county_fips
    FROM geographies
    WHERE geography_type IN ('county', 'county_equivalent') AND state_fips = $1
  `, [stateFips]);
  return new Map(result.rows.map(item => [item.county_fips, item.id]));
}

export async function importHouseResults({ archive, parsed, commit = false, onProgress }) {
  const client = await db.connect();
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  try {
    await client.query('BEGIN');
    const source = await sourceId(client);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['medsl:2020:house:import']);
    const artifactId = await ensureArtifact(client, source, archive);
    const existingBatch = await client.query(`
      SELECT id FROM result_batches WHERE source_id = $1 AND source_artifact_id = $2 LIMIT 1
    `, [source, artifactId]);
    if (existingBatch.rows.length) {
      await client.query('ROLLBACK');
      return { alreadyImported: true, batchId: String(existingBatch.rows[0].id) };
    }
    await client.query(`
      INSERT INTO ingestion_runs (
        id, source_id, source_artifact_id, started_at, status, rows_read,
        parser_name, parser_version, metadata
      ) VALUES ($1, $2, $3, $4, 'running', $5, $6, $7, $8::JSONB)
    `, [
      runId,
      source,
      artifactId,
      startedAt,
      parsed.rowsRead,
      parserName,
      parserVersion,
      JSON.stringify({ dryRun: !commit, archive: 'us_house_2020.zip' })
    ]);
    const batch = await row(client, `
      INSERT INTO result_batches (
        source_id, source_artifact_id, ingestion_run_id, reported_at,
        retrieved_at, status, metadata
      ) VALUES ($1, $2, $3, NULL, $4, 'research_dataset', $5::JSONB)
      RETURNING id
    `, [
      source,
      artifactId,
      runId,
      archive.retrievedAt,
      JSON.stringify({ electionDate, scope: 'U.S. House', rowsRead: parsed.rowsRead })
    ]);
    const officeId = (await row(client, "SELECT id FROM offices WHERE slug = 'us_house'")).id;
    let contestsStored = 0;
    let choicesStored = 0;
    let voteTotalsStored = 0;
    let missingCountyRows = 0;

    for (const [stateIndex, state] of parsed.states.entries()) {
      const stateGeography = await row(client, `
        SELECT id FROM geographies WHERE geography_type = 'state' AND state_fips = $1
      `, [state.stateFips]);
      const electionId = await ensureElection(client, source, state, stateGeography.id);
      const counties = await countyMap(client, state.stateFips);
      for (const parsedContest of state.contests) {
        const districtId = await ensureDistrict(client, source, state, stateGeography.id, parsedContest);
        const contestId = await ensureContest(client, source, electionId, officeId, districtId, parsedContest);
        const choices = new Map();
        for (const choice of parsedContest.choices) {
          const choiceId = await ensureChoice(
            client, source, officeId, state, contestId, parsedContest, choice
          );
          choices.set(choice.sourceIdentifier, choiceId);
        }
        const snapshot = await row(client, `
          INSERT INTO result_snapshots (
            batch_id, contest_id, reporting_basis, reporting_value,
            reported_units, total_units, metadata
          ) VALUES ($1, $2, 'precincts', 100, $3, $3, $4::JSONB)
          RETURNING id
        `, [
          batch.id,
          contestId,
          parsedContest.precincts.size,
          JSON.stringify({ sourceCompleteness: 'MEDSL 2020 House general-election archive' })
        ]);

        const summaryChoiceIds = [];
        const summaryVotes = [];
        for (const choice of parsedContest.choices) {
          summaryChoiceIds.push(choices.get(choice.sourceIdentifier));
          summaryVotes.push(choice.votes);
        }
        await client.query(`
          INSERT INTO vote_totals (
            snapshot_id, reporting_unit_id, contest_choice_id, vote_type, round,
            votes, is_estimated, tabulation_method, allocation_method, vote_status, metadata
          )
          SELECT $1, $2, values.choice_id, 'total', 0, values.votes, FALSE,
            'sum_of_reporting_units', $5, 'reported', '{}'::JSONB
          FROM UNNEST($3::UUID[], $4::BIGINT[]) AS values(choice_id, votes)
        `, [snapshot.id, districtId, summaryChoiceIds, summaryVotes, countyAggregationMethod]);
        voteTotalsStored += summaryVotes.length;

        const countyIds = [];
        const countyChoiceIds = [];
        const countyVotes = [];
        const statusCountyIds = [];
        const statusPrecinctCounts = [];
        for (const county of parsedContest.counties) {
          const countyId = counties.get(county.countyFips);
          if (!countyId) {
            missingCountyRows += [...county.votes.values()].length;
            continue;
          }
          statusCountyIds.push(countyId);
          statusPrecinctCounts.push(county.precincts.size);
          for (const [choiceKey, votes] of county.votes) {
            const choiceId = choices.get(choiceKey);
            if (!choiceId) throw new Error(`Missing choice ${choiceKey} for ${parsedContest.sourceIdentifier}`);
            countyIds.push(countyId);
            countyChoiceIds.push(choiceId);
            countyVotes.push(votes);
          }
        }
        if (countyVotes.length) {
          await client.query(`
            INSERT INTO vote_totals (
              snapshot_id, reporting_unit_id, contest_choice_id, vote_type, round,
              votes, is_estimated, tabulation_method, allocation_method, vote_status, metadata
            )
            SELECT $1, values.county_id, values.choice_id, 'total', 0, values.votes,
              FALSE, 'sum_of_reporting_units', $5, 'reported', $6::JSONB
            FROM UNNEST($2::UUID[], $3::UUID[], $4::BIGINT[])
              AS values(county_id, choice_id, votes)
          `, [
            snapshot.id,
            countyIds,
            countyChoiceIds,
            countyVotes,
            countyAggregationMethod,
            JSON.stringify({ sourceLevel: 'precinct', groupedBy: 'county' })
          ]);
          await client.query(`
            INSERT INTO reporting_unit_statuses (
              snapshot_id, reporting_unit_id, vote_type, count_status,
              reporting_basis, reporting_value, reported_subunits, total_subunits, metadata
            )
            SELECT $1, values.county_id, 'total', 'complete', 'precincts', 100,
              values.precinct_count, values.precinct_count, '{}'::JSONB
            FROM UNNEST($2::UUID[], $3::INTEGER[]) AS values(county_id, precinct_count)
          `, [snapshot.id, statusCountyIds, statusPrecinctCounts]);
          voteTotalsStored += countyVotes.length;
        }
        contestsStored += 1;
        choicesStored += parsedContest.choices.length;
      }
      onProgress?.(
        `[${stateIndex + 1}/${parsed.states.length}] ${state.abbreviation}: ${state.contests.length} contests stored`
      );
    }

    const warningCount = parsed.suppressedRows + parsed.invalidCountyRows + missingCountyRows;
    await client.query(`
      UPDATE ingestion_runs
      SET completed_at = NOW(),
          status = CASE WHEN $3 > 0 THEN 'completed_with_warnings' ELSE 'completed' END,
          rows_added = $2,
          warning_count = $3,
          message = $4,
          metadata = metadata || $5::JSONB
      WHERE id = $1
    `, [
      runId,
      voteTotalsStored,
      warningCount,
      `Imported 2020 U.S. House results: ${contestsStored} contests and ${voteTotalsStored} vote totals.`,
      JSON.stringify({
        contests: contestsStored,
        choices: choicesStored,
        suppressedRows: parsed.suppressedRows,
        invalidCountyRows: parsed.invalidCountyRows,
        missingCountyRows,
        statisticRowsExcluded: parsed.excludedStatisticRows
      })
    ]);

    const result = {
      alreadyImported: false,
      batchId: String(batch.id),
      states: parsed.states.length,
      contests: contestsStored,
      choices: choicesStored,
      voteTotals: voteTotalsStored,
      warnings: warningCount,
      suppressedRows: parsed.suppressedRows,
      invalidCountyRows: parsed.invalidCountyRows,
      missingCountyRows
    };
    if (commit) await client.query('COMMIT');
    else await client.query('ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
