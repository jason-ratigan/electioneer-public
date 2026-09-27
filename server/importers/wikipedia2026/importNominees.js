import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { db } from '../../db.js';
import { candidateUuid } from '../../identity/candidateUuid.js';
import { ensureParty, normalizedParty } from '../ballotpedia2026/importCandidates.js';
import { slugifyCandidateName } from '../vest2020/readState.js';
import { identityName } from './readNominees.js';

const cycle = 2026;
const rosterNamespace = 'wikipedia:en:2026-general';
const wikipediaProfileNamespace = 'wikipedia:en:page-url';
const fecCandidateNamespace = 'fec:candidate-id';

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function one(client, sql, params = []) {
  const result = await client.query(sql, params);
  if (result.rows.length !== 1) throw new Error(`Expected one database row; received ${result.rows.length}`);
  return result.rows[0];
}

function sameParty(left, right) {
  const canonical = value => {
    const cleaned = (value || '').replace(/\[\s*[a-z0-9]+\s*\]/gi, '').trim();
    if (/^(?:no party listed|no party preference|unaffiliated)$/i.test(cleaned)) return 'Independent';
    if (/^democratic \(dfl\)$/i.test(cleaned)) return 'Democratic Party';
    return normalizedParty(cleaned).name;
  };
  return canonical(left) === canonical(right);
}

function candidateKey(row, state, districtAbbreviation) {
  const office = row.chamber === 'House' ? 'house' : 'senate';
  const district = row.chamber === 'House'
    ? districtAbbreviation.replace(`${state.abbreviation}-`, '').toLowerCase()
    : 'statewide';
  return `wiki26-${state.abbreviation.toLowerCase()}-${office}-${district}-${slugifyCandidateName(row.candidateName)}`;
}

function rosterIdentifier(row, state, districtAbbreviation) {
  return [
    state.abbreviation,
    row.chamber.toLowerCase(),
    row.chamber === 'House' ? districtAbbreviation : 'statewide',
    identityName(row.candidateName)
  ].join('|');
}

async function aliasCandidate(client, sourceId, namespace, identifier) {
  if (!identifier) return null;
  const result = await client.query(`
    SELECT candidate_id
    FROM candidate_source_ids
    WHERE source_id = $1 AND identifier_namespace = $2 AND source_identifier = $3
  `, [sourceId, namespace, identifier]);
  return result.rows[0]?.candidate_id || null;
}

async function attachAlias(client, sourceId, namespace, identifier, candidateId) {
  if (!identifier) return;
  const existing = await aliasCandidate(client, sourceId, namespace, identifier);
  if (existing && existing !== candidateId) {
    throw new Error(`${namespace} ${identifier} is already assigned to a different candidate`);
  }
  await client.query(`
    INSERT INTO candidate_source_ids (
      candidate_id, source_id, identifier_namespace, source_identifier
    ) VALUES ($1, $2, $3, $4)
    ON CONFLICT (source_id, identifier_namespace, source_identifier) DO NOTHING
  `, [candidateId, sourceId, namespace, identifier]);
}

async function matchCandidate(client, sources, item) {
  const aliasMatches = new Map();
  const addAliasMatch = (candidateId, method) => {
    if (candidateId) aliasMatches.set(candidateId, method);
  };
  addAliasMatch(
    await aliasCandidate(client, sources.fec, fecCandidateNamespace, item.row.fecCandidateId),
    'fec_candidate_id'
  );
  addAliasMatch(
    await aliasCandidate(client, sources.wikipedia, wikipediaProfileNamespace, item.row.candidateUrl),
    'wikipedia_profile_url'
  );
  if (aliasMatches.size > 1) {
    throw new Error(`FEC and Wikipedia identities conflict for ${item.row.candidateName}`);
  }
  if (aliasMatches.size === 1) {
    const [candidateId, method] = aliasMatches.entries().next().value;
    return { candidateId, method };
  }

  const rosterRows = (await client.query(`
    SELECT candidate_id, candidate_name, party_label
    FROM candidate_roster_entries
    WHERE cycle = $1 AND office_id = $2 AND district_geography_id = $3
  `, [cycle, item.officeId, item.district.id])).rows;
  const candidates = new Set(rosterRows.filter(row =>
    identityName(row.candidate_name) === identityName(item.row.candidateName)
    && sameParty(row.party_label, item.row.candidateParty)
  ).map(row => row.candidate_id));
  if (candidates.size > 1) {
    throw new Error(`Ambiguous race-local identity for ${item.row.candidateName}`);
  }
  if (candidates.size === 1) return { candidateId: [...candidates][0], method: 'race_name_and_party' };
  return { candidateId: null, method: 'new_candidate' };
}

async function createCandidate(client, item) {
  const canonicalKey = candidateKey(item.row, item.state, item.districtAbbreviation);
  const expectedId = candidateUuid(canonicalKey);
  const candidate = await one(client, `
    INSERT INTO candidates (id, canonical_key, canonical_name, metadata)
    VALUES ($1, $2, $3, $4::JSONB)
    ON CONFLICT (canonical_key) DO UPDATE SET canonical_name = candidates.canonical_name
    RETURNING id
  `, [
    expectedId,
    canonicalKey,
    item.row.candidateName,
    JSON.stringify({ identityStatus: 'provisional', discoveredBy: 'wikipedia', cycle })
  ]);
  if (candidate.id !== expectedId) throw new Error(`Candidate UUID mismatch for ${canonicalKey}`);
  return candidate.id;
}

export async function importWikimediaNominees({ filePath, parsed, manifest, commit = false }) {
  if (!manifest.complete || manifest.errorCount !== 0) {
    throw new Error('Refusing to import an incomplete Wikimedia collection');
  }
  if (manifest.nomineeCount !== parsed.rowCount
    || manifest.houseRaceCount !== parsed.houseRaceCount
    || manifest.senateRaceCount !== parsed.senateRaceCount) {
    throw new Error('Wikimedia manifest does not match the nominee CSV');
  }
  if (parsed.houseRaceCount !== 436 || parsed.senateRaceCount !== 33 || parsed.raceCount !== 469) {
    throw new Error(
      `Expected nominees for 436 House and 33 Senate races; received ${parsed.houseRaceCount} and ${parsed.senateRaceCount}`
    );
  }
  if (manifest.license !== 'CC BY-SA 4.0' || !manifest.fecFile?.sha256) {
    throw new Error('Wikimedia license or FEC artifact metadata is missing');
  }

  const resolvedPath = path.resolve(filePath);
  const fileStat = await stat(resolvedPath);
  const checksum = await sha256File(resolvedPath);
  const runId = randomUUID();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['wikipedia:2026:general-nominees']);
    const sourceRows = (await client.query(`
      SELECT id, slug FROM data_sources WHERE slug = ANY($1::TEXT[])
    `, [['wikipedia', 'fec']])).rows;
    const sources = Object.fromEntries(sourceRows.map(source => [source.slug, source.id]));
    if (!sources.wikipedia || !sources.fec) throw new Error('Wikipedia and FEC data-source seeds are required');

    const artifact = await one(client, `
      INSERT INTO source_artifacts (
        source_id, uri, retrieved_at, sha256, byte_size, content_type,
        source_version, license, metadata
      ) VALUES ($1, $2, $3, $4, $5, 'text/csv', $6, $7, $8::JSONB)
      ON CONFLICT (source_id, sha256) WHERE sha256 IS NOT NULL DO UPDATE SET
        uri = EXCLUDED.uri,
        retrieved_at = EXCLUDED.retrieved_at,
        metadata = source_artifacts.metadata || EXCLUDED.metadata
      RETURNING id
    `, [
      sources.wikipedia,
      pathToFileURL(resolvedPath).href,
      manifest.scrapedAt,
      checksum,
      fileStat.size,
      `House revision ${manifest.housePage.revisionId}; 33 Senate article revisions`,
      manifest.license,
      JSON.stringify({
        authority: 'secondary',
        generatedBy: 'fetch_nominees.py',
        licenseUrl: manifest.licenseUrl,
        housePage: manifest.housePage,
        senateIndexPage: manifest.senateIndexPage,
        senatePages: manifest.senatePages,
        manifest
      })
    ]);
    const fecArtifact = await one(client, `
      INSERT INTO source_artifacts (
        source_id, uri, retrieved_at, sha256, byte_size, content_type,
        source_version, metadata
      ) VALUES ($1, $2, $3, $4, $5, 'application/zip', '2026 candidate master', $6::JSONB)
      ON CONFLICT (source_id, sha256) WHERE sha256 IS NOT NULL DO UPDATE SET
        uri = EXCLUDED.uri,
        retrieved_at = EXCLUDED.retrieved_at,
        metadata = source_artifacts.metadata || EXCLUDED.metadata
      RETURNING id
    `, [
      sources.fec,
      manifest.fecFile.url,
      manifest.scrapedAt,
      manifest.fecFile.sha256,
      manifest.fecFile.byteSize,
      JSON.stringify({ candidateRows: manifest.fecCandidateRows, notBallotQualification: true })
    ]);
    await client.query(`
      INSERT INTO ingestion_runs (
        id, source_id, source_artifact_id, started_at, status, rows_read,
        parser_name, parser_version, metadata
      ) VALUES ($1, $2, $3, NOW(), 'running', $4, $5, '1.0.0', $6::JSONB)
    `, [
      runId,
      sources.wikipedia,
      artifact.id,
      parsed.rowCount,
      'wikimedia-fec-2026-general-candidates',
      JSON.stringify({ dryRun: !commit, fecArtifactId: String(fecArtifact.id), manifest })
    ]);

    const states = new Map((await client.query(`
      SELECT id, name, abbreviation FROM geographies WHERE geography_type = 'state'
    `)).rows.map(state => [state.name.toLowerCase(), state]));
    const districts = new Map((await client.query(`
      SELECT geography.id, geography.abbreviation
      FROM geography_source_ids source_id
      JOIN geographies geography ON geography.id = source_id.geography_id
      WHERE source_id.identifier_namespace = 'census:120:cd120'
    `)).rows.map(district => [district.abbreviation, district]));
    const offices = new Map((await client.query(`
      SELECT id, slug FROM offices WHERE slug = ANY($1::TEXT[])
    `, [['us_house', 'us_senate']])).rows.map(office => [office.slug, office.id]));
    if (districts.size !== 436) throw new Error(`Expected 436 CD120 district identities; received ${districts.size}`);
    if (offices.size !== 2) throw new Error('House and Senate office seeds are required');

    const mappedRows = parsed.rows.map(row => {
      const state = states.get(row.state.toLowerCase());
      if (!state) throw new Error(`Candidate state is not in application geography: ${row.state}`);
      const districtAbbreviation = row.chamber === 'House'
        ? `${state.abbreviation}-${row.district === 'At-large' ? 'AL' : row.district.padStart(2, '0')}`
        : state.abbreviation;
      const district = row.chamber === 'House' ? districts.get(districtAbbreviation) : state;
      if (!district) throw new Error(`No CD120 geography for ${districtAbbreviation}`);
      return {
        row,
        state,
        district,
        districtAbbreviation,
        officeId: offices.get(row.chamber === 'House' ? 'us_house' : 'us_senate')
      };
    });

    const partyCache = new Map();
    const matchCounts = {
      fec_candidate_id: 0,
      wikipedia_profile_url: 0,
      race_name_and_party: 0,
      new_candidate: 0
    };
    let added = 0;
    let updated = 0;
    const statusCounts = { general_candidate: 0, source_listed: 0 };
    for (const item of mappedRows) {
      const matched = await matchCandidate(client, sources, item);
      const candidateId = matched.candidateId || await createCandidate(client, item);
      await attachAlias(
        client, sources.wikipedia, wikipediaProfileNamespace, item.row.candidateUrl, candidateId
      );
      if (item.row.fecCandidateId && ['exact_name', 'first_last'].includes(item.row.fecMatchMethod)) {
        await attachAlias(
          client, sources.fec, fecCandidateNamespace, item.row.fecCandidateId, candidateId
        );
      }
      const partyId = await ensureParty(client, partyCache, item.row.candidateParty);
      const sourceIdentifier = rosterIdentifier(item.row, item.state, item.districtAbbreviation);
      const rosterStatus = ['general_results_table', 'nominee', 'general_candidate']
        .includes(item.row.sourceStatus) ? 'general_candidate' : 'source_listed';
      const existing = (await client.query(`
        SELECT id
        FROM candidate_roster_entries
        WHERE source_id = $1 AND cycle = $2 AND office_id = $3
          AND district_geography_id = $4 AND candidate_id = $5
        LIMIT 1
      `, [sources.wikipedia, cycle, item.officeId, item.district.id, candidateId])).rows[0];
      const evidence = {
        nominationStatus: rosterStatus,
        nominationAuthority: 'secondary',
        raceWikipediaUrl: item.row.raceUrl,
        candidateWikipediaUrl: item.row.candidateUrl || null,
        officialSourceUrl: item.row.officialSourceUrl || null,
        sourcePageTitle: item.row.sourcePageTitle,
        sourcePageId: item.row.sourcePageId,
        sourceRevisionId: item.row.sourceRevisionId,
        extractionMethod: item.row.extractionMethod,
        sourceStatus: item.row.sourceStatus,
        observedAt: item.row.scrapedAt,
        identityMatchMethod: matched.method,
        fecCandidateId: item.row.fecCandidateId || null,
        fecMatchMethod: item.row.fecMatchMethod,
        fecArtifactId: String(fecArtifact.id)
      };
      if (existing) {
        await client.query(`
          UPDATE candidate_roster_entries
          SET party_id = $2, source_artifact_id = $3, identifier_namespace = $4,
              source_identifier = $5, candidate_name = $6, party_label = $7,
              roster_status = $8, metadata = metadata || $9::JSONB,
              updated_at = NOW()
          WHERE id = $1
        `, [
          existing.id, partyId, artifact.id, rosterNamespace, sourceIdentifier,
          item.row.candidateName, item.row.candidatePartyRaw, rosterStatus, JSON.stringify(evidence)
        ]);
        updated += 1;
      } else {
        await client.query(`
          INSERT INTO candidate_roster_entries (
            cycle, office_id, district_geography_id, candidate_id, party_id,
            source_id, source_artifact_id, identifier_namespace, source_identifier,
            candidate_name, party_label, roster_status, metadata
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::JSONB)
          ON CONFLICT (source_id, identifier_namespace, source_identifier) DO UPDATE SET
            candidate_id = EXCLUDED.candidate_id,
            party_id = EXCLUDED.party_id,
            source_artifact_id = EXCLUDED.source_artifact_id,
            candidate_name = EXCLUDED.candidate_name,
            party_label = EXCLUDED.party_label,
            roster_status = EXCLUDED.roster_status,
            metadata = candidate_roster_entries.metadata || EXCLUDED.metadata,
            updated_at = NOW()
        `, [
          cycle, item.officeId, item.district.id, candidateId, partyId,
          sources.wikipedia, artifact.id, rosterNamespace, sourceIdentifier,
          item.row.candidateName, item.row.candidatePartyRaw, rosterStatus, JSON.stringify(evidence)
        ]);
        added += 1;
      }
      statusCounts[rosterStatus] += 1;
      matchCounts[matched.method] += 1;
    }

    await client.query(`
      UPDATE ingestion_runs
      SET completed_at = NOW(), status = 'completed', rows_added = $2,
          rows_updated = $3, message = $4, metadata = metadata || $5::JSONB
      WHERE id = $1
    `, [
      runId,
      added,
      updated,
      `Reconciled ${parsed.rowCount} Wikimedia-listed 2026 general-election candidates.`,
      JSON.stringify({ matchCounts, statusCounts, fecArtifactId: String(fecArtifact.id) })
    ]);
    if (commit) await client.query('COMMIT');
    else await client.query('ROLLBACK');
    return {
      mode: commit ? 'committed' : 'dry-run',
      candidates: parsed.rowCount,
      houseRaces: parsed.houseRaceCount,
      senateRaces: parsed.senateRaceCount,
      added,
      updated,
      matchCounts,
      statusCounts,
      artifactId: String(artifact.id),
      fecArtifactId: String(fecArtifact.id)
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
