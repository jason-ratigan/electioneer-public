# Map-centered polling explorer

The application opens at `/#explore`, defaulting to the 2026 Senate map. Senate and governor polls map to states; House polls map to the district identities in the imported, dated boundary collection. The 2026 House map uses the 120th Congress collection. National generic-ballot and presidential-approval observations are never assigned to local races.

Choose an office, cycle, stage and cutoff date. Select a shape or searchable race entry to see its candidate matchup, polling trend, original response shares and source links. The URL retains the office, year, date, stage, state and seat, so this view can be bookmarked. Race details link to the historical-results map for the same state and office. The poll library and administrator import pages remain accessible.

Polls appear in a scrollable table beside the map, with fixed Democratic (blue), Republican (red), and Other/undecided (neutral) columns. Multiple responses in one column stay separate and retain their published values. The Polls/Races switch and race dropdown allow navigation without leaving the map. Approval tables label the columns Approve/Disapprove instead of assigning party meaning to those responses.

Map colors use two lighter shades per party for 3–5 and 5–10 point leads, and the full shade for leads of 10 points or more. Races within 3 points remain competitive; these display bands do not alter control calculations. The palest blue and red indicate a current-holder assumption where no recent usable average exists; an explicit pick uses the full party color. Trend axes fit the observed margin range with padding. Approval uses a 25–75% window, expanding only if an observation falls outside it. Axis bounds are labeled. Selected map shapes and keyboard focus use their geographic outline, not a rectangular focus box.

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

For the 2026 general election, the default control scenario assigns each mapped seat in this order: **your explicit winner pick**, then a usable polling lead outside the three-point competitive band, then the current holder's party if there is no usable average. The current-holder fallback can be switched off. Vacancies remain unassigned; an independent or other-party holder stays in a separate Other category. A holder's party is a scenario assumption for an unpolled race, not a forecast or a claim that the holder is running. A uniform D/R polling-margin shift only changes seats with usable polling. National generic ballot is never translated to seats.

House totals cover 435 voting seats, excluding DC and territories. The [House Clerk current member list](https://clerk.house.gov/Members/ViewMemberList) supplied 433 occupied districts on September 29, 2026: 214 Democrats, 218 Republicans and one independent. FL-20 and TX-23 were vacant in this snapshot. The map uses the imported 2026 district keys; new boundaries may differ from the current member's district, so the holder assumption remains explicitly labeled. The control bar reports counts by polling, holder assumption and your picks.

The 2026 Senate schedule contains the 33 Class II seats plus the Florida and Ohio Class III specials. The September 29 roster has 45 Democrats, 53 Republicans and two independents. The non-election holdovers are 32 Democrats, two independents counted with the Democratic coalition, and 31 Republicans. This yields a starting coalition count of 34–31 with 35 seats up. The outright-majority threshold is 51; a 50–50 Senate depends on the vice president.

The [National Governors Association current roster](https://www.nga.org/wp-content/uploads/2024/12/Governors-Roster.pdf) gives 24 Democratic and 26 Republican governors in the 50 states. Of 36 states voting in 2026, the other 14 hold over: six Democratic and eight Republican. The card displays the count of governorships by party; governors do not form a legislative chamber.

Select a race to **pick a winner** from imported general-candidate rosters, names appearing in polls, or a party choice with an optional name. Source candidate names are not verified ballot qualification. A pick updates the map and control totals and is saved in this browser by office, cycle and stage. Reset clears the active scenario. Picks never alter source polls or historical election results. The dated 2026 holder snapshot remains fixed when the polling timeline moves; it is not a reconstruction of earlier membership.

The committed snapshot lives in `server/outlook/officeholders2026.json`, with its retrieval date and source URLs. Refresh it after verifying the official rosters and reconcile the totals in `server/tests/outlook.test.js`; it is not updated automatically by the NYT poll button. No schema migration is needed for the holder snapshot.

Sources checked for the baseline and schedule:

- [Senate Class I](https://www.senate.gov/senators/Class_I.htm), [Class II](https://www.senate.gov/senators/Class_II.htm), [Class III](https://www.senate.gov/senators/Class_III.htm).
- [House Clerk current member list](https://clerk.house.gov/Members/ViewMemberList), [NGA current governor roster](https://www.nga.org/wp-content/uploads/2024/12/Governors-Roster.pdf).
- [Florida offices up for election](https://dos.fl.gov/elections/candidates-committees/offices-up-for-election), [Ohio election directives, including 2025-54](https://www.ohiosos.gov/elections/elections-administration/directives).
- [National Governors Association election schedule](https://www.nga.org/governors/elections/). The governor map covers 36 states; territories are outside this map.

Poll data retains NYT attribution and the supplied CC BY 4.0 license. The UI identifies its polling averages and mappings as transformations. Polls do not establish ballot qualification. The model does not yet include fundamentals, incumbency effects, correlated polling error, turnout models, or calibrated probabilities. Sparse polling still leaves races unresolved when there is no current holder or the fallback is off.

## Verification

```powershell
npm.cmd run test:outlook
# Read-only integration checks; requires running API and supplied data:
npm.cmd run test:outlook:api
npm.cmd run check
npm.cmd run build
```

Integration checks verify all supplied 2026 general-election question geographies, national separation, unique source races per seat, 435 voting House districts and API input validation. The supplied snapshot has general-election polls in 27 Senate seats, 32 governor races and 91 House districts. With a September 28, 2026 cutoff, 24, 27 and 43 respectively have eligible recent averages.
