const party = (name, abbreviation) => ({ name, abbreviation });

export const delawareManifest = Object.freeze({
  namespace: 'vest:2020:de',
  stateArchive: 'de_2020.zip',
  shapeBasename: 'de_2020',
  precinctField: 'PRECINCT',
  encoding: 'utf-8',
  sourceCrsMarker: 'WGS_1984_Web_Mercator_Auxiliary_Sphere',
  election: {
    sourceIdentifier: 'G20',
    name: '2020 Delaware General Election',
    cycle: 2020,
    stage: 'general',
    date: '2020-11-03'
  },
  state: {
    name: 'Delaware',
    abbreviation: 'DE',
    stateFips: '10'
  },
  expectedPrecincts: 434,
  expectedBounds: {
    minLongitude: -76,
    minLatitude: 38.2,
    maxLongitude: -74.7,
    maxLatitude: 40.1
  },
  allocation: {
    isEstimated: true,
    method: 'VEST distributed countywide UOCAVA votes to precincts by each candidate\'s share of precinct-level reported votes.',
    affectedSourceUnits: ['17-02', '16-31', '16-41']
  },
  contests: [
    {
      sourceIdentifier: 'G20PRE',
      name: 'President',
      officeSlug: 'president',
      district: 'state',
      choices: [
        { column: 'G20PREDBID', candidateKey: 'joseph-r-biden-jr', name: 'Joseph Biden', party: party('Democratic Party', 'D'), expectedVotes: 296268 },
        { column: 'G20PRERTRU', candidateKey: 'donald-j-trump', name: 'Donald Trump', party: party('Republican Party', 'R'), expectedVotes: 200603 },
        { column: 'G20PRELJOR', candidateKey: 'jo-jorgensen', name: 'Jo Jorgensen', party: party('Libertarian Party', 'L'), expectedVotes: 5000 },
        { column: 'G20PREGHAW', candidateKey: 'howie-hawkins', name: 'Howie Hawkins', party: party('Green Party', 'G'), expectedVotes: 2139 }
      ]
    },
    {
      sourceIdentifier: 'G20USS',
      name: 'U.S. Senate',
      officeSlug: 'us_senate',
      district: 'state',
      choices: [
        { column: 'G20USSDCOO', candidateKey: 'chris-coons', name: 'Chris Coons', party: party('Democratic Party', 'D'), expectedVotes: 291804 },
        { column: 'G20USSRWIT', candidateKey: 'lauren-witzke', name: 'Lauren Witzke', party: party('Republican Party', 'R'), expectedVotes: 186054 },
        { column: 'G20USSLFRO', candidateKey: 'nadine-frost', name: 'Nadine Frost', party: party('Libertarian Party', 'L'), expectedVotes: 5244 },
        { column: 'G20USSITUR', candidateKey: 'mark-turley', name: 'Mark Turley', party: party('Independent Party', 'I'), expectedVotes: 7833 }
      ]
    },
    {
      sourceIdentifier: 'G20HAL',
      name: 'U.S. House — At-Large District',
      officeSlug: 'us_house',
      district: 'at_large',
      choices: [
        { column: 'G20HALDROC', candidateKey: 'lisa-blunt-rochester', name: 'Lisa Blunt Rochester', party: party('Democratic Party', 'D'), expectedVotes: 281382 },
        { column: 'G20HALRMUR', candidateKey: 'lee-murphy', name: 'Lee Murphy', party: party('Republican Party', 'R'), expectedVotes: 196392 },
        { column: 'G20HALLROG', candidateKey: 'david-rogers', name: 'David Rogers', party: party('Libertarian Party', 'L'), expectedVotes: 3814 },
        { column: 'G20HALIPUR', candidateKey: 'catherine-purcell', name: 'Catherine Purcell', party: party('Independent Party', 'I'), expectedVotes: 6682 }
      ]
    },
    {
      sourceIdentifier: 'G20GOV',
      name: 'Governor',
      officeSlug: 'governor',
      district: 'state',
      choices: [
        { column: 'G20GOVDCAR', candidateKey: 'john-carney', name: 'John Carney', party: party('Democratic Party', 'D'), expectedVotes: 292903 },
        { column: 'G20GOVRMUR', candidateKey: 'julianne-murray', name: 'Julianne Murray', party: party('Republican Party', 'R'), expectedVotes: 190312 },
        { column: 'G20GOVLMAC', candidateKey: 'john-machurek', name: 'John Machurek', party: party('Libertarian Party', 'L'), expectedVotes: 3270 },
        { column: 'G20GOVIDEM', candidateKey: 'kathy-dematteis', name: 'Kathy DeMatteis', party: party('Independent Party', 'I'), expectedVotes: 6150 }
      ]
    }
  ]
});
