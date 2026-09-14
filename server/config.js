export const archivePolicy = Object.freeze({
  generalResultsFrom: 2000,
  primaryResultsFrom: 2014,
  pollsFrom: 2014,
  historicalLocalResults: false,
  historicalBallotMeasures: false,
  allowedHistoricalStateOffices: ['Governor'],
  manualRefreshOnly: true,
  maxDatabaseMb: Number(process.env.MAX_DATABASE_MB || 2048)
});

export const sources = Object.freeze([
  { id: 'openelections', label: 'OpenElections', uses: ['historical-results'], enabled: true },
  { id: 'vest', label: 'VEST', uses: ['historical-results', 'precinct-results'], enabled: true },
  { id: 'state', label: 'State election offices', uses: ['official-results'], enabled: true },
  { id: 'ap', label: 'AP Elections', uses: ['election-night-results'], enabled: false }
]);
