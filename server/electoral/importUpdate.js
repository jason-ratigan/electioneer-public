import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { db } from '../db.js';
import { validateElectoralUpdate } from './validateUpdate.js';

export async function importElectoralUpdate(filePath, { commit = false } = {}) {
  const contents = await readFile(filePath);
  const input = JSON.parse(contents.toString('utf8'));
  const allocations = new Map((await db.query(
    'SELECT state_fips, allocated_votes FROM presidential_electoral_states WHERE cycle = $1', [input?.cycle]
  )).rows.map(row => [row.state_fips, Number(row.allocated_votes)]));
  const update = validateElectoralUpdate(input, allocations);
  const sha256 = createHash('sha256').update(contents).digest('hex');
  const summary = { cycle: update.cycle, status: update.status, states: update.states.length, votes: update.totalVotes, sha256, committed: false };
  if (!commit) return summary;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    let added = 0;
    for (const state of update.states) {
      const result = await client.query(`
        INSERT INTO presidential_electoral_updates
          (cycle, state_fips, status, source_url, reported_at, file_sha256)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (cycle, state_fips, file_sha256) DO NOTHING
        RETURNING id
      `, [update.cycle, state.fips, update.status, update.sourceUrl, update.reportedAt, sha256]);
      if (!result.rows.length) continue;
      added += 1;
      for (const vote of state.votes) {
        await client.query(`
          INSERT INTO presidential_electoral_update_votes
            (update_id, recipient_name, party_abbreviation, votes)
          VALUES ($1, $2, $3, $4)
        `, [result.rows[0].id, vote.recipientName.trim(), vote.partyAbbreviation || null, vote.votes]);
      }
    }
    await client.query('COMMIT');
    return { ...summary, committed: true, added };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
