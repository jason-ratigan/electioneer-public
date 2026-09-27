const candidates = [
  {
    canonicalKey: 'joseph-r-biden-jr',
    canonicalName: 'Joseph R. Biden Jr.',
    sourceNames: ['Joseph Biden']
  },
  {
    canonicalKey: 'donald-j-trump',
    canonicalName: 'Donald J. Trump',
    sourceNames: ['Donald Trump', 'DONALD J TRUMP', 'TRUMP, DONALD J.']
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
  },
  {
    canonicalKey: 'kamala-d-harris',
    canonicalName: 'Kamala D. Harris',
    sourceNames: ['KAMALA D HARRIS', 'HARRIS, KAMALA D.']
  },
  {
    canonicalKey: 'chase-oliver',
    canonicalName: 'Chase Oliver',
    sourceNames: ['CHASE OLIVER', 'OLIVER, CHASE']
  },
  {
    canonicalKey: 'claudia-de-la-cruz',
    canonicalName: 'Claudia De La Cruz',
    sourceNames: ['CLAUDIA DE LA CRUZ', 'DE LA CRUZ, CLAUDIA']
  },
  {
    canonicalKey: 'jill-stein',
    canonicalName: 'Jill Stein',
    sourceNames: ['JILL STEIN', 'STEIN, JILL']
  },
  {
    canonicalKey: 'randall-terry',
    canonicalName: 'Randall Terry',
    sourceNames: ['RANDALL TERRY', 'TERRY, RANDALL', 'TERRY, RANDALL A.']
  },
  {
    canonicalKey: 'peter-sonski',
    canonicalName: 'Peter Sonski',
    sourceNames: ['PETER SONSKI', 'SONSKI, PETER']
  },
  {
    canonicalKey: 'robert-f-kennedy-jr',
    canonicalName: 'Robert F. Kennedy Jr.',
    sourceNames: ['ROBERT F KENNEDY', 'ROBERT F KENNEDY JR', 'KENNEDY, ROBERT F. JR']
  },
  {
    canonicalKey: 'cornel-west',
    canonicalName: 'Cornel West',
    sourceNames: ['CORNEL WEST', 'WEST, CORNEL']
  },
  {
    canonicalKey: 'joseph-kishore',
    canonicalName: 'Joseph Kishore',
    sourceNames: ['JOSEPH KISHORE', 'KISHORE, JOSEPH']
  },
  {
    canonicalKey: 'rachele-fruit',
    canonicalName: 'Rachele Fruit',
    sourceNames: ['RACHELE FRUIT', 'FRUIT, RACHELE']
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

function normalizedSourceName(value) {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

const candidatesBySourceName = new Map(candidates.flatMap(candidate =>
  candidate.sourceNames.map(sourceName => [normalizedSourceName(sourceName), Object.freeze(candidate)])
));

export function resolvePresidentialCandidateName(sourceName) {
  return candidatesBySourceName.get(normalizedSourceName(sourceName)) || null;
}
