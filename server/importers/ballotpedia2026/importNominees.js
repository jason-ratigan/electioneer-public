import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { db } from '../../db.js';
import {
  candidateRosterNamespace,
  candidateRosterSourceIdentifier,
  ensureCandidate,
  ensureParty,
  normalizedParty
} from './importCandidates.js';
import { identityName } from './readNominees.js';

const cycle = 2026;
const profileNamespace = 'ballotpedia:profile-url';

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
  return normalizedParty(left || '').name === normalizedParty(right || '').name;
}

async function attachProfileAlias(client, sourceId, candidateId, candidateUrl) {
  const existing = await client.query(`
    SELECT candidate_id
    FROM candidate_source_ids
    WHERE source_id = $1 AND identifier_namespace = $2 AND source_identifier = $3
  `, [sourceId, profileNamespace, candidateUrl]);
  if (existing.rows.length && existing.rows[0].candidate_id !== candidateId) {
    throw new Error(`Ballotpedia profile is already assigned to a different candidate: ${candidateUrl}`);
  }
  await client.query(`
    INSERT INTO candidate_source_ids (
      candidate_id, source_id, identifier_namespace, source_identifier
    ) VALUES ($1, $2, $3, $4)
    ON CONFLICT (source_id, identifier_namespace, source_identifier) DO NOTHING
  `, [candidateId, sourceId, profileNamespace, candidateUrl]);
}

async function matchCandidate(client, sourceId, item) {
  const profileMatch = await client.query(`
    SELECT candidate_id
    FROM candidate_source_ids
    WHERE source_id = $1 AND identifier_namespace = $2 AND source_identifier = $3
  `, [sourceId, profileNamespace, item.row.candidateUrl]);
  const rosterRows = (await client.query(`
    SELECT id, candidate_id, candidate_name, party_label, source_artifact_id, metadata
    FROM candidate_roster_entries
    WHERE cycle = $1 AND office_id = $2 AND district_geography_id = $3
  `, [cycle, item.officeId, item.district.id])).rows;

  if (profileMatch.rows.length) {
    const candidateId = profileMatch.rows[0].candidate_id;
    const roster = rosterRows.find(row => row.candidate_id === candidateId) || null;
    if (roster) return { candidateId, roster, matchMethod: 'candidate_profile_url' };
    const nameRoster = rosterRows.filter(row => identityName(row.candidate_name) === identityName(item.row.candidateName));
    if (nameRoster.length) {
      throw new Error(`Profile identity conflicts with a race-scoped candidate for ${item.row.candidateName}`);
    }
    return { candidateId, roster: null, matchMethod: 'candidate_profile_url_cross_race' };
  }

  const nameMatches = rosterRows.filter(row =>
    identityName(row.candidate_name) === identityName(item.row.candidateName)
    && sameParty(row.party_label, item.row.candidateParty)
  );
  if (nameMatches.length > 1) {
    throw new Error(`Ambiguous race-local candidate match for ${item.row.candidateName}`);
  }
  if (nameMatches.length === 1) {
    return { candidateId: nameMatches[0].candidate_id, roster: nameMatches[0], matchMethod: 'race_name_and_party' };
  }
  return { candidateId: null, roster: null, matchMethod: 'race_page_only' };
}

export async function importNomineeRoster({ filePath, parsed, manifest, commit = false }) {
  if (!manifest.complete) throw new Error('Refusing to import an incomplete or limited Ballotpedia scrape');
  if (manifest.errorCount !== 0) throw new Error('Refusing to import a Ballotpedia scrape with race errors');
  if (manifest.nomineeCount !== parsed.rowCount
    || manifest.attemptedRaceCount !== parsed.raceCount
    || manifest.successfulRaceCount !== parsed.raceCount) {
    throw new Error('Ballotpedia manifest does not match the nominee CSV');
  }
  if (parsed.houseRaceCount !== 436 || parsed.senateRaceCount !== 33 || parsed.raceCount !== 469) {
    throw new Error(
      `Expected nominees for 436 House and 33 Senate races; received ${parsed.houseRaceCount} and ${parsed.senateRaceCount}`
    );
  }

  const resolvedPath = path.resolve(filePath);
  const fileStat = await stat(resolvedPath);
  const checksum = await sha256File(resolvedPath);
  const runId = randomUUID();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['ballotpedia:2026:general-nominees']);
    const source = await one(client, "SELECT id FROM data_sources WHERE slug = 'ballotpedia'");
    const artifact = await one(client, `
      INSERT INTO source_artifacts (
        source_id, uri, retrieved_at, sha256, byte_size, content_type,
        source_version, metadata
      ) VALUES ($1, $2, $3, $4, $5, 'text/csv', '2026 general-election nominees', $6::JSONB)
      ON CONFLICT (source_id, sha256) WHERE sha256 IS NOT NULL DO UPDATE SET
        uri = EXCLUDED.uri,
        retrieved_at = EXCLUDED.retrieved_at,
        metadata = source_artifacts.metadata || EXCLUDED.metadata
      RETURNING id
    `, [
      source.id,
      pathToFileURL(resolvedPath).href,
      manifest.scrapedAt,
      checksum,
      fileStat.size,
      JSON.stringify({
        authority: 'secondary',
        generatedBy: 'scrape_nominees.py',
        sourceUrl: manifest.sourceUrl,
        electionDate: manifest.electionDate,
        manifest
      })
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
      'ballotpedia-2026-general-nominees',
      JSON.stringify({ dryRun: !commit, manifest })
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
      if (!state) throw new Error(`Nominee state is not in application geography: ${row.state}`);
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
      candidate_profile_url: 0,
      candidate_profile_url_cross_race: 0,
      race_name_and_party: 0,
      race_page_only: 0
    };
    let added = 0;
    let updated = 0;
    for (const item of mappedRows) {
      const matched = await matchCandidate(client, source.id, item);
      let candidateId = matched.candidateId;
      if (!candidateId) {
        candidateId = await ensureCandidate(
          client, source.id, item.row, item.state, item.districtAbbreviation
        );
      }
      await attachProfileAlias(client, source.id, candidateId, item.row.candidateUrl);
      const partyId = await ensureParty(client, partyCache, item.row.candidateParty);
      const evidence = {
        nominationStatus: 'general_candidate',
        nominationAuthority: 'secondary',
        candidateBallotpediaUrl: item.row.candidateUrl,
        raceBallotpediaUrl: item.row.raceUrl,
        observedAt: item.row.scrapedAt,
        nomineeMatchMethod: matched.matchMethod
      };
      if (matched.roster) {
        evidence.provisionalSourceArtifactId = matched.roster.metadata?.provisionalSourceArtifactId
          || String(matched.roster.source_artifact_id);
        await client.query(`
          UPDATE candidate_roster_entries
          SET candidate_id = $2,
              party_id = $3,
              source_artifact_id = $4,
              candidate_name = $5,
              party_label = $6,
              roster_status = 'general_candidate',
              metadata = metadata || $7::JSONB,
              updated_at = NOW()
          WHERE id = $1
        `, [
          matched.roster.id, candidateId, partyId, artifact.id,
          item.row.candidateName, item.row.candidatePartyRaw, JSON.stringify(evidence)
        ]);
        updated += 1;
      } else {
        await client.query(`
          INSERT INTO candidate_roster_entries (
            cycle, office_id, district_geography_id, candidate_id, party_id,
            source_id, source_artifact_id, identifier_namespace, source_identifier,
            candidate_name, party_label, roster_status, metadata
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'general_candidate', $12::JSONB)
          ON CONFLICT (source_id, identifier_namespace, source_identifier) DO UPDATE SET
            candidate_id = EXCLUDED.candidate_id,
            party_id = EXCLUDED.party_id,
            source_artifact_id = EXCLUDED.source_artifact_id,
            candidate_name = EXCLUDED.candidate_name,
            party_label = EXCLUDED.party_label,
            roster_status = 'general_candidate',
            metadata = candidate_roster_entries.metadata || EXCLUDED.metadata,
            updated_at = NOW()
        `, [
          cycle,
          item.officeId,
          item.district.id,
          candidateId,
          partyId,
          source.id,
          artifact.id,
          candidateRosterNamespace,
          candidateRosterSourceIdentifier(item.row, item.state, item.districtAbbreviation),
          item.row.candidateName,
          item.row.candidatePartyRaw,
          JSON.stringify(evidence)
        ]);
        added += 1;
      }
      matchCounts[matched.matchMethod] += 1;
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
      `Reconciled ${parsed.rowCount} Ballotpedia-listed 2026 general-election candidates.`,
      JSON.stringify({ matchCounts })
    ]);
    if (commit) await client.query('COMMIT');
    else await client.query('ROLLBACK');
    return {
      mode: commit ? 'committed' : 'dry-run',
      nominees: parsed.rowCount,
      houseRaces: parsed.houseRaceCount,
      senateRaces: parsed.senateRaceCount,
      added,
      updated,
      matchCounts,
      artifactId: String(artifact.id)
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
