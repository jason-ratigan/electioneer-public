# Map-centered polling explorer

The application opens at `/#explore`, defaulting to the 2026 Senate map. Senate and governor polls map to states; House polls map to the district identities in the imported, dated boundary collection. The 2026 House map uses the 120th Congress collection. National generic-ballot and presidential-approval observations are never assigned to local races.

Choose an office, cycle, stage and cutoff date. Select a shape or searchable race entry to see its candidate matchup, polling trend, original response shares and source links. The URL retains the office, year, date, stage, state and seat, so this view can be bookmarked. Race details link to the historical-results map for the same state and office. The poll library and administrator import pages remain accessible.

Polls appear in a scrollable table beside the map, with fixed Democratic (blue), Republican (red), and Other/undecided (neutral) columns. Multiple responses in one column stay separate and retain their published values. The Polls/Races switch and race dropdown allow navigation without leaving the map. Approval tables label the columns Approve/Disapprove instead of assigning party meaning to those responses.

Map colors use two lighter shades per party for 3–5 and 5–10 point leads, and the full shade for leads of 10 points or more. Races within 3 points remain competitive; these display bands do not alter control calculations. Manual seat calls use the full party color without implying a numeric polling margin. Trend axes fit the observed margin range with padding. Approval uses a 25–75% window, expanding only if an observation falls outside it. Axis bounds are labeled. Selected map shapes and keyboard focus use their geographic outline, not a rectangular focus box.

No new migration or re-import is needed for this feature when the supplied polling files and 2026 boundaries are already loaded. Restart the development server or rebuild for production to load the interface. For a fresh database, use the existing migration and import commands in the README. Updating the polls remains:

```powershell
npm.cmd run import:admin -- --polling-dir polling
# Inspect the preview before publication:
npm.cmd run import:admin -- --polling-dir polling --commit
```

## Polling average v1

`server/outlook/model.js` implements a descriptive D/R polling average, not an election-probability forecast. The calculation is shared with the interface and unit tests.

- Only general/special election questions from the preceding 60 days enter the calculation. The map stage is selected separately; primaries never enter general-election control totals.
- A question must have exactly one Democratic and one Republican response. Hypotheticals, subpopulations, ranked-choice rounds/reallocations, ambiguous major-party fields and questions with a third-party leader remain visible as raw observations but are excluded from the D/R average.
- Candidate source IDs define a matchup. The latest eligible question selects the default pair. Other candidate pairs can be selected; their answers are not blended. Multiple source races for one mapped seat suppress the average until their identities are resolved.
- Use one question/population per survey and only the latest qualifying survey per pollster. For equal field dates, prefer likely voters, then registered voters, then adults; sample size and question ID provide deterministic tie breaks.
- Recency weight halves every 21 days. No sample-size weighting, pollster ratings, house-effect corrections or undecided-voter allocation are applied. Published percentages are not normalized.
- A lead of less than 3 percentage points is called competitive. Larger leads are descriptive polling leads, not “safe” or “likely” election ratings. A single-poll average is explicitly labeled with one pollster.

The timeline uses the later of fieldwork end and the source's creation date, when available. It applies the latest imported revisions, **not** archived versions as they existed at the selected time. The UI calls this a reconstruction. Missing publication dates fall back to fieldwork end. Published NYT approval averages are a separate observed-date series and are not recalculated.

## Control scenarios

House totals cover 435 voting seats and exclude DC. Unpolled seats remain unassigned. Multiple records for a seat cannot add seats. Manual D/R/competitive/unassigned calls and a uniform D/R margin shift update the control bar and map; a generic-ballot lead is never automatically translated to seats.

The 2026 Senate schedule contains the 33 Class II seats plus the Florida and Ohio Class III specials. The holdover assumption is 32 Democrats, two independents counted with the Democratic coalition, and 31 Republicans. This yields a starting coalition count of 34–31 with 35 seats up. The displayed outright-majority threshold is 51; the interface notes the vice president's role at 50–50. Moving the polling date does not reconstruct historical membership. These are explicitly dated September 28, 2026 assumptions, not automatic live membership data. Scenarios reset when office, year or stage changes and are not persisted as model runs or official results.

Sources checked for the baseline and schedule:

- [Senate Class I](https://www.senate.gov/senators/Class_I.htm), [Class II](https://www.senate.gov/senators/Class_II.htm), [Class III](https://www.senate.gov/senators/Class_III.htm).
- [Florida offices up for election](https://dos.fl.gov/elections/candidates-committees/offices-up-for-election), [Ohio election directives, including 2025-54](https://www.ohiosos.gov/elections/elections-administration/directives).
- [National Governors Association election schedule](https://www.nga.org/governors/elections/). The governor map covers 36 states; territories are outside this map.

Poll data retains NYT attribution and the supplied CC BY 4.0 license. The UI identifies Signal averages and mappings as transformations. Polls do not establish ballot qualification. The model does not yet include fundamentals, incumbency, correlated polling error, turnout models, or calibrated probabilities. Sparse polling intentionally leaves control unresolved.

## Verification

```powershell
npm.cmd run test:outlook
# Read-only integration checks; requires running API and supplied data:
npm.cmd run test:outlook:api
npm.cmd run check
npm.cmd run build
```

Integration checks verify all supplied 2026 general-election question geographies, national separation, unique source races per seat, 435 voting House districts and API input validation. The supplied snapshot has general-election polls in 27 Senate seats, 32 governor races and 91 House districts. With a September 28, 2026 cutoff, 24, 27 and 43 respectively have eligible recent averages.
