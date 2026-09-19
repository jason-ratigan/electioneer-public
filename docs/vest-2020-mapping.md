# VEST 2020 precinct-data mapping

## Inspected source artifact

- Dataverse dataset: `doi:10.7910/DVN/K7760H`, version 48.
- Local artifact: `dataverse_files.zip` (699,711,042 bytes).
- SHA-256: `84341c695782eee4eff48a699a942b3eb3efe849cbc052cc411e5a2085c09cee`.
- Contents: `documentation.txt` plus 53 state/DC archives. Kentucky and New Jersey also have alternative VTD-estimate archives.
- License declared in the included documentation: CC BY 4.0.

The outer ZIP becomes one `source_artifacts` row. Every nested state ZIP becomes a child artifact with a URI such as `zip://dataverse_files.zip!/de_2020.zip`. Import identities use a namespace such as `vest:2020:de`; source identifiers are not globally unique across state files.

## Initial scope

Only general-election columns matching these office codes are imported initially:

| Pattern | Office | Contest district |
| --- | --- | --- |
| `G20PRE*` | President | State geography for result display; national aggregation is derived separately |
| `G20USS*` | U.S. Senate | State geography |
| `G20H##*`, `G20HAL*`, `G20DEL*` | U.S. House/delegate | Congressional-district geography |
| `G20GOV*` | Governor | State geography |

Other statewide, legislative, judicial, local, and ballot-measure columns remain in the raw artifact but are outside the agreed historical scope.

## Canonical mapping

| VEST element | Normalized destination | Rule |
| --- | --- | --- |
| Dataset and state ZIP | `source_artifacts` | Store URI, retrieval time, SHA-256, byte size, license, and parent artifact. |
| State archive/import attempt | `ingestion_runs` | Record parser version, rows read/added/updated, warnings, and terminal status. |
| State | `geographies` | `geography_type = 'state'`; use Census state FIPS and postal abbreviation. |
| DBF precinct identifier | `geographies`, `geography_source_ids` | One precinct geography per namespaced source identifier. Do not infer identity from its display name alone. |
| Shapefile polygon | `geography_versions` | Transform the source CRS to EPSG:4326, coerce to `MULTIPOLYGON`, attach the state artifact, and record known election-day validity. |
| State-to-precinct membership | `geography_relationships` | Add a dated `contains` relationship. County membership is added only from an explicit field or spatial crosswalk. |
| 2020 general election | `election_events`, `election_source_ids` | `cycle = 2020`, `stage = 'general'`, election date `2020-11-03`, scope = state. |
| Office-code group | `contests`, `contest_source_ids` | Group candidate columns by `PRE`, `USS`, `H##`/`HAL`/`DEL`, or `GOV`. |
| Documented candidate and party | `candidates`, `candidate_source_ids`, `parties`, `contest_choices` | A reviewed canonical key produces a deterministic candidate UUID. Every state-specific column is stored as a namespaced alias to that candidate. Party belongs to the contest choice. |
| Full vote-column label | `contest_choice_source_ids` | Store labels such as `G20PREDBID` in the state namespace. |
| Numeric DBF cell | `vote_totals` | Key by snapshot, precinct, choice, vote type `total`, and round `0`; preserve reported zero separately from missing/suppressed. |
| State or district sum | `vote_totals` | Store a contest-summary row at the contest district with `tabulation_method = 'sum_of_reporting_units'`. |
| Documented allocation/estimate | `vote_totals` and metadata | Set `is_estimated = true`, use `tabulation_method = 'allocated'` where applicable, and preserve the documentation excerpt/method. Never present allocated precinct values as untouched official precinct returns. |
| One completed state import | `result_batches`, `result_snapshots` | Use `certified` only when supported by the underlying source notes; record VEST publication and local retrieval separately. |

## Verified Delaware fixture

The nested `de_2020.zip` artifact is 1,622,730 bytes with SHA-256 `d93baf36974b5742656d5acc58a52b4d7afa6f102ec2e35bb9e0ec13ccaa0556`.

- 434 polygon records.
- Identifier field: `PRECINCT` (five characters).
- Encoding: UTF-8.
- Source CRS: WGS 1984 Web Mercator Auxiliary Sphere; transform to EPSG:4326 during import.
- Initial-scope contests: President, U.S. Senate, at-large U.S. House, and governor.
- Four documented choices per included contest, producing 16 included vote columns.
- The documentation says three countywide UOCAVA reporting units were distributed to precincts by candidate share. Imported Delaware precinct vote rows therefore need allocation provenance and `is_estimated = true`.

Verified statewide sums from the precinct fields:

| Contest | Choice column | Candidate/choice | Party | Votes |
| --- | --- | --- | --- | ---: |
| President | `G20PREDBID` | Joseph Biden | Democratic | 296,268 |
| President | `G20PRERTRU` | Donald Trump | Republican | 200,603 |
| President | `G20PRELJOR` | Jo Jorgensen | Libertarian | 5,000 |
| President | `G20PREGHAW` | Howie Hawkins | Green | 2,139 |
| U.S. Senate | `G20USSDCOO` | Chris Coons | Democratic | 291,804 |
| U.S. Senate | `G20USSRWIT` | Lauren Witzke | Republican | 186,054 |
| U.S. Senate | `G20USSLFRO` | Nadine Frost | Libertarian | 5,244 |
| U.S. Senate | `G20USSITUR` | Mark Turley | Independent | 7,833 |
| U.S. House (at-large) | `G20HALDROC` | Lisa Blunt Rochester | Democratic | 281,382 |
| U.S. House (at-large) | `G20HALRMUR` | Lee Murphy | Republican | 196,392 |
| U.S. House (at-large) | `G20HALLROG` | David Rogers | Libertarian | 3,814 |
| U.S. House (at-large) | `G20HALIPUR` | Catherine Purcell | Independent | 6,682 |
| Governor | `G20GOVDCAR` | John Carney | Democratic | 292,903 |
| Governor | `G20GOVRMUR` | Julianne Murray | Republican | 190,312 |
| Governor | `G20GOVLMAC` | John Machurek | Libertarian | 3,270 |
| Governor | `G20GOVIDEM` | Kathy DeMatteis | Independent | 6,150 |

These sums are validation targets, not additional raw observations. The importer should calculate them from precinct rows and fail or warn when they differ.

### Cross-state presidential identity

Presidential candidates resolve through the shared registry in `server/importers/vest2020/presidentialCandidates.js`. The registry maps reviewed source names to a canonical key; the key produces a deterministic UUIDv5 in the fixed Electioneer candidate namespace. For example, every reviewed state alias for `joseph-r-biden-jr` resolves to the same candidate UUID even when a state uses a different party code or column suffix.

Each source alias is also retained in `candidate_source_ids` under a namespace such as `vest:2020:de` or `vest:2020:pa`. An unknown presidential key, an unreviewed name, or an alias already assigned to another person stops the transaction.

## Adapter acceptance gate

Before importing all states, the Delaware adapter must demonstrate:

1. deterministic candidate/party/contest mapping from a reviewed manifest;
2. idempotent re-import of the same artifact and namespace;
3. 434 valid precinct geometries in EPSG:4326;
4. exact reconciliation to every statewide sum above;
5. explicit allocation warnings and estimated flags;
6. no out-of-scope office columns imported; and
7. a failed transaction leaves no partial batch or result snapshot.

## Delaware dry-run result

Run with `npm run import:vest:de`. Add `-- --commit` only after reviewing the validation report.

The implemented dry run validates 434 precincts, four contests, 16 choices, 6,944 precinct vote totals, 16 contest-summary totals, and 1,736 reporting-unit status rows. All 16 statewide sums reconcile. VEST precinct `05-09` contains a source self-intersection near `-75.563562, 39.483290`; the importer applies `ST_MakeValid`, retains only polygonal output, records the repair reason, and verifies all 436 resulting precinct/state/district geometries before rollback or commit.
