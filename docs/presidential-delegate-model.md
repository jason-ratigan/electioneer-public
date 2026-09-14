# Presidential primary delegate model

## Critical distinction

Presidential nomination delegates are **not Electoral College electors**. The interface may use a similar state-to-national accumulation visual, but the entities, calendars, governing rules, thresholds, and outcomes are different. Primary/caucus votes can influence delegate allocation; delegate counts are then tracked toward a party nomination threshold. The general-election Electoral College belongs in a separate module.

## What overlaps with other elections

Reuse these modules:

- election events and jurisdictions;
- canonical candidate and party identity;
- geographic/reporting-unit graph;
- timestamped vote snapshots;
- source artifacts, checksums, and provenance;
- manual ingestion jobs and storage accounting; and
- raw vote aggregation and reconciliation.

Do not reuse these calculations:

- ordinary primary winner/advancement logic;
- general-election winner logic;
- Electoral College allocation; or
- a single national vote-share-to-delegate formula.

## Required delegate entities

| Entity | Purpose |
| --- | --- |
| `nomination_cycle` | Party, cycle, convention, nomination threshold, rulebook version. |
| `delegate_plan` | State/territory/party-specific plan with effective dates and source document. |
| `delegate_pool` | Separately allocated pool, such as statewide or congressional-district delegates. |
| `allocation_rule` | Method, threshold, rounding, minimums, caps, trigger conditions, and tie procedure. |
| `allocation_input` | Certified or projected vote basis used for one calculation run. |
| `delegate_award` | Candidate, pool, count, status, allocation run, and timestamp. |
| `delegate_adjustment` | Reallocation, penalty, bonus, withdrawal, convention, or correction entry. |
| `delegate_ledger` | Append-only sum of awards and adjustments by candidate/status. |

Delegate status should distinguish at least `projected`, `allocated`, `selected`, `bound/pledged`, `unbound/unpledged`, `reallocated`, and `certified` where applicable. Do not collapse these into one number. The dashboard can choose a display measure while retaining the distinctions.

## Rule representation

Rules are data, versioned by party, jurisdiction, cycle, and effective period. The calculator must support composable operations rather than state-specific `if` statements scattered through application code:

1. choose eligible vote total and denominator;
2. apply viability/qualification thresholds;
3. detect winner-take-all or winner-take-most triggers;
4. allocate proportionally within each pool;
5. apply minimum/maximum awards;
6. round using the rule's named method;
7. resolve remainder delegates and ties using explicit ordering;
8. apply party penalties or bonuses separately; and
9. emit a full calculation trace.

Example rule document shape (illustrative, not a rule for any actual jurisdiction):

```json
{
  "scope": { "party": "example", "cycle": 2028, "jurisdiction": "EX" },
  "pools": [
    { "id": "statewide", "delegates": 10, "method": "proportional", "threshold": 0.15, "rounding": "largest_remainder" },
    { "id": "district-01", "delegates": 3, "method": "winner_take_all", "threshold": 0 }
  ]
}
```

## Calculation-run contract

Every calculation is immutable and records:

- rulebook and structured-rule versions;
- source vote snapshot IDs;
- delegates available by pool;
- eligible/excluded candidates and reasons;
- denominator and threshold computations;
- pre-round and post-round awards;
- remainder and tie resolution;
- validation warnings; and
- whether output is a projection or based on certified inputs.

Re-running after a correction creates a new run. The current view points to the chosen run; historical runs remain reproducible.

## Validation invariants

- Awards within a pool must equal its available delegates unless the rule explicitly permits vacancies.
- A candidate cannot receive a negative delegate balance.
- The same delegate cannot be counted in multiple pools.
- National totals equal the sum of the selected ledger status categories, not a second independent calculation.
- Vote changes never mutate an earlier allocation run.
- Manual adjustments require a reason, source, timestamp, and author.
- Projected and official/party-confirmed delegate counts remain separately queryable.

## Interface plan

Provide a dedicated **Presidential primaries** area rather than mixing these contests into the ordinary Primaries filter:

- national progress toward the party-specific nomination threshold;
- state/territory calendar and status;
- state total expandable into delegate pools;
- votes/counting progress beside, not substituted for, delegates;
- a calculation trace explaining each award;
- separate projected and confirmed totals; and
- rule/source links and “last recalculated” timestamps.

## Implementation sequence

1. Model delegate plans, pools, ledgers, and calculation runs without calculations.
2. Import manually verified delegate totals to exercise navigation.
3. Implement one fixture-driven rule family at a time.
4. Compare results to party-published allocations and preserve discrepancies.
5. Add projections only after official-result calculations are reproducible.
6. Keep a manual correction path with audit history for cases the rules engine cannot represent.

