import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { db } from '../../db.js';
import { candidateUuid } from '../../identity/candidateUuid.js';

const parserName = 'medsl-2024-federal-governor';
const parserVersion = '1.0.0';
const namespace = 'medsl:2024:general';
const aggregationMethod = 'Summed from MEDSL precinct rows after preferring source TOTAL modes within each county/contest and combining candidate fusion-party lines.';

async function row(client, sql, params = []) {
  const result = await client.query(sql, params);
  if (result.rows.length !== 1) throw new Error(`Expected one database row; received ${result.rows.length}`);
  return result.rows[0];
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

async function ensureArtifact(client, source, archive, state) {
  const existing = await client.query(
    'SELECT id FROM source_artifacts WHERE source_id = $1 AND sha256 = $2',
    [source, archive.sha256]
  );
  if (existing.rows.length) return existing.rows[0].id;
  return (await row(client, `
    INSERT INTO source_artifacts (
      source_id, uri, retrieved_at, sha256, byte_size, content_type,
      source_version, metadata
    ) VALUES ($1, $2, $3, $4, $5, 'application/zip', '2024 general', $6::JSONB)
    RETURNING id
  `, [
    source,
    pathToFileURL(archive.resolvedPath).href,
    archive.retrievedAt,
    archive.sha256,
    archive.byteSize,
    JSON.stringify({
      filename: archive.filename,
      dataFile: archive.csvPath,
      csvByteSize: archive.csvByteSize,
      state: state.abbreviation,
      officialRepository: 'https://github.com/MEDSL/2024-elections-official'
    })
  ])).id;
}

async function ensureElection(client, source, state, stateGeographyId) {
  const existing = await client.query(`
    SELECT id FROM election_events
    WHERE scope_geography_id = $1 AND cycle = 2024 AND stage = 'general'
      AND end_date = $2
    ORDER BY id LIMIT 1
  `, [stateGeographyId, state.date]);
  const electionId = existing.rows[0]?.id || (await row(client, `
    INSERT INTO election_events (
      name, cycle, stage, start_date, end_date, scope_geography_id, metadata
    ) VALUES ($1, 2024, 'general', $2, $2, $3, $4::JSONB)
    RETURNING id
  `, [
    `2024 ${state.name} General Election`,
    state.date,
    stateGeographyId,
    JSON.stringify({ source: 'MEDSL 2024 official precinct returns' })
  ])).id;
  await linkSourceId(
    client, 'election_source_ids', 'election_id', electionId, source,
    `2024-general:${state.abbreviation}`
  );
  return electionId;
}

async function ensureDistrict(client, source, state, stateGeographyId, contest) {
  if (contest.officeSlug !== 'us_house') return stateGeographyId;
  const abbreviation = contest.district === 'AL'
    ? `${state.abbreviation}-AL`
    : `${state.abbreviation}-${contest.district}`;
  const name = contest.district === 'AL'
    ? `${state.name} Congressional District At-Large`
    : `${state.name} Congressional District ${Number(contest.district)}`;
  let result = await client.query(`
    SELECT id FROM geographies
    WHERE geography_type = 'congressional_district'
      AND state_fips = $1 AND abbreviation = $2
    ORDER BY id LIMIT 1
  `, [state.stateFips, abbreviation]);
  const districtId = result.rows[0]?.id || (await row(client, `
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
  ])).id;
  await linkSourceId(
    client, 'geography_source_ids', 'geography_id', districtId, source,
    `${state.abbreviation}:congressional-district:${contest.district}`
  );
  await client.query(`
    INSERT INTO geography_relationships (
      parent_geography_id, child_geography_id, relationship_type, valid_from, valid_to
    ) VALUES ($1, $2, 'contains', $3, $3)
    ON CONFLICT (parent_geography_id, child_geography_id, relationship_type, valid_from)
    DO UPDATE SET valid_to = EXCLUDED.valid_to
  `, [stateGeographyId, districtId, state.date]);
  return districtId;
}

async function ensureContest(client, source, electionId, officeId, districtId, contest) {
  const contestId = (await row(client, `
    INSERT INTO contests (
      election_id, office_id, district_geography_id, name, district_label,
      contest_type, vote_variation, number_elected, votes_allowed, metadata
    ) VALUES ($1, $2, $3, $4, $5, 'candidate', 'plurality', $6, $6, $7::JSONB)
    ON CONFLICT (election_id, name, district_geography_id, primary_party_id) DO UPDATE SET
      office_id = COALESCE(contests.office_id, EXCLUDED.office_id),
      district_label = COALESCE(contests.district_label, EXCLUDED.district_label),
      metadata = contests.metadata || EXCLUDED.metadata
    RETURNING id
  `, [
    electionId,
    officeId,
    districtId,
    contest.name,
    contest.districtLabel,
    contest.magnitude,
    JSON.stringify({ source: 'MEDSL 2024 official precinct returns', special: contest.special })
  ])).id;
  await linkSourceId(
    client, 'contest_source_ids', 'contest_id', contestId, source, contest.sourceIdentifier
  );
  return contestId;
}

async function ensureParty(client, party) {
  if (!party) return null;
  return (await row(client, `
    INSERT INTO parties (name, abbreviation)
    VALUES ($1, $2)
    ON CONFLICT (name) DO UPDATE SET
      abbreviation = COALESCE(parties.abbreviation, EXCLUDED.abbreviation)
    RETURNING id
  `, [party.name, party.abbreviation])).id;
}

async function ensureCandidate(client, source, state, contest, choice) {
  if (!choice.candidateSlug) return null;
  const presidential = contest.officeSlug === 'president';
  const canonicalKey = presidential
    ? choice.candidateSlug
    : `${choice.candidateSlug}-${state.abbreviation.toLowerCase()}`;
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
    JSON.stringify({
      identityResolution: presidential
        ? 'national normalized presidential candidate identity'
        : 'state-scoped normalized MEDSL candidate identity'
    })
  ]);
  if (candidate.id !== expectedId) {
    throw new Error(`Candidate ${canonicalKey} has noncanonical UUID ${candidate.id}; expected ${expectedId}`);
  }
  await linkSourceId(
    client, 'candidate_source_ids', 'candidate_id', candidate.id, source,
    `${contest.sourceIdentifier}:${choice.sourceIdentifier}`
  );
  return candidate.id;
}

async function ensureChoice(client, source, officeId, state, contestId, contest, choice) {
  const partyId = await ensureParty(client, choice.party);
  const candidateId = await ensureCandidate(client, source, state, contest, choice);
  let choiceId;
  if (candidateId) {
    const existing = await client.query(`
      SELECT candidate_choice.contest_choice_id AS id
      FROM contest_choice_candidates candidate_choice
      JOIN contest_choices contest_choice ON contest_choice.id = candidate_choice.contest_choice_id
      WHERE contest_choice.contest_id = $1 AND candidate_choice.candidate_id = $2
      ORDER BY candidate_choice.ticket_position LIMIT 1
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
  await linkSourceId(
    client, 'contest_choice_source_ids', 'contest_choice_id', choiceId, source,
    `${contest.sourceIdentifier}:${choice.sourceIdentifier}`
  );
  return choiceId;
}

async function countyMap(client, stateFips) {
  const result = await client.query(`
    SELECT id, county_fips FROM geographies
    WHERE geography_type IN ('county', 'county_equivalent') AND state_fips = $1
  `, [stateFips]);
  return new Map(result.rows.map(item => [item.county_fips, item.id]));
}

async function storeState(client, source, runId, archive, state, officeIds) {
  const artifactId = await ensureArtifact(client, source, archive, state);
  const existingBatch = await client.query(`
    SELECT id FROM result_batches
    WHERE source_id = $1 AND source_artifact_id = $2 LIMIT 1
  `, [source, artifactId]);
  if (existingBatch.rows.length) {
    return { skipped: true, batchId: String(existingBatch.rows[0].id), state: state.abbreviation };
  }
  const stateGeography = await row(client, `
    SELECT id FROM geographies WHERE geography_type = 'state' AND state_fips = $1
  `, [state.stateFips]);
  const electionId = await ensureElection(client, source, state, stateGeography.id);
  const counties = await countyMap(client, state.stateFips);
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
    JSON.stringify({ electionDate: state.date, state: state.abbreviation, rowsRead: state.rowsRead })
  ]);
  let contestsStored = 0;
  let choicesStored = 0;
  let voteTotalsStored = 0;
  let missingCountyRows = 0;
  let invalidAggregateTotals = 0;

  for (const contest of state.contests) {
    const officeId = officeIds.get(contest.officeSlug);
    if (!officeId) throw new Error(`Missing office ${contest.officeSlug}`);
    const districtId = await ensureDistrict(client, source, state, stateGeography.id, contest);
    const contestId = await ensureContest(client, source, electionId, officeId, districtId, contest);
    const choiceIds = new Map();
    for (const choice of contest.choices) {
      choiceIds.set(
        choice.sourceIdentifier,
        await ensureChoice(client, source, officeId, state, contestId, contest, choice)
      );
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
      contest.precincts.size,
      JSON.stringify({
        sourceCompleteness: 'MEDSL 2024 official general-election state archive',
        suppressedRows: contest.choices.reduce((sum, choice) => sum + choice.suppressedRows, 0)
      })
    ]);

    const summaryChoiceIds = [];
    const summaryVotes = [];
    const summaryMetadata = [];
    for (const choice of contest.choices) {
      if (choice.votes < 0) {
        invalidAggregateTotals += 1;
        continue;
      }
      summaryChoiceIds.push(choiceIds.get(choice.sourceIdentifier));
      summaryVotes.push(choice.votes);
      summaryMetadata.push(JSON.stringify({
        reportedRows: choice.reportedRows,
        suppressedRows: choice.suppressedRows,
        reconciliationSource: choice.summarySource || null
      }));
    }
    if (summaryVotes.length) {
      await client.query(`
        INSERT INTO vote_totals (
          snapshot_id, reporting_unit_id, contest_choice_id, vote_type, round,
          votes, is_estimated, tabulation_method, allocation_method, vote_status, metadata
        )
        SELECT $1, $2, values.choice_id, 'total', 0, values.votes, FALSE,
          'sum_of_reporting_units', $6, 'reported', values.metadata::JSONB
        FROM UNNEST($3::UUID[], $4::BIGINT[], $5::TEXT[])
          AS values(choice_id, votes, metadata)
      `, [snapshot.id, districtId, summaryChoiceIds, summaryVotes, summaryMetadata, aggregationMethod]);
      voteTotalsStored += summaryVotes.length;
    }

    const countyIds = [];
    const countyChoiceIds = [];
    const countyVotes = [];
    const countyMetadata = [];
    const statusCountyIds = [];
    const statusPrecinctCounts = [];
    for (const county of contest.counties) {
      const countyId = counties.get(county.countyFips);
      if (!countyId) {
        missingCountyRows += county.votes.size;
        continue;
      }
      statusCountyIds.push(countyId);
      statusPrecinctCounts.push(county.precincts.size);
      for (const [choiceKey, total] of county.votes) {
        if (total.votes < 0) {
          invalidAggregateTotals += 1;
          continue;
        }
        const choiceId = choiceIds.get(choiceKey);
        if (!choiceId) throw new Error(`Missing choice ${choiceKey} for ${contest.sourceIdentifier}`);
        countyIds.push(countyId);
        countyChoiceIds.push(choiceId);
        countyVotes.push(total.votes);
        countyMetadata.push(JSON.stringify({
          sourceLevel: 'precinct',
          groupedBy: 'county',
          reportedRows: total.reportedRows,
          suppressedRows: total.suppressedRows,
          reconciliationSource: total.summarySource || null
        }));
      }
    }
    if (countyVotes.length) {
      await client.query(`
        INSERT INTO vote_totals (
          snapshot_id, reporting_unit_id, contest_choice_id, vote_type, round,
          votes, is_estimated, tabulation_method, allocation_method, vote_status, metadata
        )
        SELECT $1, values.county_id, values.choice_id, 'total', 0, values.votes,
          FALSE, 'sum_of_reporting_units', $6, 'reported', values.metadata::JSONB
        FROM UNNEST($2::UUID[], $3::UUID[], $4::BIGINT[], $5::TEXT[])
          AS values(county_id, choice_id, votes, metadata)
      `, [snapshot.id, countyIds, countyChoiceIds, countyVotes, countyMetadata, aggregationMethod]);
      voteTotalsStored += countyVotes.length;
    }
    if (statusCountyIds.length) {
      await client.query(`
        INSERT INTO reporting_unit_statuses (
          snapshot_id, reporting_unit_id, vote_type, count_status,
          reporting_basis, reporting_value, reported_subunits, total_subunits, metadata
        )
        SELECT $1, values.county_id, 'total', 'complete', 'precincts', 100,
          values.precinct_count, values.precinct_count, '{}'::JSONB
        FROM UNNEST($2::UUID[], $3::INTEGER[]) AS values(county_id, precinct_count)
      `, [snapshot.id, statusCountyIds, statusPrecinctCounts]);
    }
    contestsStored += 1;
    choicesStored += contest.choices.length;
  }
  return {
    skipped: false,
    batchId: String(batch.id),
    state: state.abbreviation,
    contests: contestsStored,
    choices: choicesStored,
    voteTotals: voteTotalsStored,
    missingCountyRows,
    invalidAggregateTotals
  };
}

async function removePreviousImport(client, source) {
  const batches = await client.query(`
    DELETE FROM result_batches batch
    USING source_artifacts artifact
    WHERE batch.source_artifact_id = artifact.id
      AND artifact.source_id = $1
      AND artifact.source_version = '2024 general'
  `, [source]);
  const contests = await client.query(`
    DELETE FROM contests contest
    USING contest_source_ids source_id
    WHERE source_id.contest_id = contest.id
      AND source_id.source_id = $1
      AND source_id.identifier_namespace = $2
  `, [source, namespace]);
  const runs = await client.query(`
    DELETE FROM ingestion_runs
    WHERE source_id = $1 AND parser_name = $2
  `, [source, parserName]);
  const artifacts = await client.query(`
    DELETE FROM source_artifacts
    WHERE source_id = $1 AND source_version = '2024 general'
  `, [source]);
  return {
    batches: batches.rowCount,
    contests: contests.rowCount,
    runs: runs.rowCount,
    artifacts: artifacts.rowCount
  };
}

export async function importResults({
  items, rejectedArchives = [], commit = false, replace = false, onProgress
}) {
  const client = await db.connect();
  const runId = randomUUID();
  try {
    await client.query('BEGIN');
    const source = (await row(client, "SELECT id FROM data_sources WHERE slug = 'medsl'")).id;
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['medsl:2024:general:import']);
    const replaced = replace ? await removePreviousImport(client, source) : null;
    await client.query(`
      INSERT INTO ingestion_runs (
        id, source_id, started_at, status, rows_read,
        parser_name, parser_version, metadata
      ) VALUES ($1, $2, NOW(), 'running', $3, $4, $5, $6::JSONB)
    `, [
      runId,
      source,
      items.reduce((sum, item) => sum + item.state.rowsRead, 0),
      parserName,
      parserVersion,
      JSON.stringify({
        dryRun: !commit,
        archives: items.length,
        rejectedArchives,
        replace
      })
    ]);
    const officeResult = await client.query(`
      SELECT id, slug FROM offices WHERE slug = ANY($1::TEXT[])
    `, [['president', 'us_senate', 'us_house', 'governor']]);
    const officeIds = new Map(officeResult.rows.map(office => [office.slug, office.id]));
    const stateResults = [];
    for (const [index, item] of items.entries()) {
      const result = await storeState(client, source, runId, item.archive, item.state, officeIds);
      stateResults.push(result);
      onProgress?.(
        `[${index + 1}/${items.length}] ${item.state.abbreviation}: `
        + (result.skipped ? 'archive already imported' : `${result.contests} contests stored`)
      );
    }
    const totals = stateResults.reduce((summary, result) => ({
      contests: summary.contests + (result.contests || 0),
      choices: summary.choices + (result.choices || 0),
      voteTotals: summary.voteTotals + (result.voteTotals || 0),
      missingCountyRows: summary.missingCountyRows + (result.missingCountyRows || 0),
      invalidAggregateTotals: summary.invalidAggregateTotals + (result.invalidAggregateTotals || 0),
      skippedArchives: summary.skippedArchives + Number(result.skipped)
    }), { contests: 0, choices: 0, voteTotals: 0, missingCountyRows: 0, invalidAggregateTotals: 0, skippedArchives: 0 });
    const warningBreakdown = {
      suppressedRows: items.reduce((sum, item) => sum + item.state.suppressedRows, 0),
      invalidCountyRows: items.reduce((sum, item) => sum + item.state.invalidCountyRows, 0),
      adjustmentRows: items.reduce((sum, item) => sum + item.state.adjustmentRows, 0),
      unassignedDistrictRows: items.reduce((sum, item) => sum + item.state.unassignedDistrictRows, 0),
      missingCountyRows: totals.missingCountyRows,
      invalidAggregateTotals: totals.invalidAggregateTotals,
      rejectedArchives: rejectedArchives.length
    };
    const parsedWarnings = warningBreakdown.suppressedRows + warningBreakdown.invalidCountyRows
      + warningBreakdown.adjustmentRows + warningBreakdown.unassignedDistrictRows;
    const warningCount = Object.values(warningBreakdown).reduce((sum, count) => sum + count, 0);
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
      totals.voteTotals,
      warningCount,
      `Imported 2024 federal and gubernatorial results: ${totals.contests} contests and ${totals.voteTotals} vote totals.`,
      JSON.stringify({ ...totals, parsedWarnings, warningBreakdown })
    ]);
    if (commit) await client.query('COMMIT');
    else await client.query('ROLLBACK');
    return {
      states: items.length,
      ...totals,
      warnings: warningCount,
      warningBreakdown,
      rejectedArchives,
      replaced,
      mode: commit ? 'committed' : 'dry-run'
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
