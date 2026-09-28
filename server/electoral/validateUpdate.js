const fipsPattern = /^[0-9]{2}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function validateElectoralUpdate(input, allocations) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Update must be a JSON object');
  const { cycle, status, sourceUrl, reportedAt, states } = input;
  if (!Number.isInteger(cycle) || cycle < 2028 || cycle % 4 !== 0) throw new Error('Cycle must be a presidential election year from 2028 onward');
  if (!['projected', 'certified'].includes(status)) throw new Error('Status must be projected or certified');
  let source;
  try { source = new URL(sourceUrl); } catch { /* handled below */ }
  if (source?.protocol !== 'https:' || !source.hostname) throw new Error('A public HTTPS sourceUrl is required');
  if (typeof reportedAt !== 'string' || !timestampPattern.test(reportedAt) || Number.isNaN(Date.parse(reportedAt))) throw new Error('reportedAt must be an ISO timestamp with a time zone');
  if (!Array.isArray(states) || !states.length) throw new Error('At least one state is required');

  const seenStates = new Set();
  let totalVotes = 0;
  for (const state of states) {
    if (!state || !fipsPattern.test(state.fips)) throw new Error('Each state needs a two-digit fips');
    if (seenStates.has(state.fips)) throw new Error(`Duplicate state ${state.fips}`);
    seenStates.add(state.fips);
    const allocation = allocations.get(state.fips);
    if (!allocation) throw new Error(`No ${cycle} Electoral College allocation for ${state.fips}`);
    if (!Array.isArray(state.votes) || !state.votes.length) throw new Error(`State ${state.fips} needs at least one recipient`);
    const seenRecipients = new Set();
    let stateVotes = 0;
    for (const vote of state.votes) {
      if (!vote || typeof vote.recipientName !== 'string' || !vote.recipientName.trim()) throw new Error(`State ${state.fips} has an unnamed recipient`);
      const recipientName = vote.recipientName.trim();
      if (seenRecipients.has(recipientName)) throw new Error(`State ${state.fips} repeats ${recipientName}`);
      seenRecipients.add(recipientName);
      if (!Number.isInteger(vote.votes) || vote.votes <= 0) throw new Error(`State ${state.fips} needs positive integer votes`);
      if (vote.partyAbbreviation != null && (typeof vote.partyAbbreviation !== 'string' || !/^[A-Z]{1,12}$/.test(vote.partyAbbreviation))) throw new Error(`State ${state.fips} has an invalid party abbreviation`);
      stateVotes += vote.votes;
    }
    if (stateVotes > allocation) throw new Error(`State ${state.fips} reports ${stateVotes} votes but has ${allocation} allocated`);
    totalVotes += stateVotes;
  }
  return { cycle, status, sourceUrl, reportedAt, states, totalVotes };
}
