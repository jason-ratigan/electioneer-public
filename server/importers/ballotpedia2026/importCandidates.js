import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { candidateUuid } from '../../identity/candidateUuid.js';
import { slugifyCandidateName } from '../vest2020/readState.js';
import { db } from '../../db.js';

const cycle = 2026;
export const candidateRosterNamespace = 'ballotpedia:2026:congressional-roster';
const excludedJurisdictions = new Set([
  'American Samoa', 'Guam', 'Northern Mariana Islands', 'Virgin Islands'
]);

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

export function candidateKey(row, state, districtAbbreviation) {
  const office = row.chamber === 'House' ? 'house' : 'senate';
  const district = row.chamber === 'House'
    ? districtAbbreviation.replace(`${state.abbreviation}-`, '').toLowerCase()
    : 'statewide';
  return `bp26-${state.abbreviation.toLowerCase()}-${office}-${district}-${slugifyCandidateName(row.candidateName)}`;
}

export function candidateRosterSourceIdentifier(row, state, districtAbbreviation) {
  return [
    state.abbreviation,
    row.chamber.toLowerCase(),
    row.chamber === 'House' ? districtAbbreviation : 'statewide',
    row.candidateName.toLowerCase(),
    row.candidateParty.toLowerCase()
  ].join('|');
}

export function normalizedParty(rawLabel) {
  if (/^democratic(?:,|$)/i.test(rawLabel)) return { name: 'Democratic Party', abbreviation: 'D' };
  if (/^republican(?:,|$)/i.test(rawLabel)) return { name: 'Republican Party', abbreviation: 'R' };
  if (/^libertarian(?:,|$)/i.test(rawLabel)) return { name: 'Libertarian Party', abbreviation: 'L' };
  if (/^green(?:,|$)/i.test(rawLabel)) return { name: 'Green Party', abbreviation: 'G' };
  if (/^nonpartisan$/i.test(rawLabel)) return { name: 'Nonpartisan', abbreviation: 'N' };
  if (/^(?:independent|unaffiliated|undeclared|unenrolled|no party affiliation|no party preference|no political party)$/i.test(rawLabel)) {
    return { name: 'Independent', abbreviation: 'I' };
  }
  return { name: rawLabel, abbreviation: 'O' };
}

export async function ensureParty(client, cache, rawLabel) {
  const normalized = normalizedParty(rawLabel);
  if (cache.has(normalized.name)) return cache.get(normalized.name);
  const party = await one(client, `
    INSERT INTO parties (name, abbreviation, metadata)
    VALUES ($1, $2, $3::JSONB)
    ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `, [normalized.name, normalized.abbreviation, JSON.stringify({ sourceLabel: rawLabel })]);
  cache.set(normalized.name, party.id);
  return party.id;
}

export async function ensureCandidate(client, sourceId, row, state, districtAbbreviation) {
  const canonicalKey = candidateKey(row, state, districtAbbreviation);
  const expectedId = candidateUuid(canonicalKey);
  const candidate = await one(client, `
    INSERT INTO candidates (id, canonical_key, canonical_name, metadata)
    VALUES ($1, $2, $3, $4::JSONB)
    ON CONFLICT (canonical_key) DO UPDATE SET canonical_name = candidates.canonical_name
    RETURNING id
  `, [
    expectedId,
    canonicalKey,
    row.candidateName,
    JSON.stringify({ identityStatus: 'provisional', discoveredBy: 'ballotpedia', cycle })
  ]);
  if (candidate.id !== expectedId) throw new Error(`Candidate UUID mismatch for ${canonicalKey}`);
  await client.query(`
    INSERT INTO candidate_source_ids (
      candidate_id, source_id, identifier_namespace, source_identifier
    ) VALUES ($1, $2, $3, $4)
    ON CONFLICT (source_id, identifier_namespace, source_identifier) DO UPDATE SET
      candidate_id = EXCLUDED.candidate_id
  `, [candidate.id, sourceId, candidateRosterNamespace, candidateRosterSourceIdentifier(row, state, districtAbbreviation)]);
  return candidate.id;
}

export async function importCandidateRoster({ filePath, parsed, commit = false }) {
  const resolvedPath = path.resolve(filePath);
  const fileStat = await stat(resolvedPath);
  const checksum = await sha256File(resolvedPath);
  const client = await db.connect();
  const runId = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['ballotpedia:2026:congressional-roster']);
    const source = await one(client, "SELECT id FROM data_sources WHERE slug = 'ballotpedia'");
    const artifact = await one(client, `
      INSERT INTO source_artifacts (
        source_id, uri, retrieved_at, sha256, byte_size, content_type,
        source_version, metadata
      ) VALUES ($1, $2, $3, $4, $5, 'text/csv', '2026 congressional candidate roster', $6::JSONB)
      ON CONFLICT (source_id, sha256) WHERE sha256 IS NOT NULL DO UPDATE SET
        uri = EXCLUDED.uri,
        retrieved_at = EXCLUDED.retrieved_at,
        metadata = source_artifacts.metadata || EXCLUDED.metadata
      RETURNING id
    `, [
      source.id,
      pathToFileURL(resolvedPath).href,
      fileStat.mtime.toISOString(),
      checksum,
      fileStat.size,
      JSON.stringify({ userProvided: true, authority: 'secondary' })
    ]);
    await client.query(`
      INSERT INTO ingestion_runs (
        id, source_id, source_artifact_id, started_at, status, rows_read,
        parser_name, parser_version, metadata
      ) VALUES ($1, $2, $3, NOW(), 'running', $4, $5, '1.0.0', $6::JSONB)
    `, [
      runId,
      source.id,
      artifact.id,
      parsed.rowCount,
      'ballotpedia-2026-congressional-roster',
      JSON.stringify({ dryRun: !commit, sourceRaceCount: parsed.raceCount })
    ]);

    const stateRows = await client.query(`
      SELECT id, name, abbreviation, state_fips
      FROM geographies
      WHERE geography_type = 'state'
    `);
    const states = new Map(stateRows.rows.map(state => [state.name.toLowerCase(), state]));
    const districtRows = await client.query(`
      SELECT geography.id, geography.abbreviation
      FROM geography_source_ids source_id
      JOIN geographies geography ON geography.id = source_id.geography_id
      WHERE source_id.identifier_namespace = 'census:120:cd120'
    `);
    const districts = new Map(districtRows.rows.map(district => [district.abbreviation, district]));
    const officeRows = await client.query(`
      SELECT id, slug FROM offices WHERE slug = ANY($1::TEXT[])
    `, [['us_house', 'us_senate']]);
    const offices = new Map(officeRows.rows.map(office => [office.slug, office.id]));
    if (offices.size !== 2) throw new Error('House and Senate office seeds are required');
    if (districts.size !== 436) throw new Error(`Expected 436 CD120 district identities; received ${districts.size}`);

    const included = [];
    const excluded = [];
    for (const row of parsed.rows) {
      if (excludedJurisdictions.has(row.state)) {
        excluded.push(row);
        continue;
      }
      const state = states.get(row.state.toLowerCase());
      if (!state) throw new Error(`Candidate state is not in the application geography: ${row.state}`);
      const districtAbbreviation = row.chamber === 'House'
        ? `${state.abbreviation}-${row.district === 'At-large' ? 'AL' : row.district.padStart(2, '0')}`
        : state.abbreviation;
      const district = row.chamber === 'House' ? districts.get(districtAbbreviation) : state;
      if (!district) throw new Error(`No CD120 geography for ${districtAbbreviation}`);
      included.push({ row, state, district, districtAbbreviation });
    }
    const raceKeys = new Set(included.map(item => [
      item.row.chamber,
      item.district.id
    ].join('\u001f')));
    const houseRaces = new Set(included.filter(item => item.row.chamber === 'House').map(item => item.district.id));
    const senateRaces = new Set(included.filter(item => item.row.chamber === 'Senate').map(item => item.district.id));
    if (houseRaces.size !== 436 || senateRaces.size !== 33 || raceKeys.size !== 469) {
      throw new Error(`Expected 436 House and 33 Senate races; received ${houseRaces.size} and ${senateRaces.size}`);
    }

    await client.query(`
      DELETE FROM candidate_roster_entries
      WHERE source_id = $1 AND cycle = $2 AND identifier_namespace = $3
      AND roster_status <> 'general_candidate'
    `, [source.id, cycle, candidateRosterNamespace]);
    const partyCache = new Map();
    const canonicalCandidates = new Map();
    for (const item of included) {
      const partyId = await ensureParty(client, partyCache, item.row.candidateParty);
      const key = candidateKey(item.row, item.state, item.districtAbbreviation);
      const previousName = canonicalCandidates.get(key);
      if (previousName && previousName !== item.row.candidateName) {
        throw new Error(`Provisional identity collision: ${previousName} and ${item.row.candidateName}`);
      }
      canonicalCandidates.set(key, item.row.candidateName);
      const candidateId = await ensureCandidate(
        client, source.id, item.row, item.state, item.districtAbbreviation
      );
      await client.query(`
        INSERT INTO candidate_roster_entries (
          cycle, office_id, district_geography_id, candidate_id, party_id,
          source_id, source_artifact_id, identifier_namespace, source_identifier,
          candidate_name, party_label, roster_status, metadata
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'source_listed', $12::JSONB
        )
        ON CONFLICT (source_id, identifier_namespace, source_identifier) DO UPDATE SET
          source_artifact_id = CASE
            WHEN candidate_roster_entries.roster_status = 'general_candidate'
              THEN candidate_roster_entries.source_artifact_id
            ELSE EXCLUDED.source_artifact_id
          END,
          candidate_name = EXCLUDED.candidate_name,
          party_label = EXCLUDED.party_label,
          metadata = CASE
            WHEN candidate_roster_entries.roster_status = 'general_candidate'
              THEN EXCLUDED.metadata || candidate_roster_entries.metadata
            ELSE candidate_roster_entries.metadata || EXCLUDED.metadata
          END,
          updated_at = NOW()
      `, [
        cycle,
        offices.get(item.row.chamber === 'House' ? 'us_house' : 'us_senate'),
        item.district.id,
        candidateId,
        partyId,
        source.id,
        artifact.id,
        candidateRosterNamespace,
        candidateRosterSourceIdentifier(item.row, item.state, item.districtAbbreviation),
        item.row.candidateName,
        item.row.candidateParty,
        JSON.stringify({
          sourceLine: item.row.sourceLine,
          chamber: item.row.chamber,
          districtLabel: item.row.district,
          identityStatus: 'provisional',
          nominationStatus: 'unknown'
        })
      ]);
    }

    const warningCount = excluded.length;
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
      included.length,
      warningCount,
      `Loaded ${included.length} provisional candidate roster entries for 469 congressional races.`,
      JSON.stringify({
        houseRaces: houseRaces.size,
        senateRaces: senateRaces.size,
        provisionalCandidates: canonicalCandidates.size,
        excludedTerritoryRows: excluded.length,
        partyLabels: parsed.partyLabelCount
      })
    ]);
    if (commit) await client.query('COMMIT');
    else await client.query('ROLLBACK');
    return {
      mode: commit ? 'committed' : 'dry-run',
      sourceRows: parsed.rowCount,
      rosterEntries: included.length,
      provisionalCandidates: canonicalCandidates.size,
      houseRaces: houseRaces.size,
      senateRaces: senateRaces.size,
      excludedTerritoryRows: excluded.length,
      partyLabels: parsed.partyLabelCount,
      artifactId: String(artifact.id)
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
