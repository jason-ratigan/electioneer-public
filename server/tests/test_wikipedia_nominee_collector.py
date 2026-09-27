import sys
import unittest
from pathlib import Path


IMPORTER_DIR = Path(__file__).resolve().parents[1] / "importers" / "wikipedia2026"
sys.path.insert(0, str(IMPORTER_DIR))

from fetch_nominees import (  # noqa: E402
    _fec_name_match,
    parse_house,
    parse_senate_state,
)


def page(title: str, html: str) -> dict:
    return {"title": title, "pageid": 123, "revid": 456, "text": html}


class WikimediaNomineeCollectorTests(unittest.TestCase):
    def test_house_parser_uses_candidate_table_and_ignores_nested_empty_links(self):
        parsed = parse_house(page(
            "2026 United States House of Representatives elections",
            """
            <h2>Delaware</h2>
            <table class="wikitable">
              <tr><th>District</th><th>Candidates</th></tr>
              <tr><td>Delaware at-large</td><td><ul>
                <li><a href="/wiki/File:Blue.svg"></a><a href="/wiki/Jane_Doe">Jane Doe</a> (Democratic)</li>
                <li>John Roe (Independent) [ 12 ]</li>
              </ul></td></tr>
            </table>
            """
        ), "2026-09-20T00:00:00+00:00")
        self.assertEqual([(row.candidate_name, row.candidate_party) for row in parsed], [
            ("Jane Doe", "Democratic"), ("John Roe", "Independent")
        ])

    def test_senate_parser_accepts_reversed_general_results_caption(self):
        parsed = parse_senate_state(page(
            "2026 United States Senate election in Delaware",
            """
            <table class="wikitable">
              <caption>United States Senate election in Delaware, 2026</caption>
              <tr><th>Party</th><th>Candidate</th><th>Votes</th></tr>
              <tr><td>Democratic</td><th scope="row"><a href="/wiki/Jane_Doe">Jane Doe</a></th><td></td></tr>
              <tr><td>Republican</td><th scope="row">John Roe</th><td></td></tr>
            </table>
            """
        ), "Delaware", "2026-09-20T00:00:00+00:00")
        self.assertEqual([row.candidate_name for row in parsed], ["Jane Doe", "John Roe"])
        self.assertTrue(all(row.source_status == "general_results_table" for row in parsed))

    def test_senate_status_fallback_includes_nominees_but_not_primary_losers(self):
        parsed = parse_senate_state(page(
            "2026 United States Senate election in Delaware",
            """
            <h2>Democratic primary</h2><h3>Candidates</h3>
            <h4>Nominee</h4><ul><li>Jane Doe, state senator</li></ul>
            <h4>Eliminated in primary</h4><ul><li>Former Candidate, attorney</li></ul>
            <h2>Republican primary</h2><h3>Candidates</h3>
            <h4>Nominee</h4><ul><li>John Roe (incumbent), U.S. senator</li></ul>
            <h2>Third-party and independent candidates</h2><h3>Independents</h3>
            <h4>Candidates</h4><ul><li>Alex Public (Independent), engineer from Dover</li></ul>
            """
        ), "Delaware", "2026-09-20T00:00:00+00:00")
        self.assertEqual([(row.candidate_name, row.candidate_party) for row in parsed], [
            ("Jane Doe", "Democratic"),
            ("John Roe", "Republican"),
            ("Alex Public", "Independent")
        ])
        self.assertNotIn("Former Candidate", [row.candidate_name for row in parsed])

    def test_fec_name_match_supports_common_first_name_forms(self):
        self.assertEqual(_fec_name_match("Chris Coons", "COONS, CHRISTOPHER A."), "first_last")
        self.assertEqual(_fec_name_match("Unrelated Person", "PERSON, ALICE"), "")


if __name__ == "__main__":
    unittest.main()
