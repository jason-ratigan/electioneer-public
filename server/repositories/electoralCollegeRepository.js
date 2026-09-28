import { all } from '../db.js';

export const electoralCollegeRepository = {
  async byCycle(cycle) {
    const rows = await all(`
      WITH latest_updates AS (
        SELECT DISTINCT ON (cycle, state_fips)
          id, cycle, state_fips, status, source_url, reported_at
        FROM presidential_electoral_updates
        WHERE cycle = $1
        ORDER BY cycle, state_fips, (status = 'certified') DESC,
          reported_at DESC, imported_at DESC, id DESC
      )
      SELECT state.state_fips, state.allocated_votes, state.allocation_source_url,
        vote.recipient_name, vote.party_abbreviation, vote.votes, vote.status,
        vote.source_url, vote.reported_at
      FROM presidential_electoral_states state
      LEFT JOIN latest_updates state_update
        ON state_update.cycle = state.cycle AND state_update.state_fips = state.state_fips
      LEFT JOIN LATERAL (
        SELECT recipient_name, party_abbreviation, votes, state_update.status,
          state_update.source_url, state_update.reported_at
        FROM presidential_electoral_update_votes
        WHERE update_id = state_update.id
        UNION ALL
        SELECT recipient_name, party_abbreviation, votes, status, source_url, reported_at
        FROM presidential_electoral_votes
        WHERE cycle = state.cycle AND state_fips = state.state_fips
          AND state_update.id IS NULL
      ) vote ON TRUE
      WHERE state.cycle = $1
      ORDER BY state.state_fips, vote.votes DESC NULLS LAST, vote.recipient_name
    `, [cycle]);
    const states = new Map();
    const totals = new Map();
    for (const row of rows) {
      if (!states.has(row.state_fips)) {
        states.set(row.state_fips, {
          stateFips: row.state_fips,
          allocatedVotes: Number(row.allocated_votes),
          allocationSourceUrl: row.allocation_source_url,
          votes: []
        });
      }
      if (row.recipient_name) {
        const votes = Number(row.votes);
        states.get(row.state_fips).votes.push({
          recipientName: row.recipient_name,
          partyAbbreviation: row.party_abbreviation,
          votes,
          status: row.status,
          sourceUrl: row.source_url,
          reportedAt: row.reported_at
        });
        const key = `${row.recipient_name}\u0000${row.party_abbreviation || ''}`;
        if (!totals.has(key)) totals.set(key, {
          recipientName: row.recipient_name,
          partyAbbreviation: row.party_abbreviation,
          votes: 0
        });
        totals.get(key).votes += votes;
      }
    }
    const stateList = [...states.values()];
    const allocatedVotes = stateList.reduce((sum, state) => sum + state.allocatedVotes, 0);
    const reportedVotes = [...totals.values()].reduce((sum, recipient) => sum + recipient.votes, 0);
    const status = !reportedVotes ? 'pending'
      : stateList.some(state => state.votes.some(vote => vote.status !== 'certified')) ? 'projected'
        : stateList.every(state => state.votes.length) ? 'certified' : 'partial';
    return {
      cycle,
      status,
      allocatedVotes,
      majority: Math.floor(allocatedVotes / 2) + 1,
      reportedVotes,
      states: stateList,
      totals: [...totals.values()].sort((a, b) => b.votes - a.votes || a.recipientName.localeCompare(b.recipientName))
    };
  }
};
