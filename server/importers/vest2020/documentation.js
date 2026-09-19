import { vestStates } from './states.js';

const stateNames = new Map(vestStates.map(state => [state.name, state.code]));

export const vestDocumentationCorrections = new Map([
  ['ne:G20USSLSIA', {
    documentedColumn: 'G20USSLSLA',
    reason: 'Nebraska DBF spells the Gene Siadek column LSIA; documentation spells it LSLA.'
  }],
  ['oh:G20PREGHAW', {
    documentedColumn: 'G20PREIHAW',
    reason: 'Ohio DBF spells the Howie Hawkins column GHAW; documentation spells it IHAW.'
  }]
]);

export function parseVestDocumentation(text) {
  const byState = new Map(vestStates.map(state => [state.code, new Map()]));
  const notes = new Map(vestStates.map(state => [state.code, []]));
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  let currentState = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (stateNames.has(line) && /^-+$/.test((lines[index + 1] || '').trim())) {
      currentState = stateNames.get(line);
      index += 1;
      continue;
    }
    if (!currentState) continue;
    const labelMatch = line.match(/^(G20[A-Z0-9]+)\s+-\s+(.+)$/);
    if (labelMatch) {
      byState.get(currentState).set(labelMatch[1], labelMatch[2].trim());
    } else if (line) {
      notes.get(currentState).push(line);
    }
  }
  for (const [key, correction] of vestDocumentationCorrections) {
    const [stateCode, sourceColumn] = key.split(':');
    const stateLabels = byState.get(stateCode);
    if (!stateLabels.has(sourceColumn) && stateLabels.has(correction.documentedColumn)) {
      stateLabels.set(sourceColumn, stateLabels.get(correction.documentedColumn));
    }
  }
  return { labels: byState, notes };
}

export function splitChoiceLabel(label) {
  const trimmed = label.trim();
  const partyStart = trimmed.lastIndexOf(' (');
  if (partyStart > 0 && trimmed.endsWith(')')) {
    return {
      name: trimmed.slice(0, partyStart).trim(),
      party: trimmed.slice(partyStart + 2, -1).trim()
    };
  }
  return { name: trimmed, party: null };
}
