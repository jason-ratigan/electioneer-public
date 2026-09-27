import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { parseCsvLine } from '../medsl2020/readHouse.js';
import { resolvePresidentialCandidateName } from '../vest2020/presidentialCandidates.js';
import { slugifyCandidateName } from '../vest2020/readState.js';

function booleanValue(value) {
  return /^(?:true|1|yes)$/i.test(value.trim());
}

function titleCase(value) {
  const trimmed = value.trim();
  if (!trimmed || trimmed !== trimmed.toUpperCase()) return trimmed;
  return trimmed.toLowerCase().replace(/(^|[\s\-'])\p{L}/gu, match => match.toUpperCase());
}

function statisticRow(name) {
  return !name.trim() || /^(?:(?:contest |grand )?total(?: votes? cast| votes?)?|total ballots?|ballots? cast|registered voters?|voter turnout|under[\s-]?votes?(?:[\s-].*)?|over[\s-]?votes?(?:[\s-].*)?|blank ballots?|blanks?)$/i.test(name.trim());
}

function candidateDisplayName(value) {
  const trimmed = value.trim();
  const comma = trimmed.indexOf(',');
  if (comma < 0) return titleCase(trimmed);
  const family = trimmed.slice(0, comma).trim();
  const given = trimmed.slice(comma + 1).trim();
  return titleCase(`${given} ${family}`);
}

function identity(candidate, officeSlug, writeIn) {
  const generic = booleanValue(writeIn)
    && /^(?:write[- ]?in(?: votes?)?|scattered|scatter|writeins?)$/i.test(candidate.trim());
  if (generic) {
    return {
      sourceIdentifier: 'generic:write-in',
      candidateSlug: null,
      canonicalName: null,
      ballotName: 'Write-In Votes',
      isWriteIn: true
    };
  }
  const reviewed = officeSlug === 'president' ? resolvePresidentialCandidateName(candidate) : null;
  const displayName = reviewed?.canonicalName || candidateDisplayName(candidate);
  const candidateSlug = reviewed?.canonicalKey || slugifyCandidateName(displayName);
  return {
    sourceIdentifier: `candidate:${candidateSlug}`,
    candidateSlug,
    canonicalName: displayName,
    ballotName: displayName,
    isWriteIn: booleanValue(writeIn)
  };
}

function party(row) {
  const value = row.party_simplified || row.party_detailed || '';
  if (value === 'DEMOCRAT' || value === 'DEMOCRATIC') return { name: 'Democratic Party', abbreviation: 'D' };
  if (value === 'REPUBLICAN') return { name: 'Republican Party', abbreviation: 'R' };
  if (value === 'LIBERTARIAN') return { name: 'Libertarian Party', abbreviation: 'L' };
  if (value === 'GREEN') return { name: 'Green Party', abbreviation: 'G' };
  if (value === 'NONPARTISAN') return { name: 'Nonpartisan', abbreviation: 'N' };
  if (!value) return null;
  return { name: titleCase(value), abbreviation: 'O' };
}

async function readSummaryFile(filePath) {
  const reader = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  let header;
  let classification;
  const entries = new Map();
  let rowsRead = 0;
  let pending = '';
  for await (const physicalLine of reader) {
    const line = pending ? `${pending}\n${physicalLine}` : physicalLine;
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] !== '"') continue;
      if (quoted && line[index + 1] === '"') index += 1;
      else quoted = !quoted;
    }
    if (quoted) {
      pending = line;
      continue;
    }
    pending = '';
    if (!header) {
      header = parseCsvLine(line).map(value => value.replace(/^\uFEFF/, '').trim());
      if (!header.includes('office') || !header.includes('candidate') || !header.includes('votes')) {
        throw new Error('not a MEDSL result summary CSV');
      }
      continue;
    }
    if (!line) continue;
    const values = parseCsvLine(line);
    if (values.length !== header.length) throw new Error('summary CSV has an inconsistent field count');
    const row = Object.fromEntries(header.map((column, index) => [column, values[index].trim()]));
    rowsRead += 1;
    const isStateSummary = !header.includes('county_fips');
    const aggregateMode = row.mode === 'TOTAL'
      || (isStateSummary && (!row.mode || row.mode === 'NA'));
    if (row.year !== '2024' || row.stage !== 'GEN' || !aggregateMode) continue;
    const officeSlug = row.office === 'US PRESIDENT'
      ? 'president'
      : row.office === 'US SENATE' ? 'us_senate' : null;
    if (!officeSlug || statisticRow(row.candidate)) continue;
    const currentClassification = `${officeSlug}_${isStateSummary ? 'state' : 'county'}`;
    if (classification && classification !== currentClassification) {
      throw new Error('summary CSV mixes incompatible result scopes');
    }
    classification = currentClassification;
    const candidate = identity(row.candidate, officeSlug, row.writein || '');
    if (!candidate.candidateSlug && !candidate.isWriteIn) continue;
    const countyFips = row.county_fips?.padStart(5, '0') || null;
    const key = [
      row.state_po,
      officeSlug,
      booleanValue(row.special || '') ? 'special' : 'regular',
      countyFips || 'statewide',
      candidate.sourceIdentifier
    ].join('\u001f');
    const votes = Number(row.votes);
    if (!Number.isSafeInteger(votes) || votes < 0) throw new Error(`invalid summary vote count: ${row.votes}`);
    if (!entries.has(key)) {
      entries.set(key, {
        state: row.state_po,
        officeSlug,
        special: booleanValue(row.special || ''),
        countyFips,
        countyName: titleCase(row.county_name || ''),
        ...candidate,
        party: party(row),
        votes: 0
      });
    }
    entries.get(key).votes += votes;
  }
  if (pending) throw new Error('summary CSV ends inside a quoted field');
  if (!classification) throw new Error('no supported 2024 TOTAL rows');
  return { classification, rowsRead, entries: [...entries.values()] };
}

export async function readResultSummaries(sourceDirectory) {
  const directory = path.resolve(sourceDirectory);
  const files = await readdir(directory, { withFileTypes: true });
  const summaries = [];
  const rejected = [];
  for (const file of files.filter(item => item.isFile() && item.name.toLowerCase().endsWith('.csv'))) {
    try {
      summaries.push({ filename: file.name, ...(await readSummaryFile(path.join(directory, file.name))) });
    } catch (error) {
      rejected.push({ filename: file.name, reason: error.message });
    }
  }
  return { summaries, rejected };
}

function ensureChoice(contest, entry) {
  let choice = contest.choices.find(item => item.sourceIdentifier === entry.sourceIdentifier);
  if (choice) return choice;
  choice = {
    sourceIdentifier: entry.sourceIdentifier,
    ballotName: entry.ballotName,
    canonicalName: entry.canonicalName,
    candidateSlug: entry.candidateSlug,
    choiceType: entry.candidateSlug ? 'candidate' : 'write_in',
    isWriteIn: entry.isWriteIn,
    votes: 0,
    reportedRows: 0,
    suppressedRows: 0,
    partyVotes: new Map(),
    party: entry.party
  };
  contest.choices.push(choice);
  return choice;
}

export function applyResultSummaries(items, summaryDiscovery) {
  const entries = summaryDiscovery.summaries.flatMap(summary =>
    summary.entries.map(entry => ({ ...entry, summaryFile: summary.filename }))
  );
  const states = new Map(items.map(item => [item.state.abbreviation, item.state]));
  let stateTotalsReconciled = 0;
  let countyTotalsReconciled = 0;
  let unmatchedEntries = 0;
  let presidentialChoicesPruned = 0;
  for (const entry of entries) {
    const state = states.get(entry.state);
    const contest = state?.contests.find(item =>
      item.officeSlug === entry.officeSlug && item.special === entry.special
    );
    if (!contest) {
      unmatchedEntries += 1;
      continue;
    }
    const choice = ensureChoice(contest, entry);
    if (!entry.countyFips) {
      choice.votes = entry.votes;
      choice.summarySource = entry.summaryFile;
      choice.party ||= entry.party;
      stateTotalsReconciled += 1;
      continue;
    }
    let county = contest.counties.find(item => item.fips === entry.countyFips);
    if (!county) {
      county = {
        fips: entry.countyFips,
        countyFips: entry.countyFips.slice(2),
        name: entry.countyName,
        precincts: new Set(),
        votes: new Map()
      };
      contest.counties.push(county);
    }
    county.votes.set(entry.sourceIdentifier, {
      votes: entry.votes,
      reportedRows: 1,
      suppressedRows: 0,
      summarySource: entry.summaryFile
    });
    countyTotalsReconciled += 1;
  }

  for (const item of items) {
    for (const contest of item.state.contests.filter(value => value.officeSlug === 'president')) {
      const reconciled = new Set(
        contest.choices.filter(choice => choice.summarySource).map(choice => choice.sourceIdentifier)
      );
      if (reconciled.size) {
        presidentialChoicesPruned += contest.choices.length - reconciled.size;
        contest.choices = contest.choices.filter(choice => reconciled.has(choice.sourceIdentifier));
        for (const county of contest.counties) {
          for (const choiceKey of county.votes.keys()) {
            if (!reconciled.has(choiceKey)) county.votes.delete(choiceKey);
          }
        }
      }
    }
    for (const contest of item.state.contests.filter(value => value.officeSlug === 'us_senate')) {
      for (const choice of contest.choices) {
        const summaryCountyTotals = contest.counties
          .map(county => county.votes.get(choice.sourceIdentifier))
          .filter(total => total?.summarySource);
        if (summaryCountyTotals.length) {
          choice.votes = summaryCountyTotals.reduce((sum, total) => sum + total.votes, 0);
          choice.summarySource = summaryCountyTotals[0].summarySource;
        }
      }
    }
  }
  return {
    files: summaryDiscovery.summaries.map(summary => ({
      filename: summary.filename,
      classification: summary.classification,
      rowsRead: summary.rowsRead
    })),
    rejected: summaryDiscovery.rejected,
    stateTotalsReconciled,
    countyTotalsReconciled,
    presidentialChoicesPruned,
    unmatchedEntries
  };
}
