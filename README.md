# Signal

Signal is a full-stack election-data foundation with a React/Vite client, Express API, and PostgreSQL/PostGIS database. It supports general, primary, runoff, special, and presidential contests. Source results are stored as immutable batches and snapshots so historical revisions and election-night trends can be reconstructed.

## Architecture

The API uses controller → service → repository separation:

- `server/controllers`: HTTP request and response handling.
- `server/services`: validation and application rules.
- `server/repositories`: PostgreSQL queries and persistence.
- `server/migrations`: versioned PostgreSQL/PostGIS schema migrations.
- `server/db.js`: database connection and migration initialization.
- `src`: React client.

## Run

After installing the dependencies once with `npm install`, start the entire development stack with one command:

```bash
npm run dev
```

This starts PostgreSQL/PostGIS through Docker Compose, waits for it to become healthy, and then launches both the API and web client. The API applies any pending migrations during startup. The database volume is preserved between runs, so imported election data remains available. Press `Ctrl+C` to stop the application processes; use `npm run db:down` when you also want to stop PostgreSQL.

The web client runs at `http://localhost:4173`; the API runs at `http://localhost:3000`. Production uses `npm run build && npm start`. The default development connection is `postgresql://signal:signal@localhost:55432/signal`; set `DATABASE_URL` for another PostgreSQL instance. The high development port avoids colliding with a system PostgreSQL installation. Set `DATABASE_SSL=true` when the provider requires TLS. The bundled Compose service uses PostgreSQL 17 with PostGIS 3.5.

New databases start empty. Development fixtures and source imports are explicit operations; application startup never inserts illustrative election data.

## Delaware VEST importer

Place the Harvard Dataverse download at `dataverse_files.zip`, then run the importer without flags to execute a complete validation transaction that is rolled back:

```bash
npm run import:vest:de
```

Review the reported precinct count, statewide totals, geometry repairs, and row counts. Commit the same validated import explicitly:

```bash
npm run import:vest:de -- --commit
```

Use `--archive PATH` to select a differently located outer Dataverse ZIP. The importer reads only `de_2020.zip`, verifies both archive checksums, transforms source polygons to EPSG:4326, repairs and reports invalid topology, imports only President/U.S. Senate/U.S. House/governor, and performs all database changes in one transaction. Re-importing the same nested artifact is idempotent.

Add Delaware county boundaries and the spatial precinct-to-county crosswalk after the VEST import:

```bash
npm run import:geography:de-counties
```

The election hub then shows a national availability map, Delaware county totals, and all 434 imported precincts. County totals are derived by summing the precinct-level VEST values assigned to each county by largest-area spatial intersection.

## Nationwide VEST 2020 importer

The outer Dataverse ZIP already contains the 50 states and District of Columbia. Validate any subset through the complete import pipeline without retaining database changes:

```bash
npm run import:vest:2020 -- --states MD,PA,VA
```

Commit a selected batch, or all 51 jurisdictions:

```bash
npm run import:vest:2020 -- --states MD,PA,VA --commit
npm run import:vest:2020 -- --all --commit
```

Each state uses its own PostgreSQL transaction and ingestion-run record. A failed state is rolled back without affecting successful states, the default run continues to report remaining failures, and rerunning the command skips state artifacts already imported. Add `--stop-on-error` when debugging one failure. The importer reads nested state archives directly, discovers the supported contest columns, stores only President, Governor, U.S. Senate, and U.S. House results present in each state file, preserves national presidential UUIDs, repairs invalid source polygons, and builds county-to-precinct crosswalks.

The standard state archives are used. The separate Kentucky and New Jersey VTD-estimate archives remain optional supplemental sources and are not selected automatically. The VEST files include U.S. House data for at-large jurisdictions and D.C.; most district-based House results require an additional source.

## Nationwide MEDSL 2020 U.S. House importer

Place the MEDSL download at `us_house_2020.zip`. Validate the complete import without retaining changes, then commit it:

```bash
npm run import:medsl:house:2020
npm run import:medsl:house:2020 -- --commit
```

The importer reads `HOUSE_precinct_general.csv` directly from the ZIP, validates its 2020 general-election scope, combines voting modes and fusion-party lines, excludes overvote/undervote statistics, and stores district summaries plus county totals aggregated from the precinct rows. Candidate identities remain state-scoped and deterministic. Privacy-suppressed negative values are omitted and recorded as import warnings. Re-importing the same archive is idempotent. Use `--archive PATH` to select another archive location.

The district maps use the Census Bureau's 2020 cartographic boundaries for the 116th Congress. Place `cb_2020_us_cd116_5m.zip` in `data/census/`, then import it with:

```bash
npm run import:geography:congress-116
```

The map shows all 436 voting and non-voting House districts in the 50 states and District of Columbia. The boundary importer excludes territories outside the application's current state scope and is safe to rerun.

## API

- `GET /api/health`
- `GET /api/races?type=general|primary|runoff|special|presidential_primary|presidential_general`
- `GET /api/races?cycle=2020&office=President&query=National`
- `GET /api/archive/facets`
- `GET /api/hub/options`
- `GET /api/hub/overview?office=president&cycle=2020&stage=general`
- `GET /api/hub/districts?cycle=2020&stage=general`
- `GET /api/hub/contests/:id/geographies?level=county|precinct`
- `GET /api/races/:id/history`
- `GET /api/storage`
- `GET /api/ingest-runs`
- `POST /api/refresh` (returns `501` until the selected source adapter exists)

There is deliberately no generic result-write endpoint. Results enter through validated, source-specific importers that create provenance records, immutable result batches, snapshots, reporting status, and vote totals in one transaction.

## Normalized data model

- `candidates` stores people independently of an election or party label.
- Application entities use PostgreSQL UUID primary and foreign keys; vote counts, byte sizes, and other measurements remain numeric.
- Candidate UUIDs are deterministic UUIDv5 values derived from a reviewed canonical key. State-specific source identifiers are namespaced aliases, so the same presidential candidate resolves to the same UUID in every state and after a database rebuild.
- `election_events` stores cycle, stage, election dates, and geographic scope.
- `contests` connects an event to an office and district; `contest_choices` represents candidates, tickets, write-ins, or other ballot choices in that contest.
- `result_batches` and `result_snapshots` preserve source timestamps and revision history.
- `vote_totals` stores votes by snapshot, reporting geography, ballot choice, vote type, and tabulation round. Contest-wide totals use the contest district as their reporting unit so detail rows are never accidentally double-counted.
- `geographies`, `geography_versions`, and `geography_relationships` support dated PostGIS boundaries, containment, reporting relationships, and crosswalk allocations.
- `polls`, `poll_questions`, and `poll_responses` are separate from official results.
- `model_runs` and `model_estimates` hold poll averages, projections, and election-night scenarios without changing source vote totals.
- `data_sources`, `source_artifacts`, source-ID mapping tables, and `ingestion_runs` preserve lineage and importer audit data.

## Agreed archive policy

- General election results begin in 2000.
- Primary results and polling observations begin in 2014.
- Historical municipal, county, local-primary, and ballot-measure records are excluded.
- Historical statewide offices are excluded except governor; federal offices remain in scope.
- Refresh is user-initiated through `POST /api/refresh`; there is no scheduler.
- PostgreSQL exposes database size and record counts at `GET /api/storage`.
- Initial adapters are planned for OpenElections, VEST, state election offices, and optionally AP Elections after credentials are configured. Provider ingestion remains intentionally unimplemented until formats and credentials are supplied.

## Remaining inputs needed before production integration

1. Licensed polling/results providers and credentials.
2. The initial states and federal offices to prioritize within the agreed archive scope.
3. The exact weighting methodology and rules for partisan and AAA pollsters, recency, revisions, and exclusions.
4. Official-source precedence and correction rules for manual election-night refreshes.
5. PostgreSQL backup, retention, and deployment-provider preferences.

The database starts empty. No candidate, polling, or result records are illustrative or auto-seeded.

## Planning documents

- [Collection and processing plan](docs/data-collection-plan.md)
- [VEST 2020 source mapping](docs/vest-2020-mapping.md)
- [Presidential primary delegate model](docs/presidential-delegate-model.md)
- [Data-source research register](docs/source-research.md)
