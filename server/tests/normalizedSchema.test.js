import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { closeDatabase, db } from '../db.js';
import { candidateUuid } from '../identity/candidateUuid.js';

after(() => closeDatabase());

test('normalized election records retain geography, provenance, and summary semantics', async () => {
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const source = (await client.query("SELECT id FROM data_sources WHERE slug = 'vest'")).rows[0];
    assert.ok(source, 'VEST source seed should exist');

    const state = (await client.query(`
      INSERT INTO geographies (geography_type, name, abbreviation, state_fips)
      VALUES ('state', 'Schema Test State', 'TS', '99')
      RETURNING id
    `)).rows[0];
    const precinct = (await client.query(`
      INSERT INTO geographies (geography_type, name, state_fips, county_fips)
      VALUES ('precinct', 'Schema Test Precinct', '99', '001')
      RETURNING id
    `)).rows[0];

    await client.query(`
      INSERT INTO geography_versions (geography_id, valid_from, geom)
      VALUES ($1, DATE '2020-01-01', ST_Multi(ST_GeomFromText('POLYGON((-80 35, -79 35, -79 36, -80 36, -80 35))', 4326)))
    `, [precinct.id]);
    await client.query(`
      INSERT INTO geography_relationships (parent_geography_id, child_geography_id, valid_from)
      VALUES ($1, $2, DATE '2020-01-01')
    `, [state.id, precinct.id]);

    const party = (await client.query("INSERT INTO parties (name, abbreviation) VALUES ('Schema Test Party', 'TST') RETURNING id")).rows[0];
    const candidateKey = 'schema-test-candidate';
    const candidateId = candidateUuid(candidateKey);
    const candidate = (await client.query(`
      INSERT INTO candidates (id, canonical_key, canonical_name)
      VALUES ($1, $2, 'Schema Test Candidate')
      RETURNING id
    `, [candidateId, candidateKey])).rows[0];
    assert.equal(candidate.id, candidateId);
    await client.query(`
      INSERT INTO candidate_source_ids (candidate_id, source_id, identifier_namespace, source_identifier)
      VALUES
        ($1, $2, 'vest:test:de', 'G20PREDCAN'),
        ($1, $2, 'vest:test:pa', 'G20PREDCAN')
    `, [candidate.id, source.id]);
    const candidateAliases = (await client.query(`
      SELECT COUNT(*)::INTEGER AS aliases, COUNT(DISTINCT candidate_id)::INTEGER AS candidates
      FROM candidate_source_ids
      WHERE source_id = $1 AND source_identifier = 'G20PREDCAN'
    `, [source.id])).rows[0];
    assert.deepEqual(candidateAliases, { aliases: 2, candidates: 1 });
    const event = (await client.query(`
      INSERT INTO election_events (name, cycle, stage, start_date, end_date, scope_geography_id, is_test)
      VALUES ('Schema Test General Election', 2020, 'general', DATE '2020-11-03', DATE '2020-11-03', $1, TRUE)
      RETURNING id
    `, [state.id])).rows[0];
    const office = (await client.query("SELECT id FROM offices WHERE slug = 'governor'")).rows[0];
    const contest = (await client.query(`
      INSERT INTO contests (election_id, office_id, district_geography_id, name)
      VALUES ($1, $2, $3, 'Governor')
      RETURNING id
    `, [event.id, office.id, state.id])).rows[0];
    const choice = (await client.query(`
      INSERT INTO contest_choices (contest_id, ballot_name, party_id)
      VALUES ($1, 'Schema Test Candidate', $2)
      RETURNING id
    `, [contest.id, party.id])).rows[0];
    await client.query(`
      INSERT INTO contest_choice_candidates (contest_choice_id, candidate_id, office_id)
      VALUES ($1, $2, $3)
    `, [choice.id, candidate.id, office.id]);

    const outerArtifact = (await client.query(`
      INSERT INTO source_artifacts (source_id, uri, retrieved_at, sha256, byte_size, content_type)
      VALUES ($1, 'test://normalized-schema/outer.zip', NOW(), repeat('a', 64), 123, 'application/zip')
      RETURNING id
    `, [source.id])).rows[0];
    const artifact = (await client.query(`
      INSERT INTO source_artifacts (source_id, parent_artifact_id, uri, retrieved_at, sha256, byte_size, content_type)
      VALUES ($1, $2, 'zip://normalized-schema/outer.zip!/state.zip', NOW(), repeat('b', 64), 100, 'application/zip')
      RETURNING id
    `, [source.id, outerArtifact.id])).rows[0];
    const batch = (await client.query(`
      INSERT INTO result_batches (source_id, source_artifact_id, reported_at, retrieved_at, status)
      VALUES ($1, $2, TIMESTAMPTZ '2020-11-04 00:00:00Z', NOW(), 'certified')
      RETURNING id
    `, [source.id, artifact.id])).rows[0];
    const snapshot = (await client.query(`
      INSERT INTO result_snapshots (batch_id, contest_id, reporting_basis, reporting_value, reported_units, total_units)
      VALUES ($1, $2, 'precincts', 100, 1, 1)
      RETURNING id
    `, [batch.id, contest.id])).rows[0];

    await client.query(`
      INSERT INTO vote_totals (snapshot_id, reporting_unit_id, contest_choice_id, votes, tabulation_method)
      VALUES
        ($1, $2, $3, 1000, 'sum_of_reporting_units'),
        ($1, $4, $3, 1000, 'source_reported')
    `, [snapshot.id, state.id, choice.id, precinct.id]);

    const summary = (await client.query(`
      SELECT SUM(vt.votes)::INTEGER AS votes
      FROM vote_totals vt
      JOIN result_snapshots rs ON rs.id = vt.snapshot_id
      JOIN contests c ON c.id = rs.contest_id
      WHERE rs.id = $1 AND vt.reporting_unit_id = c.district_geography_id
    `, [snapshot.id])).rows[0];
    assert.equal(summary.votes, 1000, 'contest summary must not double-count precinct detail');

    const geometry = (await client.query(`
      SELECT ST_SRID(geom) AS srid, GeometryType(geom) AS geometry_type
      FROM geography_versions
      WHERE geography_id = $1
    `, [precinct.id])).rows[0];
    assert.deepEqual(geometry, { srid: 4326, geometry_type: 'MULTIPOLYGON' });

    const artifactParent = (await client.query('SELECT parent_artifact_id FROM source_artifacts WHERE id = $1', [artifact.id])).rows[0];
    assert.equal(artifactParent.parent_artifact_id, outerArtifact.id);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
