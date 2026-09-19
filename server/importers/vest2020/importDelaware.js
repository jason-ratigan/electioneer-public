import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { db } from '../../db.js';
import { candidateUuid } from '../../identity/candidateUuid.js';
import { openStateArchive } from './archive.js';
import { delawareManifest } from './delawareManifest.js';
import { resolvePresidentialCandidate } from './presidentialCandidates.js';
import { readDelaware } from './readDelaware.js';

const parserName = 'vest-2020-delaware';
const parserVersion = '1.0.0';

async function row(client, sql, params = []) {
  const result = await client.query(sql, params);
  if (result.rows.length !== 1) throw new Error(`Expected one database row; received ${result.rows.length}`);
  return result.rows[0];
}

async function sourceId(client) {
  return (await row(client, "SELECT id FROM data_sources WHERE slug = 'vest'" )).id;
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
    SELECT g.id
    FROM geography_source_ids source_id
    JOIN geographies g ON g.id = source_id.geography_id
    WHERE source_id.source_id = $1
      AND source_id.identifier_namespace = $2
      AND source_id.source_identifier = $3
  `, [value.sourceId, value.namespace, value.sourceIdentifier]);
  if (existing.rows.length) return existing.rows[0].id;

  const geography = await row(client, `
    INSERT INTO geographies (geography_type, name, abbreviation, state_fips, county_fips, metadata)
    VALUES ($1, $2, $3, $4, $5, $6::JSONB)
    RETURNING id
  `, [
    value.type,
    value.name,
    value.abbreviation || null,
    value.stateFips || null,
    value.countyFips || null,
    JSON.stringify(value.metadata || {})
  ]);
  await linkSourceId(
    client,
    'geography_source_ids',
    'geography_id',
    geography.id,
    value.sourceId,
    value.namespace,
    value.sourceIdentifier
  );
  return geography.id;
}

async function ensureParty(client, value) {
  return (await row(client, `
    INSERT INTO parties (name, abbreviation)
    VALUES ($1, $2)
    ON CONFLICT (name) DO UPDATE SET abbreviation = COALESCE(parties.abbreviation, EXCLUDED.abbreviation)
    RETURNING id
  `, [value.name, value.abbreviation])).id;
}

async function ensureCandidate(client, value) {
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
    JSON.stringify({ identityResolution: 'reviewed canonical candidate registry' })
  ]);
  if (candidate.id !== expectedId) {
    throw new Error(`Candidate ${value.candidateKey} has noncanonical UUID ${candidate.id}; expected ${expectedId}`);
  }
  await linkSourceId(
    client,
    'candidate_source_ids',
    'candidate_id',
    candidate.id,
    value.sourceId,
    value.namespace,
    value.column
  );
  return candidate.id;
}

async function ensureElection(client, source, stateGeographyId) {
  const manifest = delawareManifest;
  const existing = await client.query(`
    SELECT election_id AS id
    FROM election_source_ids
    WHERE source_id = $1 AND identifier_namespace = $2 AND source_identifier = $3
  `, [source, manifest.namespace, manifest.election.sourceIdentifier]);
  if (existing.rows.length) return existing.rows[0].id;

  const election = await row(client, `
    INSERT INTO election_events (name, cycle, stage, start_date, end_date, scope_geography_id, metadata)
    VALUES ($1, $2, $3, $4, $4, $5, $6::JSONB)
    RETURNING id
  `, [
    manifest.election.name,
    manifest.election.cycle,
    manifest.election.stage,
    manifest.election.date,
    stateGeographyId,
    JSON.stringify({ source: 'VEST 2020 precinct dataset' })
  ]);
  await linkSourceId(
    client,
    'election_source_ids',
    'election_id',
    election.id,
    source,
    manifest.namespace,
    manifest.election.sourceIdentifier
  );
  return election.id;
}

async function ensureContest(client, value) {
  const existing = await client.query(`
    SELECT contest_id AS id
    FROM contest_source_ids
    WHERE source_id = $1 AND identifier_namespace = $2 AND source_identifier = $3
  `, [value.sourceId, value.namespace, value.sourceIdentifier]);
  if (existing.rows.length) return existing.rows[0].id;

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
  await linkSourceId(
    client,
    'contest_source_ids',
    'contest_id',
    contest.id,
    value.sourceId,
    value.namespace,
    value.sourceIdentifier
  );
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
    INSERT INTO contest_choices (contest_id, ballot_name, choice_type, party_id, metadata)
    VALUES ($1, $2, 'candidate', $3, $4::JSONB)
    RETURNING id
  `, [value.contestId, value.name, partyId, JSON.stringify({ vestColumn: value.column })]);
  await client.query(`
    INSERT INTO contest_choice_candidates (contest_choice_id, candidate_id, office_id)
    VALUES ($1, $2, $3)
  `, [choice.id, candidateId, value.officeId]);
  await linkSourceId(
    client,
    'contest_choice_source_ids',
    'contest_choice_id',
    choice.id,
    value.sourceId,
    value.namespace,
    value.column
  );
  return choice.id;
}

async function upsertGeographyVersion(client, value) {
  const result = await row(client, `
    WITH raw AS (
      SELECT ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($4), 4326)) AS geom
    ), prepared AS (
      SELECT
        CASE
          WHEN ST_IsValid(geom) THEN geom
          ELSE ST_Multi(ST_CollectionExtract(ST_MakeValid(geom), 3))
        END AS geom,
        NOT ST_IsValid(geom) AS was_repaired,
        CASE WHEN ST_IsValid(geom) THEN NULL ELSE ST_IsValidReason(geom) END AS invalid_reason
      FROM raw
    )
    INSERT INTO geography_versions (
      geography_id, source_artifact_id, valid_from, valid_to, geom,
      is_estimated, methodology, metadata
    )
    SELECT
      $1, $2, $3, $3, prepared.geom, FALSE, $5,
      $6::JSONB || JSONB_BUILD_OBJECT(
        'geometryRepaired', prepared.was_repaired,
        'invalidReason', prepared.invalid_reason
      )
    FROM prepared
    ON CONFLICT (geography_id, valid_from, valid_to) DO UPDATE SET
      source_artifact_id = EXCLUDED.source_artifact_id,
      geom = EXCLUDED.geom,
      methodology = EXCLUDED.methodology,
      metadata = EXCLUDED.metadata
    RETURNING
      (metadata->>'geometryRepaired')::BOOLEAN AS was_repaired,
      metadata->>'invalidReason' AS invalid_reason,
      ST_IsEmpty(geom) AS is_empty
  `, [
    value.geographyId,
    value.artifactId,
    value.validDate,
    JSON.stringify(value.geometry),
    value.methodology,
    JSON.stringify(value.metadata || {})
  ]);
  if (result.is_empty) throw new Error(`Geometry repair produced an empty polygon for geography ${value.geographyId}`);
  return result;
}

async function linkGeographies(client, parentId, childId, validDate, relationshipType = 'contains') {
  await client.query(`
    INSERT INTO geography_relationships (
      parent_geography_id, child_geography_id, relationship_type, valid_from, valid_to
    ) VALUES ($1, $2, $3, $4, $4)
    ON CONFLICT (parent_geography_id, child_geography_id, relationship_type, valid_from)
    DO UPDATE SET valid_to = EXCLUDED.valid_to
  `, [parentId, childId, relationshipType, validDate]);
}

async function buildAggregateGeometry(client, geographyId, childType, artifactId, validDate, methodology) {
  const result = await client.query(`
    INSERT INTO geography_versions (
      geography_id, source_artifact_id, valid_from, valid_to, geom,
      is_estimated, methodology, metadata
    )
    SELECT
      $1, $2, $3, $3,
      ST_Multi(ST_UnaryUnion(ST_Collect(child_version.geom))),
      FALSE, $4, '{}'::JSONB
    FROM geography_relationships relationship
    JOIN geographies child ON child.id = relationship.child_geography_id
    JOIN geography_versions child_version
      ON child_version.geography_id = child.id
      AND child_version.valid_from <= $3
      AND child_version.valid_to >= $3
    WHERE relationship.parent_geography_id = $1
      AND relationship.relationship_type = 'contains'
      AND child.geography_type = $5
    HAVING COUNT(*) > 0
    ON CONFLICT (geography_id, valid_from, valid_to) DO UPDATE SET
      source_artifact_id = EXCLUDED.source_artifact_id,
      geom = EXCLUDED.geom,
      methodology = EXCLUDED.methodology
    RETURNING id
  `, [geographyId, artifactId, validDate, methodology, childType]);
  if (result.rows.length !== 1) throw new Error(`Could not build ${childType} aggregate geometry for geography ${geographyId}`);
}

async function recordFailedRun(runId, startedAt, message) {
  const client = await db.connect();
  try {
    const source = await sourceId(client);
    await client.query(`
      INSERT INTO ingestion_runs (
        id, source_id, started_at, completed_at, status, parser_name, parser_version, message
      ) VALUES ($1, $2, $3, NOW(), 'failed', $4, $5, $6)
      ON CONFLICT (id) DO NOTHING
    `, [runId, source, startedAt, parserName, parserVersion, message.slice(0, 2000)]);
  } finally {
    client.release();
  }
}

async function persistDelaware(client, archive, parsed, { commit, runId, startedAt }) {
  const manifest = delawareManifest;
  const source = await sourceId(client);
  await client.query("SELECT pg_advisory_xact_lock(hashtext('vest:2020:de:import'))");
  await client.query(`
    INSERT INTO ingestion_runs (
      id, source_id, started_at, status, rows_read, parser_name, parser_version, metadata
    ) VALUES ($1, $2, $3, 'running', $4, $5, $6, $7::JSONB)
  `, [
    runId,
    source,
    startedAt,
    parsed.precincts.length,
    parserName,
    parserVersion,
    JSON.stringify({ dryRun: !commit, namespace: manifest.namespace })
  ]);

  const outerArtifact = await ensureArtifact(client, {
    sourceId: source,
    uri: pathToFileURL(archive.resolvedPath).href,
    retrievedAt: archive.retrievedAt,
    sha256: archive.outerSha256,
    byteSize: archive.outerByteSize,
    metadata: { persistentId: 'doi:10.7910/DVN/K7760H', filename: 'dataverse_files.zip' }
  });
  const stateArtifact = await ensureArtifact(client, {
    sourceId: source,
    parentArtifactId: outerArtifact.id,
    uri: `zip://${pathToFileURL(archive.resolvedPath).href}!/${manifest.stateArchive}`,
    retrievedAt: archive.retrievedAt,
    sha256: archive.stateSha256,
    byteSize: archive.stateByteSize,
    metadata: { state: manifest.state.abbreviation, namespace: manifest.namespace }
  });

  const existingBatch = await client.query(`
    SELECT id
    FROM result_batches
    WHERE source_id = $1 AND source_artifact_id = $2
    LIMIT 1
  `, [source, stateArtifact.id]);
  if (existingBatch.rows.length) {
    await client.query(`
      UPDATE ingestion_runs
      SET completed_at = NOW(), status = 'completed', message = 'Artifact already imported; no changes made.'
      WHERE id = $1
    `, [runId]);
    return { alreadyImported: true, batchId: String(existingBatch.rows[0].id) };
  }

  const stateGeographyId = await ensureGeography(client, {
    sourceId: source,
    namespace: manifest.namespace,
    sourceIdentifier: `state:${manifest.state.stateFips}`,
    type: 'state',
    name: manifest.state.name,
    abbreviation: manifest.state.abbreviation,
    stateFips: manifest.state.stateFips
  });
  const houseDistrictId = await ensureGeography(client, {
    sourceId: source,
    namespace: manifest.namespace,
    sourceIdentifier: 'congressional-district:AL',
    type: 'congressional_district',
    name: 'Delaware Congressional District At-Large',
    abbreviation: 'DE-AL',
    stateFips: manifest.state.stateFips,
    metadata: { districtLabel: 'At-Large' }
  });
  await linkGeographies(client, stateGeographyId, houseDistrictId, manifest.election.date);

  const precinctGeographyIds = new Map();
  const geometryRepairs = [];
  for (const precinct of parsed.precincts) {
    const geographyId = await ensureGeography(client, {
      sourceId: source,
      namespace: manifest.namespace,
      sourceIdentifier: `precinct:${precinct.sourceIdentifier}`,
      type: 'precinct',
      name: precinct.name,
      abbreviation: precinct.sourceIdentifier,
      stateFips: manifest.state.stateFips,
      metadata: { vestPrecinct: precinct.sourceIdentifier }
    });
    precinctGeographyIds.set(precinct.sourceIdentifier, geographyId);
    const geometryResult = await upsertGeographyVersion(client, {
      geographyId,
      artifactId: stateArtifact.id,
      validDate: manifest.election.date,
      geometry: precinct.geometry,
      methodology: 'VEST 2020 election precinct boundary transformed from source WKT to EPSG:4326.',
      metadata: { sourceCrs: archive.prj }
    });
    if (geometryResult.was_repaired) {
      geometryRepairs.push({ precinct: precinct.sourceIdentifier, reason: geometryResult.invalid_reason });
    }
    await linkGeographies(client, stateGeographyId, geographyId, manifest.election.date);
    await linkGeographies(client, houseDistrictId, geographyId, manifest.election.date);
  }

  await buildAggregateGeometry(
    client,
    stateGeographyId,
    'precinct',
    stateArtifact.id,
    manifest.election.date,
    'Union of VEST 2020 Delaware precinct geometries.'
  );
  await buildAggregateGeometry(
    client,
    houseDistrictId,
    'precinct',
    stateArtifact.id,
    manifest.election.date,
    'At-large district represented by the union of VEST 2020 Delaware precinct geometries.'
  );

  const electionId = await ensureElection(client, source, stateGeographyId);
  const contestMappings = [];
  for (const contestManifest of manifest.contests) {
    const districtGeographyId = contestManifest.district === 'at_large' ? houseDistrictId : stateGeographyId;
    const contest = await ensureContest(client, {
      sourceId: source,
      namespace: manifest.namespace,
      sourceIdentifier: contestManifest.sourceIdentifier,
      electionId,
      districtGeographyId,
      name: contestManifest.name,
      districtLabel: contestManifest.district === 'at_large' ? 'At-Large' : 'Statewide',
      officeSlug: contestManifest.officeSlug,
      metadata: contestManifest.officeSlug === 'president'
        ? { sourceRepresentsPresidentialCandidateOnly: true }
        : {}
    });
    const choices = [];
    for (const choiceManifest of contestManifest.choices) {
      const candidateIdentity = contestManifest.officeSlug === 'president'
        ? resolvePresidentialCandidate(choiceManifest.candidateKey, choiceManifest.name)
        : { canonicalName: choiceManifest.name };
      const id = await ensureChoice(client, {
        ...choiceManifest,
        ...candidateIdentity,
        sourceId: source,
        namespace: manifest.namespace,
        contestId: contest.id,
        officeId: contest.officeId
      });
      choices.push({ ...choiceManifest, id });
    }
    contestMappings.push({ ...contestManifest, id: contest.id, districtGeographyId, choices });
  }

  const batch = await row(client, `
    INSERT INTO result_batches (
      source_id, source_artifact_id, ingestion_run_id, reported_at, retrieved_at, status, metadata
    ) VALUES ($1, $2, $3, NULL, $4, 'research_dataset', $5::JSONB)
    RETURNING id
  `, [
    source,
    stateArtifact.id,
    runId,
    archive.retrievedAt,
    JSON.stringify({
      underlyingSources: ['Delaware Department of Elections', 'Delaware FirstMap GIS'],
      exactSourceReportTimeKnown: false,
      includesAllocatedVotes: manifest.allocation.isEstimated
    })
  ]);

  const snapshotIds = [];
  for (const contest of contestMappings) {
    const snapshot = await row(client, `
      INSERT INTO result_snapshots (
        batch_id, contest_id, reporting_basis, reporting_value, reported_units, total_units, metadata
      ) VALUES ($1, $2, 'precincts', 100, $3, $3, $4::JSONB)
      RETURNING id
    `, [
      batch.id,
      contest.id,
      parsed.precincts.length,
      JSON.stringify({ sourceCompleteness: 'complete VEST state archive' })
    ]);
    contest.snapshotId = snapshot.id;
    snapshotIds.push(snapshot.id);
  }

  const detailSnapshotIds = [];
  const detailReportingUnitIds = [];
  const detailChoiceIds = [];
  const detailVotes = [];
  for (const precinct of parsed.precincts) {
    const geographyId = precinctGeographyIds.get(precinct.sourceIdentifier);
    for (const contest of contestMappings) {
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
  `, [
    detailSnapshotIds,
    detailReportingUnitIds,
    detailChoiceIds,
    detailVotes,
    manifest.allocation.method
  ]);

  const statusSnapshotIds = [];
  const statusReportingUnitIds = [];
  for (const contest of contestMappings) {
    for (const geographyId of precinctGeographyIds.values()) {
      statusSnapshotIds.push(contest.snapshotId);
      statusReportingUnitIds.push(geographyId);
    }
  }
  await client.query(`
    INSERT INTO reporting_unit_statuses (
      snapshot_id, reporting_unit_id, vote_type, count_status,
      reporting_basis, reporting_value, metadata
    )
    SELECT
      values.snapshot_id, values.reporting_unit_id, 'total', 'complete',
      'precincts', 100, '{}'::JSONB
    FROM UNNEST($1::UUID[], $2::UUID[]) AS values(snapshot_id, reporting_unit_id)
  `, [statusSnapshotIds, statusReportingUnitIds]);

  for (const contest of contestMappings) {
    for (const choice of contest.choices) {
      await client.query(`
        INSERT INTO vote_totals (
          snapshot_id, reporting_unit_id, contest_choice_id, vote_type, round,
          votes, is_estimated, tabulation_method, allocation_method, vote_status, metadata
        ) VALUES ($1, $2, $3, 'total', 0, $4, TRUE, 'sum_of_reporting_units', $5, 'reported', $6::JSONB)
      `, [
        contest.snapshotId,
        contest.districtGeographyId,
        choice.id,
        parsed.totals[choice.column],
        manifest.allocation.method,
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

  const resultCounts = await row(client, `
    SELECT
      COUNT(*)::INTEGER AS total,
      COUNT(*) FILTER (WHERE tabulation_method = 'allocated')::INTEGER AS detail,
      COUNT(*) FILTER (WHERE tabulation_method = 'sum_of_reporting_units')::INTEGER AS summaries
    FROM vote_totals
    WHERE snapshot_id = ANY($1::UUID[])
  `, [snapshotIds]);
  const expectedDetail = manifest.expectedPrecincts * manifest.contests.reduce((sum, contest) => sum + contest.choices.length, 0);
  const expectedSummaries = manifest.contests.reduce((sum, contest) => sum + contest.choices.length, 0);
  if (resultCounts.detail !== expectedDetail || resultCounts.summaries !== expectedSummaries) {
    throw new Error(`Unexpected vote-total counts: ${JSON.stringify(resultCounts)}`);
  }

  await client.query(`
    UPDATE ingestion_runs
    SET
      completed_at = NOW(),
      status = 'completed_with_warnings',
      rows_added = $2,
      warning_count = $3,
      message = $4,
      source_artifact_id = $5
    WHERE id = $1
  `, [
    runId,
    resultCounts.total,
    1 + geometryRepairs.length,
    `Imported complete Delaware VEST fixture with ${geometryRepairs.length} geometry repair(s); ${manifest.allocation.method}`,
    stateArtifact.id
  ]);

    return {
    alreadyImported: false,
    batchId: String(batch.id),
    precincts: parsed.precincts.length,
    contests: contestMappings.length,
    choices: expectedSummaries,
    detailVoteTotals: resultCounts.detail,
    summaryVoteTotals: resultCounts.summaries,
    reportingStatuses: statusSnapshotIds.length,
    validGeometries: parsed.precincts.length + 2,
    geometryRepairs
  };
}

export async function importDelaware({ archivePath, commit = false }) {
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  const archive = await openStateArchive(archivePath, delawareManifest);
  const parsed = await readDelaware(archive);
  const client = await db.connect();

  try {
    await client.query('BEGIN');
    const persisted = await persistDelaware(client, archive, parsed, { commit, runId, startedAt });
    if (commit) await client.query('COMMIT');
    else await client.query('ROLLBACK');

    const result = {
      mode: commit ? 'committed' : 'dry-run',
      rolledBack: !commit,
      runId,
      namespace: delawareManifest.namespace,
      archive: {
        path: archive.resolvedPath,
        outerSha256: archive.outerSha256,
        stateSha256: archive.stateSha256
      },
      bounds: parsed.bounds,
      totals: parsed.totals,
      presidentialCandidateIds: Object.fromEntries(
        delawareManifest.contests
          .find(contest => contest.officeSlug === 'president')
          .choices
          .map(choice => [choice.candidateKey, candidateUuid(choice.candidateKey)])
      ),
      ...persisted
    };
    if (!commit && !persisted.alreadyImported) result.batchId = null;
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    if (commit) {
      try {
        await recordFailedRun(runId, startedAt, error.message);
      } catch (recordError) {
        error.message += `; additionally failed to record ingestion failure: ${recordError.message}`;
      }
    }
    throw error;
  } finally {
    client.release();
  }
}
