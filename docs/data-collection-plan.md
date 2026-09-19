# Election data collection and processing plan

## Purpose and boundaries

This plan separates four pipelines that share geography and provenance primitives but have different business rules:

1. certified historical general-election results (2000 onward);
2. non-presidential primary results (2014 onward);
3. presidential nomination contests and delegate allocation (2014 onward); and
4. polling observations (2014 onward).

Election-night data is a fifth, append-only snapshot stream layered on the same contest model. It is refreshed only by an explicit user action and is never silently promoted to certified history.

## Shared canonical model

Every importer should produce records in the following common layers before domain-specific calculation:

| Layer | Stable identity | Key fields | Notes |
| --- | --- | --- | --- |
| Geography | `geographies`, `geography_source_ids`, `geography_versions`, `geography_relationships` | type, name, FIPS codes, dated geometry and relationships | Precincts are versioned because boundaries and names change. |
| Election event | `election_events`, `election_source_ids` | dates, cycle, stage, scope geography | A primary runoff is a distinct event. |
| Contest | `contests`, `contest_source_ids`, `offices` | event, office, district, primary party, voting method | Presidential nomination contests use a specialized extension. |
| Choice | `contest_choices`, `contest_choice_candidates`, `contest_choice_source_ids` | ballot label, candidate/ticket members, party, write-in status | Never infer candidate identity from name alone. |
| Results | `result_batches`, `result_snapshots`, `reporting_unit_statuses`, `vote_totals` | source/retrieval time, reporting status, votes by choice/unit/type/round | Snapshots are immutable; corrections append a new version. |
| Polling | `pollsters`, `polls`, `poll_questions`, `poll_responses` | field dates, population, sample, question, toplines | Poll responses never share the official-results tables. |
| Models | `model_runs`, input-link tables, `model_estimates` | version, as-of time, parameters, exact inputs, estimates | Projections never overwrite source vote totals. |
| Provenance | `data_sources`, `source_artifacts`, `ingestion_runs` | URI, retrieval time, checksum, parser version, license | Preserve raw source artifacts outside PostgreSQL when practical. |

The reusable geographic relationship is a **versioned containment graph**, not a permanent tree:

```text
precinct/reporting unit -> county or county-equivalent -> state -> nation
district/ward          -> one or more precinct portions
```

Store `valid_from`, `valid_to`, and source-specific identifiers on nodes and edges. A reporting unit may be a precinct, county, congressional district, absentee bucket, or statewide total; do not force every result into a precinct. Overlapping districts require many-to-many crosswalks and allocation fractions rather than a single parent column.

## Pipeline A: historical general elections

### Collection

1. Prefer official state election exports for certified totals.
2. Use OpenElections as a normalized acquisition layer and VEST for precinct-level research/cross-checks.
3. Retain each downloaded file unchanged with checksum, retrieval date, source URL, and declared certification status.
4. Import federal offices and governors from 2000 onward. Exclude other statewide offices, ballot measures, and municipal/county contests.

### Processing

1. Parse source columns into staging tables without destructive cleanup.
2. Normalize office, party, candidate, district, vote mode, and reporting-unit identifiers.
3. Resolve precinct aliases against the geography version applicable on election day.
4. Aggregate precincts to county and state using explicit containment edges.
5. Compare calculated totals with source-published county/state totals; store both when they disagree.
6. Promote a dataset only after row counts, vote totals, duplicate keys, and provenance checks pass.

## Pipeline B: non-presidential primaries

Use the shared election, contest, candidate, geography, result, and provenance modules. Add party, primary format, runoff rules, and advancement status. Keep party contests separate even when they share an election date. A top-two/top-four or nonpartisan qualifying election must be represented by its actual advancement rule rather than coerced into party-primary semantics.

Primary results begin in 2014. Historical local primaries remain excluded. Outcome logic should be a versioned rule attached to the contest; raw vote totals must never be changed when the rule implementation changes.

## Pipeline C: presidential nomination contests

Presidential primaries and caucuses must not reuse the ordinary primary outcome calculator. They share candidates, events, geography, votes, sources, and snapshots, but delegate allocation is a separate rule-driven ledger. See [Presidential delegate model](presidential-delegate-model.md).

## Pipeline D: polling

Polling shares candidate/party/contest identity and geography, but it does **not** share result aggregation. Store each published topline and its metadata: pollster, sponsor, partisan sponsorship, field dates, sample size, population, mode, question wording, geography, source URL, publication/retrieval time, and revision lineage.

Keep raw toplines immutable. Store calculated weights and averages in versioned runs containing algorithm version and all inputs. Pollster classifications (including a future AAA designation) are effective-dated metadata, not hard-coded arithmetic.

## Manual election-night refresh

An on-demand refresh should execute as a job with these phases:

1. acquire provider payload and write a content-addressed raw artifact;
2. validate schema and election/contest identifiers;
3. normalize reporting units and choices;
4. append a timestamped snapshot in one transaction;
5. run monotonicity and total-consistency warnings (corrections can legitimately reduce totals);
6. calculate cached county/state rollups;
7. publish the completed snapshot pointer to the UI; and
8. record duration, rows, bytes, warnings, parser version, and failure details.

Each snapshot may contain source reporting-unit rows and a contest-wide summary row. The summary row uses the contest's `district_geography_id` and records whether it was source-reported or calculated by `sum_of_reporting_units`; consumers must not sum mixed geography levels.

The UI must show source timestamp, application retrieval timestamp, percent reporting definition, and unofficial/certified status. A failed refresh leaves the last successful snapshot visible and clearly labeled.

## Storage controls

- Keep normalized data and spatial indexes in PostgreSQL/PostGIS; keep compressed raw files in a partitioned `data/raw/{source}/{year}/{event}` directory or object store.
- Record artifact byte counts in the ingestion ledger and expose database plus raw-artifact usage in the UI.
- Use content hashes to avoid storing identical provider payloads twice.
- Retain all certified snapshots, first and final election-night snapshots, snapshots containing a value change, and correction boundaries. Make dense unchanged snapshots eligible for compaction.
- Run `CHECKPOINT` after large imports and offer an explicit maintenance command rather than automatic background work.
- Treat the configured size limit as a preflight budget: estimate incoming artifact and database growth before starting an import.

## Acceptance tests for every adapter

- fixture parser test using a preserved source sample;
- idempotent re-import test;
- duplicate candidate/reporting-unit detection;
- precinct-to-county-to-state reconciliation with documented exceptions;
- missing/unknown vote-mode preservation;
- source checksum and parser-version capture;
- certified versus unofficial separation; and
- policy rejection tests for out-of-scope years, offices, and local contests.

