# Electioneer

Electioneer explores U.S. election results and polling with a React/Vite client, Express API, and PostgreSQL/PostGIS database. Imported observations and official results remain separate from the site's descriptive polling averages. The app does not produce election forecasts.

## What this branch includes

- A 2026 polling map with dated current-holder assumptions and browser-saved winner picks, a poll library, and published presidential approval averages.
- Historical results, district and county maps, and presidential Electoral College results.
- Reviewed CSV/ZIP imports and a manual NYT polling refresh through an authenticated admin page, plus source-specific command-line importers.

## Architecture

The API uses controller → service → repository separation:

- `server/controllers`: HTTP request and response handling.
- `server/services`: validation and application rules.
- `server/repositories`: PostgreSQL queries and persistence.
- `server/migrations`: versioned PostgreSQL/PostGIS schema migrations.
- `server/db.js`: database connection and migration initialization.
- `src`: React client.

## Run

Install Node.js 22 or newer and Docker with Compose. Then install the locked dependencies and start the development stack:

```bash
npm ci
npm run dev
```

On Windows PowerShell, use `npm.cmd` in place of `npm` if script execution is restricted. Python 3 and the requirements files are needed for the Python-based collectors and parser tests.

This starts PostgreSQL/PostGIS through Docker Compose, waits for it to become healthy, and then launches both the API and web client. The API applies any pending migrations during startup. The database volume is preserved between runs, so imported election data remains available. Press `Ctrl+C` to stop the application processes; use `npm run db:down` when you also want to stop PostgreSQL.

The web client runs at `http://localhost:4173`; the API runs at `http://localhost:3000`. Production uses `npm run build && npm start`. The default development connection is `postgresql://signal:signal@localhost:15432/signal`; these are local database identifiers, not the application name. Set `DATABASE_URL` for another PostgreSQL instance. The development port avoids colliding with a system PostgreSQL installation and the Windows reserved port range that includes 55432. Set `DATABASE_SSL=true` when the provider requires TLS. The bundled Compose service uses PostgreSQL 17 with PostGIS 3.5.

Migrations seed certified presidential Electoral College votes for 2000–2024 and 2028 state allocations. Popular-vote results, geographic boundaries, candidate rosters, and polls require separate source imports. Downloaded source files and local database contents are not included in this repository.

## 2026 polling explorer

The home page opens the Senate, governor, and House polling map. Move the date to inspect earlier polls, compare candidate matchups, and open source questions. The 2026 control scenario starts with a dated current-holder assumption for unpolled races; you can turn it off or pick a winner. Picks stay in this browser and never change source data. National approval and generic-ballot polls remain separate from state races.

The polling average is a descriptive calculation, not a probability or forecast. Historical results, the poll library, and admin imports are available from the sidebar. See [polling outlook methodology and usage](docs/polling-outlook.md) for sources, exclusions, and limits.

## Admin CSV and ZIP imports

Open **Admin imports** (`/#admin`) to refresh the six supported NYT polling downloads or upload NYT polling CSVs, published approval averages, MEDSL 2024 state precinct downloads, MEDSL 2020 House files, or documented VEST 2020 archives. Set a random `ADMIN_IMPORT_TOKEN` of at least 32 characters in the API process environment first; admin endpoints are disabled without it. The token is entered in the admin page and is never bundled into the client.

The **Update NYT polls** button downloads six fixed Times CSVs after administrator authentication and publishes each validated file automatically; other uploads still require preview and explicit confirmation. The button does not schedule future refreshes.

Uploads are privately staged and validated asynchronously. Review the source, actual row scope, proposed changes, unresolved mappings and warnings, then explicitly confirm publication. Commit is transactional, retries are idempotent, corrections retain previous observations, and import history includes checksums and audit reports. The **Polls** view displays individual questions with sample/population, field dates, responses and NYT attribution; Times-published approval averages appear separately from raw polls and model estimates.

See [Admin import workflow, supported formats, attribution and testing](docs/admin-imports.md) for setup, source limitations, ZIP limits and the API. Third-party CSVs and ZIPs are not shipped with this repository. Download them from the linked providers and check their licenses and codebooks. Importers validate file contents rather than inferring a source from its filename; unsupported years, primary/runoff files, and layouts need separate adapters.

With the downloaded fixtures and a migrated development database, run `npm run test:imports` for parsing, mapping, authentication, revision, idempotency and rollback tests. `npm run test:imports:e2e` exercises upload, preview, confirmation, and publication against a disposable PostgreSQL database. It requires separately downloaded NYT files and a real MEDSL ZIP; those files are ignored by Git.

For a local bulk update, run `npm run import:admin -- --polling-dir polling` to stage previews, or add `--commit` to explicitly publish the validated files. The command applies migrations and uses the same transaction, provenance and audit pipeline as the admin page. Repeated downloads are safe to rerun.

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

## Nationwide MEDSL 2024 results importer

Place the extracted MEDSL state ZIPs and companion summary CSVs in `2024_results/`. The directory is intentionally ignored by Git. Validate all 50 states plus the District of Columbia without retaining changes, then commit the import:

```bash
npm run import:medsl:2024
npm run import:medsl:2024 -- --commit
```

Use `--commit --replace` to atomically replace a prior MEDSL 2024 import after updating the source files. The importer identifies state archives and summary files from their contents rather than trusting their filenames, requires all 51 jurisdictions by default, and limits the data to President, Governor, U.S. Senate, and U.S. House. It excludes statistical rows, avoids double-counting voting modes and parent rollups, aggregates county totals, reconciles presidential statewide results and Senate county results against the supplied certified summaries, and records suppressed or otherwise unusable source rows as categorized warnings. National presidential identities use the same deterministic UUIDs as the 2020 importer. Use `--allow-incomplete` only when deliberately loading a partial collection.

The 2024 House map uses the Census Bureau's 2023 cartographic boundaries for the 118th Congress. Place `cb_2023_us_cd118_5m.zip` in `data/census/`, then run:

```bash
npm run import:geography:congress-118
```

The current MEDSL state files do not contain contests for Florida District 20, Oklahoma District 3, or D.C.'s non-voting delegate. Their district boundaries still appear on the map as unavailable results.

## 2026 congressional geography

Place the Census national legislative GeoPackage ZIP at `tlgpkg_2026_us_legislative.gpkg.zip`, then import the 120th-Congress layer with:

```bash
npm run import:geography:congress-120
```

The importer reads only the `Congressional Districts` layer, verifies that every feature belongs to the 120th Congress, transforms the NAD83 geometry to WGS84, and stores it as a separate 2026 geography version. State legislative layers remain available in the source package for a future importer. Missouri is imported exactly as provided by Census. The source ZIP is ignored by Git and can be removed after a successful import if it is backed up elsewhere.

## Ballotpedia 2026 congressional candidate roster

Place `ballotpedia_2026_congressional_candidates.csv` in the repository root. Validate the complete roster without retaining candidate rows, then commit it:

```bash
npm run import:ballotpedia:candidates:2026
npm run import:ballotpedia:candidates:2026 -- --commit
```

The importer requires all 436 in-scope House races and all 33 regular Senate races, maps House candidates to the imported 120th-Congress districts, and excludes the four territories outside the application's current scope. Every entry is stored in `candidate_roster_entries` with `source_listed` status, provisional identity metadata, the raw party label, and source provenance. Likely name aliases remain separate until a stable source identifier supports merging them. The source CSV is ignored by Git.

### Reconcile the current 2026 congressional field

The live collector uses public Wikimedia and FEC bulk data; it does not require an API key or account. It requires Python 3 plus Requests and Beautiful Soup:

```bash
python -m pip install -r requirements-importers.txt
```

Run the complete collection and database reconciliation as a dry run, then review `data/wikipedia2026/output/audit.csv`, `errors.csv`, and `manifest.json`:

```bash
npm run sync:wikimedia:nominees:2026
```

Commit that exact cached collection with:

```bash
npm run sync:wikimedia:nominees:2026 -- --skip-fetch --commit
```

The collector requires all 435 voting House districts, D.C.'s non-voting delegate race, and all 33 regular Senate races. House candidates come from the nationwide election tables. Senate general-election result tables are preferred; where an article has no pre-populated general table yet, the fallback accepts explicit party `Nominee` sections and separately audits independent/minor-party `Candidates` or `Declared` sections. The latter remain `source_listed`, rather than being promoted to `general_candidate`, until an official state ballot source confirms qualification.

The FEC candidate master file supplies stable candidate IDs when a state/office/name match is unique; it is never treated as proof of ballot qualification. Every Wikimedia page ID and revision, CC BY-SA attribution, source URL, extraction method, FEC match method, checksum, and collection time is retained. Requests are sequential, cached, identify this project in the user agent, honor retry delays, and never disable TLS verification. Use `--refresh` only when intentionally replacing the cache with a newer snapshot.

The older Ballotpedia live collector remains in the repository for reproducibility, but Ballotpedia's human-verification/WAF flow blocks unattended personal-project collection. It is not the recommended sync path.

## API

- `GET /api/health`
- `GET /api/races?type=general|primary|runoff|special|presidential_primary|presidential_general`
- `GET /api/races?cycle=2020&office=President&query=National`
- `GET /api/archive/facets`
- `GET /api/hub/options`
- `GET /api/hub/overview?office=president&cycle=2020&stage=general`
- `GET /api/hub/electoral-college?cycle=2024`
- `GET /api/hub/outlook?office=us_senate&cycle=2026`
- `GET /api/hub/districts?cycle=2020&stage=general`
- `GET /api/hub/contests/:id/geographies?level=county|precinct`
- `GET /api/races/:id/history`
- `GET /api/storage`
- `GET /api/ingest-runs` (administrator authentication required)
- `POST /api/refresh` (administrator authentication required; legacy route returns `501`)
- `GET /api/polls`, `GET /api/polls/facets`, `GET /api/poll-averages`
- `GET /api/admin/imports`, `POST /api/admin/imports`, `GET /api/admin/imports/:id`, `POST /api/admin/imports/:id/commit`, `POST /api/admin/imports/:id/retry`, `POST /api/admin/nyt-refresh` (administrator authentication required)

There is deliberately no generic result-write endpoint. Results enter through validated, source-specific importers that create provenance records, immutable result batches, snapshots, reporting status, and vote totals in one transaction. Presidential Electoral College data has its own state allocations and append-only future update path; see the [Electoral College guide](docs/electoral-college.md).

## Normalized data model

- `candidates` stores people independently of an election or party label.
- Application entities use PostgreSQL UUID primary and foreign keys; vote counts, byte sizes, and other measurements remain numeric.
- Candidate UUIDs are deterministic UUIDv5 values derived from a reviewed canonical key. State-specific source identifiers are namespaced aliases, so the same presidential candidate resolves to the same UUID in every state and after a database rebuild.
- `election_events` stores cycle, stage, election dates, and geographic scope.
- `contests` connects an event to an office and district; `contest_choices` represents candidates, tickets, write-ins, or other ballot choices in that contest.
- `result_batches` and `result_snapshots` preserve source timestamps and revision history.
- `vote_totals` stores votes by snapshot, reporting geography, ballot choice, vote type, and tabulation round. Contest-wide totals use the contest district as their reporting unit so detail rows are never accidentally double-counted.
- `geographies`, `geography_versions`, and `geography_relationships` support dated PostGIS boundaries, containment, reporting relationships, and crosswalk allocations.
- `polls`, `poll_questions`, and `poll_responses` are separate from official results. Source questions retain their own sampling and immutable revisions; generic ballot and approval questions do not require a contest.
- `published_poll_averages` stores attributed publisher time series independently of `model_estimates`. `admin_imports` records staging, confirmation and publication audit state.
- `model_runs` and `model_estimates` are reserved for future model output. The current descriptive polling average is calculated for display and does not change source vote totals.
- `data_sources`, `source_artifacts`, source-ID mapping tables, and `ingestion_runs` preserve lineage and importer audit data.

## Data scope and current limits

- General election results begin in 2000; primary results and polling observations begin in 2014. Historical local races and ballot measures are outside the current scope.
- VEST and MEDSL result importers, Census boundaries, candidate-source importers, and NYT poll imports are implemented. OpenElections, state-office feeds, and AP Elections are not.
- Administrator uploads and the six-file NYT refresh are manual; no scheduler or general live-results feed is configured. `GET /api/storage` reports database size and record counts.
- The polling outlook is descriptive. It does not estimate win probabilities, calibrated uncertainty, or election-night outcomes.

## Before deployment

Set a random `ADMIN_IMPORT_TOKEN` of at least 32 characters, use HTTPS, and protect the single-operator credential. Back up PostgreSQL together with `.import-storage/`; its staged artifacts are referenced by database records. Configure production database credentials and review source-specific licensing and attribution.

## Verification

Run `npm run check`, `npm run test:schema`, `npm run test:electoral`, `npm run test:outlook`, and `npm run build`. Python parser tests require the packages in `requirements-importers.txt`; `test:imports` additionally needs a migrated local database and separately downloaded files.

## Planning documents

- [Collection and processing plan](docs/data-collection-plan.md)
- [VEST 2020 source mapping](docs/vest-2020-mapping.md)
- [Presidential primary delegate model](docs/presidential-delegate-model.md)
- [Presidential Electoral College results](docs/electoral-college.md)
- [Data-source research register](docs/source-research.md)
