import sys
import unittest
from pathlib import Path


IMPORTER_DIR = Path(__file__).resolve().parents[1] / "importers" / "ballotpedia2026"
sys.path.insert(0, str(IMPORTER_DIR))

from scrape_nominees import (  # noqa: E402
    ScrapeError,
    normalize_party,
    parse_current_general_candidates,
    parse_master_page,
    parse_office,
)


class BallotpediaNomineeScraperTests(unittest.TestCase):
    def test_office_parser_handles_numbered_and_at_large_house_and_senate(self):
        self.assertEqual(parse_office("U.S. House Delaware At-large District").district, "At-large")
        self.assertEqual(parse_office("U.S. House Alabama District 01").district, "1")
        senate = parse_office("U.S. Senate New Hampshire")
        self.assertEqual((senate.state, senate.chamber, senate.district), ("New Hampshire", "Senate", "Statewide"))

    def test_party_normalization_retains_unknown_labels(self):
        self.assertEqual(normalize_party("D"), "Democratic")
        self.assertEqual(normalize_party("No party preference"), "Independent")
        self.assertEqual(normalize_party("Working Families Party"), "Working Families Party")

    def test_master_parser_extracts_candidate_profile_and_race_urls(self):
        html = """
        <table>
          <tr><th>candidate</th><th>party</th><th>office</th></tr>
          <tr>
            <td><a href="https://images.example/a.jpg"><img alt="portrait"></a>
                <a href="/Jane_Doe">Jane Doe</a> Incumbent</td>
            <td>Democratic</td>
            <td><a href="/Delaware%27s_At-large_Congressional_District_election%2C_2026">U.S. House Delaware At-large District</a></td>
          </tr>
        </table>
        """
        parsed = parse_master_page(html)
        self.assertEqual(len(parsed), 1)
        self.assertEqual(parsed[0].candidate_name, "Jane Doe")
        self.assertEqual(parsed[0].candidate_url, "https://ballotpedia.org/Jane_Doe")
        self.assertEqual(parsed[0].district, "At-large")

    def test_current_general_parser_does_not_read_historical_general_results(self):
        html = """
        <h2><span>Candidates and election results</span></h2>
        <h4>General election</h4>
        <p>The general election will occur on November 3, 2026.</p>
        <h5>General election for U.S. House Delaware At-large District</h5>
        <p><a href="/Jane_Doe">Jane Doe</a> (D) and
           <a href="/John_Roe">John Roe</a> (R) are running in the general election for
           U.S. House Delaware At-large District on November 3, 2026.</p>
        <table><tr><td><a href="/Jane_Doe">Jane Doe</a> (D)</td></tr></table>
        <h4>Democratic primary</h4>
        <p>Primary material.</p>
        <h2>District history</h2>
        <h4>General election</h4>
        <h5>General election for U.S. House Delaware At-large District</h5>
        <p><a href="/Old_Candidate">Old Candidate</a> (R) won on November 5, 2024.</p>
        """
        candidates = parse_current_general_candidates(
            html, "https://ballotpedia.org/Delaware_election_2026"
        )
        self.assertEqual([candidate.candidate_name for candidate in candidates], ["Jane Doe", "John Roe"])
        self.assertEqual([candidate.candidate_party_raw for candidate in candidates], ["D", "R"])

    def test_current_general_parser_requires_2026_election_date(self):
        html = """
        <h2>Candidates and election results</h2>
        <h4>General election</h4>
        <p>The general election occurred on November 5, 2024.</p>
        <h5>General election for U.S. House Delaware At-large District</h5>
        <p><a href="/Old_Candidate">Old Candidate</a> (R) won on November 5, 2024.</p>
        """
        with self.assertRaisesRegex(ScrapeError, "November 3, 2026"):
            parse_current_general_candidates(html, "https://ballotpedia.org/example")


if __name__ == "__main__":
    unittest.main()
