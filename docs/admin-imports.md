# Admin imports

The admin workflow is available under **Admin imports** (`/#admin`). Published raw polls are under **Polls** (`/#polls`); state result pages also show polling filtered by state, office, cycle, and stage.

## Start and authenticate

Set `ADMIN_IMPORT_TOKEN` to a cryptographically random secret of at least 32 characters in `.env` or **in the API process environment**, then start the application using Node 22 or newer. Do not put it in a `VITE_` variable. The API, migration command and local admin importer load `.env`; existing process environment variables take precedence. In PowerShell, environment variables can also be set with `$env:ADMIN_IMPORT_TOKEN` before `npm.cmd run dev`.

Generate a secret with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Enter that secret in the admin page. It is retained in React memory only, not browser storage. Lock the page to clear it. Use HTTPS when accessing the app remotely, and restrict the server environment and import storage to the service operator. Authentication is a single operator bearer credential; there is no multi-user account management or per-person identity audit.

Without a sufficiently long configured token, all admin endpoints return 503 and the worker is disabled. With one configured, every upload, preview, commit, retry and history request requires `Authorization: Bearer …`. `/api/ingest-runs` and the legacy `/api/refresh` are also authenticated. Refresh remains an authenticated 501; uploads use the new workflow.

## Review and publish

1. Drop one or more CSVs/ZIPs onto the upload target, or choose files. Each selected file gets an independent preview. A ZIP can group compatible CSVs into a single atomic import. Different sources or MEDSL vintages must be uploaded separately.
2. Optionally provide the original download URL and a dataset-specific license override **before** uploading. Default source documentation is shown in the preview. Formats identify a proposed source, not proof that a third-party file really came from that publisher.
3. The background worker validates content and executes the actual persistence path in a transaction which it rolls back. Review scope, source row/question/contest counts, proposed new records, unchanged/revised records, skipped rows/files, mapping details and warnings.
4. Check the review acknowledgement and select **Confirm import**. Confirmation is bound to the exact staged preview and serialized plan checksum. Publication and the completed job status commit in one database transaction.
5. The history panel reports progress and the final audit. Failed commits retain an ingestion-run failure and roll back publication. Retry uses the same source bytes and confirmed plan. A worker restart safely resumes interrupted jobs using a PostgreSQL advisory lock. A completed identical artifact produces an audited no-op, including when its filename changes.

No deletion is inferred from an omitted poll or result. Corrections append question revisions, published-average observations or result snapshots. Concurrent admin imports are serialized. A preview's new/existing counts describe the database at validation time; another confirmed job may make some entries unchanged before publication, and the final audit reports the actual outcome. Do not run legacy repair/replace CLI imports concurrently with admin imports.

## Supported formats

| Adapter | Scope and identification | Safeguards / limitations |
| --- | --- | --- |
| NYT election polls | Supplied 50-column-style CSV with `poll_id`, `question_id`, `race_id`, `candidate_id`, `pollster_id`, election fields and percentages; President, Senate, House and Governor | Reads actual cycle, state, seat, stage and ranked-choice fields. General, primary, primary runoff, special, special primary and special runoff are retained exactly. Includes generic congressional ballot and hypothetical matchups. No filename-derived identity. |
| NYT approval polls | Supplied question CSV with `politician`, `yes`, `no`, `alternate_answers` | Approval questions have no official contest. Approve/disapprove shares remain published values. Unlabeled alternate-answer values are retained in raw response metadata, without inventing labels. |
| NYT published averages | `topic,date,answer,pct`; reviewed topic `2025 Approval - Trump` | Mapped to the stable series `nyt:approval:trump:2025`, distinct from polls and Signal model estimates. Unknown topics are rejected pending a documented series mapping. |
| MEDSL 2024 | State precinct CSVs or nested state ZIPs from [2024-elections-official](https://github.com/MEDSL/2024-elections-official), with the documented precinct schema and row scope `year=2024`, `stage=GEN` | President, Senate, House and Governor; special flags retained. Exact duplicates are omitted, TOTAL modes take precedence over their components, parent rollups/statistics are excluded, fusion lines combine into a candidate, and presidential identities remain national. State abbreviation/FIPS must agree. Partial state collections are allowed and disclosed; completeness/certification is not asserted. |
| MEDSL 2024 companion summaries | Known President/Senate state and Senate county schemas, **in a ZIP alongside the corresponding state precinct ZIPs/CSVs** | Reuses the repository reconciler, retains raw summaries and a checksummed reconciliation manifest. Requires full precinct-county coverage before Senate county reconciliation; ambiguous duplicate summaries fail. Summary rows outside the supplied state contests are counted as unmatched. Standalone summary uploads are rejected with instructions. |
| MEDSL 2020 House | Exact 25-column `HOUSE_precinct_general.csv` schema, raw CSV or ZIP | Only `year=2020`, `stage=GEN`, House/delegate offices. Preserves deterministic state candidate identities. Omits suppressed negative values, duplicate rows, aggregate reporting rows and component modes when TOTAL exists. Other offices/years/stages fail explicitly. |
| VEST 2020 | Dataverse outer ZIP for [doi:10.7910/DVN/K7760H](https://doi.org/10.7910/DVN/K7760H), containing `documentation.txt` and standard nested state archives | Uses the existing documented DBF-column mapping, deterministic presidential identities, projection/geometry validation and county crosswalk logic. All selected states publish in one transaction. Existing artifacts are skipped without invoking the legacy historical-repair path. Supplemental VTD archives are not automatically selected. |

MEDSL is not a universal CSV schema. Primary/runoff files, other years, other MIT repositories, arbitrary summaries, and unsupported VEST layouts are rejected rather than guessed. To add one, supply the **exact CSV/ZIP, repository/download URL and codebook**. The currently missing real-file fixtures are `us_house_2020.zip` (including `HOUSE_precinct_general.csv`, `README.md`, `2020-precincts-codebook.md`) and `dataverse_files.zip` from the cited VEST dataset. Their parser/transaction integration exists, but those complete real downloads were not available for end-to-end validation.

The local `2024_results/ar24.zip` contains **Alaska**, illustrating why content is authoritative. The local `2024_results/2024-president-state.csv` contains `.Rhistory`, `.RData`, `.DS_Store`, **not election data**, and is rejected. Replace it with the actual [`2024-president-state.csv`](https://github.com/MEDSL/2024-elections-official/blob/main/2024-president-state.csv) download if statewide presidential reconciliation is needed. MEDSL's documented state-specific coverage warnings still apply, especially missing Louisiana early votes and Indiana straight-ticket overreporting.

## Poll identity, attribution and historical revisions

One survey uses `nyt:poll:<poll_id>` across files. Pollsters use `nyt:pollster:<pollster_id>` and source races use `nyt:race:<race_id>`. Questions use a namespaced `question_id` plus the source ranked-choice round. Candidate responses retain `nyt:candidate:<candidate_id>` as source identities. Non-candidate/approval answers remain response identities. Display names and filenames are never survey, person or race identities.

`polls` represents survey identity. `poll_questions` retains each observation's geography, field dates, sample size, population, subpopulation, cycle, office, stage and raw metadata. Changed question content creates a revision referring to the previous observation; old responses remain available in the database. The public view selects the newest observation per source question. Published shares are not normalized, numeric grades are not fabricated, and no poll import writes `model_estimates` or official ballot choices.

An exact, unique general-election date/state/office match may link a question to an existing official contest. Otherwise it remains a source race and is browsable through polling filters. Primary party, unknown district-map vintage, ballot qualification and name-only candidate matches are not inferred. House seat identifiers remain in source metadata; congressional boundaries are not rewritten or borrowed from another cycle.

NYT pages display **Polling data compiled by The New York Times**, a source link, a [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) link, a statement that percentages are unchanged and records mapped for display, and each artifact's license override. The supplied request identifies the polling datasets as CC BY 4.0 unless otherwise noted. Attempts to retrieve the NYT source/license page during implementation were blocked; the license declaration is retained on that supplied basis, **not claimed as independently verified**. Record the exact download URL and any exception for future files. MEDSL's repository/codebook was verified, but no blanket MIT license is assumed; dataset-specific terms can be recorded on upload.

## Storage and operations

For local operator use, the same staging and transaction path is available without a browser:

```powershell
npm.cmd run import:admin -- --polling-dir polling
npm.cmd run import:admin -- --polling-dir polling --commit
# Or one CSV/ZIP:
npm.cmd run import:admin -- --file "path/to/download.zip" --commit
```

The first command only stages previews. `--commit` is explicit publication confirmation; every file is first fully validated and then committed, with the same history and provenance as browser imports. Already imported artifacts are no-ops. The command applies pending migrations, uses the running worker when available, or obtains its lock and processes jobs locally. It requires local database credentials, not an HTTP token. There is no public CLI endpoint.

Raw uploads and staged plans live under `.import-storage/` by default, outside `dist` and any static route, with opaque server-generated directory names. `IMPORT_STORAGE_DIR` overrides this path. Unix creation modes are directory 0700/file 0600; on Windows, restrict the folder through inherited service-account ACLs. Back up this folder **with PostgreSQL**: DB artifact URIs reference the retained files. There is no automatic artifact deletion or retention policy.

Defaults: `IMPORT_MAX_BYTES=536870912` (512 MiB), `IMPORT_MAX_EXPANDED_BYTES=2147483648` (2 GiB), `IMPORT_MAX_ENTRY_BYTES=536870912` (512 MiB per ZIP member), 500 entries and two nested ZIP levels. For larger national MEDSL/VEST downloads, raise the upload, member and expansion limits to match the measured download and available worker memory. Unsafe paths, duplicate members, symlinks, encryption and excessive expansion ratios are rejected. Members are streamed to opaque private names, never extracted to source-supplied paths. Checksums are verified again before publication. Polling CSVs are parsed in the isolated worker; the HTTP process remains responsive.

Authentication is evaluated before reading request bytes. Upload with `Content-Type: application/octet-stream` and a plain `filename` query parameter. Uploads return 202. There is no unauthenticated generic write endpoint.

Authenticated API:

- `GET /api/admin/session`
- `POST /api/admin/imports?filename=…&sourceUrl=…&license=…`
- `GET /api/admin/imports` / `GET /api/admin/imports/:id`
- `POST /api/admin/imports/:id/commit` with JSON `{ "confirmation": "<preview token>" }`
- `POST /api/admin/imports/:id/retry`

Public read-only API: `/api/polls`, `/api/polls/facets`, `/api/poll-averages`. Poll filters include `state`, `office`, `cycle`, `stage`, `kind`, `race`, `offset`, `limit` (maximum 100).

## Verification

Run `npm run check`, `npm run test:schema`, `npm run test:imports`, and `npm run build`. On Windows shells with a signed-script restriction, use `npm.cmd`.

`test:imports` needs the supplied ignored `polling/` files and `2024_results/ar24.zip`, and a migrated development database. All database mutations in this suite are rolled back. It verifies real sample counts, source identity across files, question sampling, immutable corrections, idempotency, failure rollback, authentication, CSV quoting and ZIP safety.

`npm run test:imports:e2e` requires PostgreSQL permission to create/drop a **disposable test database**, port 3197 (override `IMPORT_TEST_PORT`), and the supplied files. It launches a separate API/worker, publishes only in the disposable database, verifies all six polling downloads and a real MEDSL state ZIP through HTTP, rejects stale confirmations, verifies no-op retries and public hub/poll queries, then drops its generated database. Private test artifacts remain under ignored `.tmp/import-check-storage` for inspection. The production/user database is not populated by this test.
