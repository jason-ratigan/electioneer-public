# Signal

Signal is a full-stack election-data foundation with a React/Vite client, Express API, and persistent local DuckDB database. It supports general, primary, and presidential race categories and stores observations append-only so polling and election-night trends can be reconstructed.

## Architecture

The API uses controller → service → repository separation:

- `server/controllers`: HTTP request and response handling.
- `server/services`: validation and application rules.
- `server/repositories`: DuckDB queries and persistence.
- `server/db.js`: local schema and development seed initialization.
- `src`: React client.

## Run

```bash
npm install
npm run dev
```

The web client runs at `http://localhost:4173`; the API runs at `http://localhost:3000`. Production uses `npm run build && npm start`. Set `DATABASE_PATH` to relocate the DuckDB file (default: `data/signal.duckdb`).

## API

- `GET /api/health`
- `GET /api/races?type=general|primary|presidential_primary|presidential_general`
- `GET /api/races?cycle=2020&office=President&query=National`
- `GET /api/archive/facets`
- `GET /api/races/:id/history`
- `POST /api/races/:id/observations`

Observation writes accept `metric`, `valueA`, `valueB`, `reporting`, and `source`. Authentication and provider ingestion should be added before exposing writes outside a trusted network.

## Agreed archive policy

- General election results begin in 2000.
- Primary results and polling observations begin in 2014.
- Historical municipal, county, local-primary, and ballot-measure records are excluded.
- Historical statewide offices are excluded except governor; federal offices remain in scope.
- Refresh is user-initiated through `POST /api/refresh`; there is no scheduler.
- The local database defaults to a 2 GB soft limit (`MAX_DATABASE_MB`) and exposes size/counts at `GET /api/storage`.
- Initial adapters are planned for OpenElections, VEST, state election offices, and optionally AP Elections after credentials are configured. Provider ingestion remains intentionally unimplemented until formats and credentials are supplied.

## Remaining inputs needed before production integration

1. Licensed polling/results providers and credentials.
2. The initial states and federal offices to prioritize within the agreed archive scope.
3. The exact weighting methodology and rules for partisan and AAA pollsters, recency, revisions, and exclusions.
4. Official-source precedence and correction rules for manual election-night refreshes.
5. Local backup and retention preferences, including whether the 2 GB default cap should be changed.

All included candidate names and values are illustrative; they are not current polling or election results.

The first interface milestone prioritizes the historical archive. Its filters and detail panel use illustrative records so navigation can be evaluated before provider credentials and weighting rules are available.

## Planning documents

- [Collection and processing plan](docs/data-collection-plan.md)
- [Presidential primary delegate model](docs/presidential-delegate-model.md)
- [Data-source research register](docs/source-research.md)
