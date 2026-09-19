import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { db } from '../../db.js';
import { candidateUuid } from '../../identity/candidateUuid.js';
import { ensureStateCounties } from './countyGeography.js';
import { openStateFromVestArchive } from './archive.js';
import { readVestState } from './readState.js';

const parserName = 'vest-2020-national';
const parserVersion = '1.0.1';
const electionDate = '2020-11-03';
const allocationMethod = 'VEST precinct dataset may allocate source reporting-unit votes; see the state documentation.';

async function row(client, sql, params = []) {
  const result = await client.query(sql, params);
  if (result.rows.length !== 1) throw new Error(`Expected one database row; received ${result.rows.length}`);
  return result.rows[0];
}

async function sourceId(client) {
  return (await row(client, "SELECT id FROM data_sources WHERE slug = 'vest'")).id;
}

async function ensureArtifact(client, value) {
  const existing = await client.query(`
    SELECT id, parent_artifact_id
    FROM source_artifacts
    WHERE source_id = $1 AND sha256 = $2
  `, [value.sourceId, value.sha256]);
  if (existing.rows.length) {
    const artifact = existing.rows[0];
    if (value.parentArtifactId && String(artifact.parent_artifact_id) !== String(value.parentArtifactId)) {
      throw new Error(`Artifact ${value.sha256} is already linked to a different parent artifact`);
    }
    return artifact;
  }
  return row(client, `
    INSERT INTO source_artifacts (
      source_id, parent_artifact_id, uri, retrieved_at, sha256, byte_size,
      content_type, source_version, license, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, 'application/zip', 'V48', 'CC BY 4.0', $7::JSONB)
    RETURNING id, parent_artifact_id
  `, [
    value.sourceId,
    value.parentArtifactId || null,
    value.uri,
    value.retrievedAt,
    value.sha256,
    value.byteSize,
    JSON.stringify(value.metadata || {})
  ]);
}

async function linkSourceId(client, table, entityColumn, entityId, source, namespace, sourceIdentifier) {
  const allowed = new Map([
    ['geography_source_ids', 'geography_id'],
    ['candidate_source_ids', 'candidate_id'],
    ['election_source_ids', 'election_id'],
    ['contest_source_ids', 'contest_id'],
    ['contest_choice_source_ids', 'contest_choice_id']
  ]);
  if (allowed.get(table) !== entityColumn) throw new Error(`Unsupported source-ID table: ${table}`);
  const result = await client.query(`
    INSERT INTO ${table} (${entityColumn}, source_id, identifier_namespace, source_identifier)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (source_id, identifier_namespace, source_identifier) DO NOTHING
    RETURNING ${entityColumn}
  `, [entityId, source, namespace, sourceIdentifier]);
  if (result.rows.length) return;
  const existing = await row(client, `
    SELECT ${entityColumn}
    FROM ${table}
    WHERE source_id = $1 AND identifier_namespace = $2 AND source_identifier = $3
  `, [source, namespace, sourceIdentifier]);
  if (String(existing[entityColumn]) !== String(entityId)) {
    throw new Error(`${table} identifier ${namespace}/${sourceIdentifier} is already mapped to another entity`);
  }
}

async function ensureGeography(client, value) {
  const existing = await client.query(`
    SELECT geography_id AS id
    FROM geography_source_ids
    WHERE source_id = $1 AND identifier_namespace = $2 AND source_identifier = $3
  `, [value.sourceId, value.namespace, value.sourceIdentifier]);
  if (existing.rows.length) return existing.rows[0].id;
  const geography = await row(client, `
    INSERT INTO geographies (
      geography_type, name, abbreviation, state_fips, county_fips, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6::JSONB)
    ON CONFLICT (geography_type, state_fips, county_fips, name) DO UPDATE SET
      abbreviation = COALESCE(geographies.abbreviation, EXCLUDED.abbreviation),
      metadata = geographies.metadata || EXCLUDED.metadata
    RETURNING id
  `, [
    value.type,
    value.name,
    value.abbreviation || null,
    value.stateFips || null,
    value.countyFips || null,
    JSON.stringify(value.metadata || {})
  ]);
  await linkSourceId(client, 'geography_source_ids', 'geography_id', geography.id,
    value.sourceId, value.namespace, value.sourceIdentifier);
  return geography.id;
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function ensurePrecinctGeographies(client, { source, state, precincts }) {
  const geographyIds = new Map();
  for (const group of chunks(precincts, 1000)) {
    const proposedIds = group.map(() => randomUUID());
    const sourceIdentifiers = group.map(item => `precinct:${item.sourceIdentifier}`);
    const names = group.map(item => item.name);
    const abbreviations = group.map(item => item.sourceIdentifier);
    const countyFipsValues = group.map(item => item.countyFips);
    const metadata = group.map(item => JSON.stringify({
      vestPrecinct: item.sourceIdentifier,
      sourceCountyName: item.countyName
    }));
    await client.query(`
      WITH input AS (
        SELECT *
        FROM UNNEST(
          $1::UUID[], $2::TEXT[], $3::TEXT[], $4::TEXT[], $5::TEXT[], $6::JSONB[]
        ) AS values(id, source_identifier, name, abbreviation, county_fips, metadata)
      ), inserted AS (
        INSERT INTO geographies (
          id, geography_type, name, abbreviation, state_fips, county_fips, metadata
        )
        SELECT id, 'precinct', name, abbreviation, $7, county_fips, metadata
        FROM input
        ON CONFLICT (geography_type, state_fips, county_fips, name) DO UPDATE SET
          abbreviation = EXCLUDED.abbreviation,
          metadata = geographies.metadata || EXCLUDED.metadata
        RETURNING id, name, county_fips
      )
      INSERT INTO geography_source_ids (
        geography_id, source_id, identifier_namespace, source_identifier
      )
      SELECT inserted.id, $8, $9, input.source_identifier
      FROM input
      JOIN inserted
        ON inserted.county_fips IS NOT DISTINCT FROM input.county_fips
        AND inserted.name = input.name
      ON CONFLICT (source_id, identifier_namespace, source_identifier) DO UPDATE SET
        geography_id = EXCLUDED.geography_id
    `, [
      proposedIds,
      sourceIdentifiers,
      names,
      abbreviations,
      countyFipsValues,
      metadata,
      state.stateFips,
      source,
      state.namespace
    ]);
    const mapped = await client.query(`
      SELECT source_identifier, geography_id
      FROM geography_source_ids
      WHERE source_id = $1 AND identifier_namespace = $2
        AND source_identifier = ANY($3::TEXT[])
    `, [source, state.namespace, sourceIdentifiers]);
    if (mapped.rows.length !== group.length) {
      throw new Error(`${state.abbreviation} failed to map a complete precinct geography batch: ${mapped.rows.length}/${group.length}`);
    }
    for (const item of mapped.rows) {
      geographyIds.set(item.source_identifier.slice('precinct:'.length), item.geography_id);
    }
  }
  return geographyIds;
}

async function upsertPrecinctVersions(client, { precincts, geographyIds, artifactId, sourceCrs }) {
  const repairs = [];
  for (const group of chunks(precincts, 250)) {
    const ids = group.map(item => geographyIds.get(item.sourceIdentifier));
    const geometries = group.map(item => JSON.stringify(item.geometry));
    const result = await client.query(`
      WITH input AS (
        SELECT * FROM UNNEST($1::UUID[], $2::JSONB[]) AS values(geography_id, geometry)
      ), raw AS (
        SELECT
          geography_id,
          ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(geometry::TEXT), 4326)) AS geom
        FROM input
      ), prepared AS (
        SELECT
          geography_id,
          CASE WHEN ST_IsValid(geom) THEN geom
               ELSE ST_Multi(ST_CollectionExtract(ST_MakeValid(geom), 3)) END AS geom,
          NOT ST_IsValid(geom) AS was_repaired,
          CASE WHEN ST_IsValid(geom) THEN NULL ELSE ST_IsValidReason(geom) END AS invalid_reason
        FROM raw
      )
      INSERT INTO geography_versions (
        geography_id, source_artifact_id, valid_from, valid_to, geom,
        is_estimated, methodology, metadata
      )
      SELECT
        geography_id, $3, $4, $4, geom, FALSE,
        'VEST 2020 election precinct boundary transformed from the source CRS to EPSG:4326.',
        JSONB_BUILD_OBJECT(
          'sourceCrs', $5::TEXT,
          'geometryRepaired', was_repaired,
          'invalidReason', invalid_reason
        )
      FROM prepared
      ON CONFLICT (geography_id, valid_from, valid_to) DO UPDATE SET
        source_artifact_id = EXCLUDED.source_artifact_id,
        geom = EXCLUDED.geom,
        methodology = EXCLUDED.methodology,
        metadata = EXCLUDED.metadata
      RETURNING
        geography_id,
        (metadata->>'geometryRepaired')::BOOLEAN AS was_repaired,
        metadata->>'invalidReason' AS invalid_reason,
        ST_IsEmpty(geom) AS is_empty
    `, [ids, geometries, artifactId, electionDate, sourceCrs]);
    for (const item of result.rows) {
      if (item.is_empty) throw new Error(`Geometry repair produced an empty polygon for geography ${item.geography_id}`);
      if (item.was_repaired) repairs.push({ geographyId: item.geography_id, reason: item.invalid_reason });
    }
  }
  return repairs;
}

async function linkGeographyChildren(client, parentId, childIds, validFrom, validTo = validFrom) {
  for (const group of chunks(childIds, 2000)) {
    await client.query(`
      INSERT INTO geography_relationships (
        parent_geography_id, child_geography_id, relationship_type, valid_from, valid_to
      )
      SELECT $1, child_id, 'contains', $3, $4
      FROM UNNEST($2::UUID[]) AS values(child_id)
      ON CONFLICT (parent_geography_id, child_geography_id, relationship_type, valid_from)
      DO UPDATE SET valid_to = EXCLUDED.valid_to
    `, [parentId, group, validFrom, validTo]);
  }
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

async function ensureCandidate(client, value) {
  if (!value.candidateKey) return null;
  const expectedId = candidateUuid(value.candidateKey);
  const candidate = await row(client, `
    INSERT INTO candidates (id, canonical_key, canonical_name, metadata)
    VALUES ($1, $2, $3, $4::JSONB)
    ON CONFLICT (canonical_key) DO UPDATE SET canonical_name = candidates.canonical_name
    RETURNING id
  `, [
    expectedId,
    value.candidateKey,
    value.canonicalName || value.name,
    JSON.stringify({
      identityResolution: value.officeSlug === 'president'
        ? 'national normalized VEST candidate identity'
        : 'state-scoped normalized VEST candidate identity'
    })
  ]);
  if (candidate.id !== expectedId) {
    throw new Error(`Candidate ${value.candidateKey} has noncanonical UUID ${candidate.id}; expected ${expectedId}`);
  }
  await linkSourceId(client, 'candidate_source_ids', 'candidate_id', candidate.id,
    value.sourceId, value.namespace, value.column);
  return candidate.id;
}

async function ensureElection(client, { source, state, stateGeographyId }) {
  const existing = await client.query(`
    SELECT election_id AS id
    FROM election_source_ids
    WHERE source_id = $1 AND identifier_namespace = $2 AND source_identifier = 'G20'
  `, [source, state.namespace]);
  if (existing.rows.length) return existing.rows[0].id;
  const election = await row(client, `
    INSERT INTO election_events (
      name, cycle, stage, start_date, end_date, scope_geography_id, metadata
    ) VALUES ($1, 2020, 'general', $2, $2, $3, $4::JSONB)
    RETURNING id
  `, [
    `2020 ${state.name} General Election`,
    electionDate,
    stateGeographyId,
    JSON.stringify({ source: 'VEST 2020 precinct dataset' })
  ]);
  await linkSourceId(client, 'election_source_ids', 'election_id', election.id,
    source, state.namespace, 'G20');
  return election.id;
}

async function ensureContest(client, value) {
  const existing = await client.query(`
    SELECT contest_id AS id
    FROM contest_source_ids
    WHERE source_id = $1 AND identifier_namespace = $2 AND source_identifier = $3
  `, [value.sourceId, value.namespace, value.sourceIdentifier]);
  if (existing.rows.length) {
    const office = await row(client, 'SELECT office_id FROM contests WHERE id = $1', [existing.rows[0].id]);
    return { id: existing.rows[0].id, officeId: office.office_id };
  }
  const office = await row(client, 'SELECT id FROM offices WHERE slug = $1', [value.officeSlug]);
  const contest = await row(client, `
    INSERT INTO contests (
      election_id, office_id, district_geography_id, name, district_label,
      contest_type, vote_variation, metadata
    ) VALUES ($1, $2, $3, $4, $5, 'candidate', 'plurality', $6::JSONB)
    RETURNING id
  `, [
    value.electionId,
    office.id,
    value.districtGeographyId,
    value.name,
    value.districtLabel,
    JSON.stringify(value.metadata || {})
  ]);
  await linkSourceId(client, 'contest_source_ids', 'contest_id', contest.id,
    value.sourceId, value.namespace, value.sourceIdentifier);
  return { id: contest.id, officeId: office.id };
}

async function ensureChoice(client, value) {
  const existing = await client.query(`
    SELECT contest_choice_id AS id
    FROM contest_choice_source_ids
    WHERE source_id = $1 AND identifier_namespace = $2 AND source_identifier = $3
  `, [value.sourceId, value.namespace, value.column]);
  if (existing.rows.length) return existing.rows[0].id;
  const partyId = await ensureParty(client, value.party);
  const candidateId = await ensureCandidate(client, value);
  const choice = await row(client, `
    INSERT INTO contest_choices (
      contest_id, ballot_name, choice_type, party_id, is_write_in, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6::JSONB)
    RETURNING id
  `, [
    value.contestId,
    value.name,
    value.choiceType,
    partyId,
    value.choiceType === 'write_in',
    JSON.stringify({
      vestColumn: value.column,
      documentationCorrection: value.documentationCorrection || null
    })
  ]);
  if (candidateId) {
    await client.query(`
      INSERT INTO contest_choice_candidates (contest_choice_id, candidate_id, office_id)
      VALUES ($1, $2, $3)
    `, [choice.id, candidateId, value.officeId]);
  }
  await linkSourceId(client, 'contest_choice_source_ids', 'contest_choice_id', choice.id,
    value.sourceId, value.namespace, value.column);
  return choice.id;
}

async function linkGeographies(client, parentId, childId, validFrom, validTo = validFrom) {
  await client.query(`
    INSERT INTO geography_relationships (
      parent_geography_id, child_geography_id, relationship_type, valid_from, valid_to
    ) VALUES ($1, $2, 'contains', $3, $4)
    ON CONFLICT (parent_geography_id, child_geography_id, relationship_type, valid_from)
    DO UPDATE SET valid_to = EXCLUDED.valid_to
  `, [parentId, childId, validFrom, validTo]);
}

function precinctsForContest(precincts, contest) {
  if (contest.district === 'state' || contest.district === 'AL') return precincts;
  return precincts.filter(precinct => contest.choices.some(choice => precinct.votes[choice.column] > 0));
}

async function repairExistingVoteTotals(client, { source, state, batchId, parsed }) {
  const expectedVotes = Object.values(parsed.totals).reduce((sum, votes) => sum + votes, 0);
  const current = await row(client, `
    SELECT COALESCE(SUM(total.votes), 0)::BIGINT AS votes
    FROM result_snapshots snapshot
    JOIN vote_totals total ON total.snapshot_id = snapshot.id
    WHERE snapshot.batch_id = $1
      AND total.tabulation_method = 'allocated'
  `, [batchId]);
  if (Number(current.votes) === expectedVotes) return { repaired: false, updated: 0 };

  const snapshotRows = await client.query(`
    SELECT
      source_id.source_identifier,
      snapshot.id AS snapshot_id,
      contest.district_geography_id
    FROM result_snapshots snapshot
    JOIN contests contest ON contest.id = snapshot.contest_id
    JOIN contest_source_ids source_id ON source_id.contest_id = contest.id
    WHERE snapshot.batch_id = $1
      AND source_id.source_id = $2
      AND source_id.identifier_namespace = $3
  `, [batchId, source, state.namespace]);
  const snapshots = new Map(snapshotRows.rows.map(item => [item.source_identifier, item]));

  const choiceRows = await client.query(`
    SELECT source_identifier, contest_choice_id
    FROM contest_choice_source_ids
    WHERE source_id = $1 AND identifier_namespace = $2
  `, [source, state.namespace]);
  const choices = new Map(choiceRows.rows.map(item => [item.source_identifier, item.contest_choice_id]));

  const precinctRows = await client.query(`
    SELECT source_identifier, geography_id
    FROM geography_source_ids
    WHERE source_id = $1
      AND identifier_namespace = $2
      AND source_identifier LIKE 'precinct:%'
  `, [source, state.namespace]);
  const precincts = new Map(precinctRows.rows.map(item => [
    item.source_identifier.slice('precinct:'.length),
    item.geography_id
  ]));

  const snapshotIds = [];
  const reportingUnitIds = [];
  const choiceIds = [];
  const votes = [];
  const summarySnapshotIds = [];
  const summaryReportingUnitIds = [];
  const summaryChoiceIds = [];
  const summaryVotes = [];
  for (const contest of parsed.contests) {
    const snapshot = snapshots.get(contest.sourceIdentifier);
    if (!snapshot) throw new Error(`Cannot repair ${state.abbreviation}: missing snapshot for ${contest.sourceIdentifier}`);
    for (const precinct of precinctsForContest(parsed.precincts, contest)) {
      const reportingUnitId = precincts.get(precinct.sourceIdentifier);
      if (!reportingUnitId) {
        throw new Error(`Cannot repair ${state.abbreviation}: missing precinct ${precinct.sourceIdentifier}`);
      }
      for (const choice of contest.choices) {
        const choiceId = choices.get(choice.column);
        if (!choiceId) throw new Error(`Cannot repair ${state.abbreviation}: missing choice ${choice.column}`);
        snapshotIds.push(snapshot.snapshot_id);
        reportingUnitIds.push(reportingUnitId);
        choiceIds.push(choiceId);
        votes.push(precinct.votes[choice.column]);
      }
    }
    for (const choice of contest.choices) {
      const choiceId = choices.get(choice.column);
      if (!choiceId) throw new Error(`Cannot repair ${state.abbreviation}: missing choice ${choice.column}`);
      summarySnapshotIds.push(snapshot.snapshot_id);
      summaryReportingUnitIds.push(snapshot.district_geography_id);
      summaryChoiceIds.push(choiceId);
      summaryVotes.push(parsed.totals[choice.column]);
    }
  }

  const detailResult = await row(client, `
    WITH input AS (
      SELECT *
      FROM UNNEST($1::UUID[], $2::UUID[], $3::UUID[], $4::BIGINT[])
        AS values(snapshot_id, reporting_unit_id, choice_id, votes)
    ), updated AS (
      UPDATE vote_totals total
      SET votes = input.votes
      FROM input
      WHERE total.snapshot_id = input.snapshot_id
        AND total.reporting_unit_id = input.reporting_unit_id
        AND total.contest_choice_id = input.choice_id
        AND total.vote_type = 'total'
        AND total.round = 0
        AND total.tabulation_method = 'allocated'
      RETURNING 1
    )
    SELECT COUNT(*)::INTEGER AS count FROM updated
  `, [snapshotIds, reportingUnitIds, choiceIds, votes]);

  const summaryResult = await row(client, `
    WITH input AS (
      SELECT *
      FROM UNNEST($1::UUID[], $2::UUID[], $3::UUID[], $4::BIGINT[])
        AS values(snapshot_id, reporting_unit_id, choice_id, votes)
    ), updated AS (
      UPDATE vote_totals total
      SET votes = input.votes
      FROM input
      WHERE total.snapshot_id = input.snapshot_id
        AND total.reporting_unit_id = input.reporting_unit_id
        AND total.contest_choice_id = input.choice_id
        AND total.vote_type = 'total'
        AND total.round = 0
        AND total.tabulation_method = 'sum_of_reporting_units'
      RETURNING 1
    )
    SELECT COUNT(*)::INTEGER AS count FROM updated
  `, [summarySnapshotIds, summaryReportingUnitIds, summaryChoiceIds, summaryVotes]);

  if (detailResult.count !== votes.length || summaryResult.count !== summaryVotes.length) {
    throw new Error(
      `Cannot repair ${state.abbreviation}: updated ${detailResult.count}/${votes.length} detail and `
      + `${summaryResult.count}/${summaryVotes.length} summary rows`
    );
  }
  return { repaired: true, updated: detailResult.count + summaryResult.count };
}

async function recordFailedRun(runId, startedAt, state, message) {
  const client = await db.connect();
  try {
    const source = await sourceId(client);
    await client.query(`
      INSERT INTO ingestion_runs (
        id, source_id, started_at, completed_at, status,
        parser_name, parser_version, message, metadata
      ) VALUES ($1, $2, $3, NOW(), 'failed', $4, $5, $6, $7::JSONB)
      ON CONFLICT (id) DO NOTHING
    `, [
      runId,
      source,
      startedAt,
      parserName,
      parserVersion,
      message.slice(0, 2000),
      JSON.stringify({ state: state.abbreviation, namespace: state.namespace })
    ]);
  } finally {
    client.release();
  }
}

async function persistState(client, outer, archive, parsed, state, context) {
  const source = await sourceId(client);
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`vest:2020:${state.code}:import`]);
  await client.query(`
    INSERT INTO ingestion_runs (
      id, source_id, started_at, status, rows_read, parser_name, parser_version, metadata
    ) VALUES ($1, $2, $3, 'running', $4, $5, $6, $7::JSONB)
  `, [
    context.runId,
    source,
    context.startedAt,
    parsed.precincts.length,
    parserName,
    parserVersion,
    JSON.stringify({ dryRun: !context.commit, state: state.abbreviation, namespace: state.namespace })
  ]);

  const outerArtifact = await ensureArtifact(client, {
    sourceId: source,
    uri: pathToFileURL(outer.resolvedPath).href,
    retrievedAt: outer.retrievedAt,
    sha256: outer.outerSha256,
    byteSize: outer.outerByteSize,
    metadata: { persistentId: 'doi:10.7910/DVN/K7760H', filename: 'dataverse_files.zip' }
  });
  const stateArtifact = await ensureArtifact(client, {
    sourceId: source,
    parentArtifactId: outerArtifact.id,
    uri: `zip://${pathToFileURL(outer.resolvedPath).href}!/${state.archiveName}`,
    retrievedAt: outer.retrievedAt,
    sha256: archive.stateSha256,
    byteSize: archive.stateByteSize,
    metadata: { state: state.abbreviation, namespace: state.namespace }
  });

  const existingBatch = await client.query(`
    SELECT id
    FROM result_batches
    WHERE source_id = $1 AND source_artifact_id = $2
    LIMIT 1
  `, [source, stateArtifact.id]);
  if (existingBatch.rows.length) {
    const repair = await repairExistingVoteTotals(client, {
      source,
      state,
      batchId: existingBatch.rows[0].id,
      parsed
    });
    const stateGeography = await row(client, `
      SELECT id FROM geographies WHERE geography_type = 'state' AND state_fips = $1
    `, [state.stateFips]);
    const precinctRows = await client.query(`
      SELECT id FROM geographies WHERE geography_type = 'precinct' AND state_fips = $1
    `, [state.stateFips]);
    const counties = await ensureStateCounties(client, {
      state,
      stateGeographyId: stateGeography.id,
      precinctIds: precinctRows.rows.map(item => item.id),
      electionDate
    });
    await client.query(`
      UPDATE ingestion_runs
      SET completed_at = NOW(), status = 'completed', source_artifact_id = $2,
          rows_updated = $3,
          message = $4
      WHERE id = $1
    `, [
      context.runId,
      stateArtifact.id,
      repair.updated,
      repair.repaired
        ? `Artifact already imported; repaired ${repair.updated} vote totals and verified county crosswalk.`
        : 'Artifact already imported; vote totals and county crosswalk verified.'
    ]);
    return {
      alreadyImported: true,
      repaired: repair.repaired,
      repairedVoteTotals: repair.updated,
      batchId: String(existingBatch.rows[0].id),
      counties
    };
  }

  const stateGeographyId = await ensureGeography(client, {
    sourceId: source,
    namespace: state.namespace,
    sourceIdentifier: `state:${state.stateFips}`,
    type: 'state',
    name: state.name,
    abbreviation: state.abbreviation,
    stateFips: state.stateFips
  });
  const electionId = await ensureElection(client, { source, state, stateGeographyId });

  const districtIds = new Map();
  for (const contest of parsed.contests.filter(item => item.officeSlug === 'us_house')) {
    const abbreviation = contest.district === 'AL'
      ? `${state.abbreviation}-AL`
      : `${state.abbreviation}-${contest.district}`;
    const districtId = await ensureGeography(client, {
      sourceId: source,
      namespace: state.namespace,
      sourceIdentifier: `congressional-district:${contest.district}`,
      type: 'congressional_district',
      name: contest.district === 'AL'
        ? `${state.name} Congressional District At-Large`
        : `${state.name} Congressional District ${Number(contest.district)}`,
      abbreviation,
      stateFips: state.stateFips,
      metadata: { districtLabel: contest.districtLabel }
    });
    districtIds.set(contest.sourceIdentifier, districtId);
    await linkGeographies(client, stateGeographyId, districtId, electionDate);
  }

  const precinctGeographyIds = await ensurePrecinctGeographies(client, {
    source,
    state,
    precincts: parsed.precincts
  });
  context.onProgress?.('precinct identities stored');
  const geometryRepairs = await upsertPrecinctVersions(client, {
    precincts: parsed.precincts,
    geographyIds: precinctGeographyIds,
    artifactId: stateArtifact.id,
    sourceCrs: archive.prj
  });
  context.onProgress?.(`precinct geometry stored (${geometryRepairs.length} repaired)`);
  const allPrecinctIds = [...precinctGeographyIds.values()];
  await linkGeographyChildren(client, stateGeographyId, allPrecinctIds, electionDate);

  const contests = [];
  for (const parsedContest of parsed.contests) {
    const districtGeographyId = parsedContest.officeSlug === 'us_house'
      ? districtIds.get(parsedContest.sourceIdentifier)
      : stateGeographyId;
    const contest = await ensureContest(client, {
      sourceId: source,
      namespace: state.namespace,
      sourceIdentifier: parsedContest.sourceIdentifier,
      electionId,
      districtGeographyId,
      name: parsedContest.name,
      districtLabel: parsedContest.districtLabel,
      officeSlug: parsedContest.officeSlug,
      metadata: parsedContest.officeSlug === 'president'
        ? { sourceRepresentsPresidentialCandidateOnly: true }
        : {}
    });
    const choices = [];
    for (const parsedChoice of parsedContest.choices) {
      const id = await ensureChoice(client, {
        ...parsedChoice,
        sourceId: source,
        namespace: state.namespace,
        contestId: contest.id,
        officeId: contest.officeId,
        officeSlug: parsedContest.officeSlug
      });
      choices.push({ ...parsedChoice, id });
    }
    const applicablePrecincts = precinctsForContest(parsed.precincts, parsedContest);
    if (!applicablePrecincts.length) throw new Error(`${state.abbreviation} ${parsedContest.name} has no applicable precincts`);
    if (parsedContest.officeSlug === 'us_house') {
      const childIds = applicablePrecincts.map(item => precinctGeographyIds.get(item.sourceIdentifier));
      await linkGeographyChildren(client, districtGeographyId, childIds, electionDate);
    }
    contests.push({ ...parsedContest, id: contest.id, districtGeographyId, choices, applicablePrecincts });
  }

  const batch = await row(client, `
    INSERT INTO result_batches (
      source_id, source_artifact_id, ingestion_run_id, reported_at,
      retrieved_at, status, metadata
    ) VALUES ($1, $2, $3, NULL, $4, 'research_dataset', $5::JSONB)
    RETURNING id
  `, [
    source,
    stateArtifact.id,
    context.runId,
    archive.retrievedAt,
    JSON.stringify({
      exactSourceReportTimeKnown: false,
      includesPotentiallyAllocatedVotes: true,
      state: state.abbreviation
    })
  ]);

  const snapshotIds = [];
  for (const contest of contests) {
    const snapshot = await row(client, `
      INSERT INTO result_snapshots (
        batch_id, contest_id, reporting_basis, reporting_value,
        reported_units, total_units, metadata
      ) VALUES ($1, $2, 'precincts', 100, $3, $3, $4::JSONB)
      RETURNING id
    `, [
      batch.id,
      contest.id,
      contest.applicablePrecincts.length,
      JSON.stringify({ sourceCompleteness: 'complete VEST state archive' })
    ]);
    contest.snapshotId = snapshot.id;
    snapshotIds.push(snapshot.id);
  }

  const detailSnapshotIds = [];
  const detailReportingUnitIds = [];
  const detailChoiceIds = [];
  const detailVotes = [];
  const statusSnapshotIds = [];
  const statusReportingUnitIds = [];
  for (const contest of contests) {
    for (const precinct of contest.applicablePrecincts) {
      const geographyId = precinctGeographyIds.get(precinct.sourceIdentifier);
      statusSnapshotIds.push(contest.snapshotId);
      statusReportingUnitIds.push(geographyId);
      for (const choice of contest.choices) {
        detailSnapshotIds.push(contest.snapshotId);
        detailReportingUnitIds.push(geographyId);
        detailChoiceIds.push(choice.id);
        detailVotes.push(precinct.votes[choice.column]);
      }
    }
  }

  await client.query(`
    INSERT INTO vote_totals (
      snapshot_id, reporting_unit_id, contest_choice_id, vote_type, round,
      votes, is_estimated, tabulation_method, allocation_method, vote_status, metadata
    )
    SELECT
      values.snapshot_id, values.reporting_unit_id, values.choice_id,
      'total', 0, values.votes, TRUE, 'allocated', $5, 'reported', '{}'::JSONB
    FROM UNNEST($1::UUID[], $2::UUID[], $3::UUID[], $4::BIGINT[])
      AS values(snapshot_id, reporting_unit_id, choice_id, votes)
  `, [detailSnapshotIds, detailReportingUnitIds, detailChoiceIds, detailVotes, allocationMethod]);

  await client.query(`
    INSERT INTO reporting_unit_statuses (
      snapshot_id, reporting_unit_id, vote_type, count_status,
      reporting_basis, reporting_value, metadata
    )
    SELECT values.snapshot_id, values.reporting_unit_id, 'total', 'complete',
           'precincts', 100, '{}'::JSONB
    FROM UNNEST($1::UUID[], $2::UUID[]) AS values(snapshot_id, reporting_unit_id)
  `, [statusSnapshotIds, statusReportingUnitIds]);
  context.onProgress?.(`${detailVotes.length} precinct vote rows stored`);

  for (const contest of contests) {
    for (const choice of contest.choices) {
      await client.query(`
        INSERT INTO vote_totals (
          snapshot_id, reporting_unit_id, contest_choice_id, vote_type, round,
          votes, is_estimated, tabulation_method, allocation_method, vote_status, metadata
        ) VALUES ($1, $2, $3, 'total', 0, $4, TRUE,
                  'sum_of_reporting_units', $5, 'reported', $6::JSONB)
      `, [
        contest.snapshotId,
        contest.districtGeographyId,
        choice.id,
        parsed.totals[choice.column],
        allocationMethod,
        JSON.stringify({ sourceColumn: choice.column })
      ]);
    }
  }

  const invalidGeometry = await row(client, `
    SELECT COUNT(*)::INTEGER AS count
    FROM geography_versions
    WHERE source_artifact_id = $1 AND NOT ST_IsValid(geom)
  `, [stateArtifact.id]);
  if (invalidGeometry.count !== 0) throw new Error(`${invalidGeometry.count} imported geometries are invalid`);

  const countyResult = await ensureStateCounties(client, {
    state,
    stateGeographyId,
    precinctIds: allPrecinctIds,
    electionDate
  });
  context.onProgress?.(`${countyResult.counties} county boundaries linked`);
  const expectedDetail = contests.reduce(
    (sum, contest) => sum + contest.applicablePrecincts.length * contest.choices.length,
    0
  );
  const expectedSummaries = contests.reduce((sum, contest) => sum + contest.choices.length, 0);
  const resultCounts = await row(client, `
    SELECT
      COUNT(*)::INTEGER AS total,
      COUNT(*) FILTER (WHERE tabulation_method = 'allocated')::INTEGER AS detail,
      COUNT(*) FILTER (WHERE tabulation_method = 'sum_of_reporting_units')::INTEGER AS summaries
    FROM vote_totals
    WHERE snapshot_id = ANY($1::UUID[])
  `, [snapshotIds]);
  if (resultCounts.detail !== expectedDetail || resultCounts.summaries !== expectedSummaries) {
    throw new Error(`Unexpected vote-total counts: ${JSON.stringify(resultCounts)}`);
  }

  const warningCount = 1 + geometryRepairs.length + countyResult.fallback_count;
  await client.query(`
    UPDATE ingestion_runs
    SET completed_at = NOW(),
        status = CASE WHEN $3 > 0 THEN 'completed_with_warnings' ELSE 'completed' END,
        rows_added = $2, warning_count = $3, message = $4, source_artifact_id = $5
    WHERE id = $1
  `, [
    context.runId,
    resultCounts.total,
    warningCount,
    `Imported ${state.name}: ${parsed.precincts.length} precincts, ${contests.length} contests, ${geometryRepairs.length} geometry repairs, ${countyResult.fallback_count} county fallbacks.`,
    stateArtifact.id
  ]);

  return {
    alreadyImported: false,
    batchId: String(batch.id),
    precincts: parsed.precincts.length,
    contests: contests.length,
    choices: expectedSummaries,
    detailVoteTotals: resultCounts.detail,
    summaryVoteTotals: resultCounts.summaries,
    reportingStatuses: statusSnapshotIds.length,
    geometryRepairs: geometryRepairs.length,
    counties: countyResult.counties,
    countyFallbacks: countyResult.fallback_count
  };
}

export async function importVestState({ outer, state, documentation, commit = false, onProgress }) {
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  let client;
  try {
    const archive = await openStateFromVestArchive(outer, state);
    const labels = documentation.labels.get(state.code);
    if (!labels) throw new Error(`No documentation section found for ${state.name}`);
    const parsed = await readVestState(archive, state, labels);
    onProgress?.(`${parsed.precincts.length} source precincts and ${parsed.contests.length} contests parsed`);
    client = await db.connect();
    await client.query('BEGIN');
    const persisted = await persistState(client, outer, archive, parsed, state, {
      commit, runId, startedAt, onProgress
    });
    if (commit) await client.query('COMMIT');
    else await client.query('ROLLBACK');
    const result = {
      state: state.abbreviation,
      name: state.name,
      mode: commit ? 'committed' : 'dry-run',
      rolledBack: !commit,
      runId,
      namespace: state.namespace,
      archiveSha256: archive.stateSha256,
      bounds: parsed.bounds,
      ...persisted
    };
    if (!commit && !persisted.alreadyImported) result.batchId = null;
    return result;
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    if (commit) {
      try {
        await recordFailedRun(runId, startedAt, state, error.message);
      } catch (recordError) {
        error.message += `; additionally failed to record ingestion failure: ${recordError.message}`;
      }
    }
    throw error;
  } finally {
    client?.release();
  }
}
