# Data-source research register

This is a source-evaluation register, not an endorsement. Source formats, revisions, URLs, and licensing terms must be recorded and revalidated for each adapter release.

| Source | Candidate use | Questions before implementation |
| --- | --- | --- |
| [OpenElections](https://openelections.net/) and [GitHub organization](https://github.com/openelections) | Normalized historical election results and state repositories. | Coverage by year/office, schema differences among repositories, corrections, license, stable release strategy. |
| [VEST 2020 Precinct-Level Election Results](https://dataverse.harvard.edu/dataset.xhtml?persistentId=doi:10.7910/DVN/K7760H) | Initial 2020 precinct-level general-election import for President, U.S. Senate, U.S. House, and governor. | Map each state archive's column codes and reporting-unit identifiers; preserve documented allocations/estimates; pair results with the appropriate geometry vintage. Dataset version 48 is unrestricted and declares CC BY 4.0. |
| [U.S. Election Assistance Commission](https://www.eac.gov/) | Election administration references and common-data-format work. | Which Election Results Common Data Format version and implementation guidance apply to each adapter. |
| [NIST Election Results Common Data Format](https://pages.nist.gov/ElectionResultsReporting/) | Canonical terminology and interoperability model. | Map its reporting units, contests, candidates, and result statuses to the local schema without discarding source fields. |
| [Census TIGER/Line](https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html) | State/county identifiers, voting district geometry, and geographic vintages. | Voting-district availability by vintage, precinct mismatch strategy, and PostGIS import strategy. |
| [Federal Election Commission election results](https://www.fec.gov/introduction-campaign-finance/election-results-and-voting-information/) | Federal certified historical cross-checks. | Machine-readable coverage, amendment/version handling, and contest identifiers. |
| State election offices | Authoritative certified state results and election-night feeds where provided. | Per-state format, terms, certification signals, stable URLs, identifiers, and correction behavior. |
| [AP Elections API](https://developer.ap.org/ap-elections-api/) | Licensed normalized election-night results. | Contract, credentials, permitted storage/retention, call limits, result status semantics, and test fixtures. |
| Democratic and Republican national/state party rulebooks | Presidential delegate plan and confirmed allocation inputs. | Obtain cycle-specific official rules and amendments; model state-party deviations and later adjustments. |

## Research checklist per source

Record an owner, date reviewed, official documentation URL, access method, authentication, update/correction behavior, temporal and geographic coverage, schema sample, license/retention terms, expected volume, and a go/no-go decision. Save permitted sample artifacts as parser fixtures with checksums.

