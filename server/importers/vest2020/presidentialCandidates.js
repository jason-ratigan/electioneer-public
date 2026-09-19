const candidates = [
  {
    canonicalKey: 'joseph-r-biden-jr',
    canonicalName: 'Joseph R. Biden Jr.',
    sourceNames: ['Joseph Biden']
  },
  {
    canonicalKey: 'donald-j-trump',
    canonicalName: 'Donald J. Trump',
    sourceNames: ['Donald Trump']
  },
  {
    canonicalKey: 'jo-jorgensen',
    canonicalName: 'Jo Jorgensen',
    sourceNames: ['Jo Jorgensen']
  },
  {
    canonicalKey: 'howie-hawkins',
    canonicalName: 'Howie Hawkins',
    sourceNames: ['Howie Hawkins']
  }
];

export const presidentialCandidates = new Map(candidates.map(candidate => [candidate.canonicalKey, Object.freeze(candidate)]));

export function resolvePresidentialCandidate(canonicalKey, sourceName) {
  const candidate = presidentialCandidates.get(canonicalKey);
  if (!candidate) throw new Error(`Presidential candidate is missing from the national registry: ${canonicalKey}`);
  if (!candidate.sourceNames.includes(sourceName)) {
    throw new Error(`${sourceName} is not a reviewed source name for presidential candidate ${canonicalKey}`);
  }
  return candidate;
}
