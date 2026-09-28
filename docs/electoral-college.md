# Presidential Electoral College results

The general election Electoral College is stored separately from popular votes and presidential primary delegates. Migration `012_presidential_electoral_college.sql` adds state allocations and certified presidential electoral votes for 2000–2024 from the [National Archives results tables](https://www.archives.gov/electoral-college/results). It adds the [2028 allocations](https://www.archives.gov/electoral-college/allocation), which the National Archives says also apply to 2024, without any 2028 vote recipients. The API and map show the actual presidential vote recipients, including split Maine and Nebraska votes, faithless electors in 2004 and 2016, and the uncast D.C. vote in 2000. Vice presidential votes are outside this view.

`GET /api/hub/electoral-college?cycle=2024` returns the national allocation, majority threshold, recipient totals, state allocations, state recipients, status, and source links. Years 2000–2016 have Electoral College data even where popular vote results have not been imported. `GET /api/hub/options` includes those years and 2028 for the presidential tab.

## Add 2028 reports

Migration `013_presidential_electoral_updates.sql` provides append-only state reports. Create a reviewed JSON file with a public HTTPS source for the reported or projected figures:

```json
{
  "cycle": 2028,
  "status": "projected",
  "sourceUrl": "https://example.org/2028-presidential-results",
  "reportedAt": "2028-11-08T02:00:00Z",
  "states": [
    {
      "fips": "23",
      "votes": [
        { "recipientName": "Candidate A", "partyAbbreviation": "DEM", "votes": 3 },
        { "recipientName": "Candidate B", "partyAbbreviation": "REP", "votes": 1 }
      ]
    }
  ]
}
```

The names above illustrate the file format; they are not election results. Use `projected` before official Electoral College votes are certified and `certified` for a verified official source. A file may include one or more states. Each state must already have an allocation, recipients must be unique, and its reported votes cannot exceed its allocation. Split votes and faithless votes are entered as separate recipients. A state can report fewer votes than its allocation, as happened with D.C. in 2000.

Preview, then commit the exact file:

```bash
npm run import:electoral -- path/to/2028-results.json
npm run import:electoral -- path/to/2028-results.json --commit
```

The importer stores a SHA-256 hash and an immutable report for each state in the file. Reimporting the same file is idempotent. A later report with a newer `reportedAt` replaces the displayed state result while preserving earlier reports. The view never derives electoral votes from statewide popular vote leaders; Maine and Nebraska can split their votes, and electors can vote for other recipients.
