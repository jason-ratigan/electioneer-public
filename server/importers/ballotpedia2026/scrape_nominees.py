"""Extract Ballotpedia's currently listed 2026 congressional general candidates.

This is deliberately a polite, auditable collector rather than a browser-control
workaround. It uses ordinary HTTP, honors server errors, retains raw source
labels, caches successful responses, and never disables TLS verification.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import ssl
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable
from urllib.parse import unquote, urljoin, urlsplit, urlunsplit

import requests
from bs4 import BeautifulSoup, Tag


MASTER_URL = "https://ballotpedia.org/List_of_congressional_candidates_in_the_2026_elections"
GENERAL_ELECTION_DATE = "November 3, 2026"
USER_AGENT = "SignalElectionResearch/2.0 (2026 congressional nominee audit)"
HEADINGS = {"h1", "h2", "h3", "h4", "h5", "h6"}
EXCLUDED_JURISDICTIONS = {
    "American Samoa", "Guam", "Northern Mariana Islands", "Virgin Islands"
}


class ScrapeError(RuntimeError):
    """A source page could not be safely interpreted."""


class AccessBlockedError(ScrapeError):
    """The site refused ordinary automated access or presented a challenge."""


@dataclass(frozen=True)
class Office:
    state: str
    chamber: str
    district: str


@dataclass(frozen=True)
class MasterCandidate:
    state: str
    chamber: str
    district: str
    candidate_name: str
    candidate_party_raw: str
    candidate_url: str
    race_url: str
    race_office_text: str


@dataclass(frozen=True)
class RaceCandidate:
    candidate_name: str
    candidate_party_raw: str
    candidate_url: str


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def identity_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", clean_text(value).casefold())


def canonical_url(value: str, base_url: str = MASTER_URL) -> str:
    absolute = urljoin(base_url, value)
    parts = urlsplit(absolute)
    if parts.scheme not in {"http", "https"} or parts.netloc.casefold() not in {
        "ballotpedia.org", "www.ballotpedia.org"
    }:
        return ""
    path = unquote(parts.path)
    return urlunsplit(("https", "ballotpedia.org", path, "", ""))


def parse_office(text: str) -> Office:
    value = clean_text(text)
    house = re.fullmatch(r"U\.S\. House (.+?) (?:District (\d+)|At-large District)", value, re.I)
    if house:
        return Office(house.group(1), "House", str(int(house.group(2))) if house.group(2) else "At-large")
    senate = re.fullmatch(r"U\.S\. Senate (.+)", value, re.I)
    if senate:
        return Office(senate.group(1), "Senate", "Statewide")
    raise ScrapeError(f"Unsupported congressional office label: {value!r}")


def normalize_party(raw: str) -> str:
    value = clean_text(raw).strip("()")
    key = re.sub(r"[^a-z0-9]+", " ", value.casefold()).strip()
    labels = {
        "d": "Democratic",
        "dem": "Democratic",
        "democratic": "Democratic",
        "democratic party": "Democratic",
        "r": "Republican",
        "rep": "Republican",
        "republican": "Republican",
        "republican party": "Republican",
        "i": "Independent",
        "ind": "Independent",
        "independent": "Independent",
        "unaffiliated": "Independent",
        "undeclared": "Independent",
        "no party affiliation": "Independent",
        "no party preference": "Independent",
        "no political party": "Independent",
        "l": "Libertarian",
        "lib": "Libertarian",
        "libertarian": "Libertarian",
        "libertarian party": "Libertarian",
        "g": "Green",
        "green": "Green",
        "green party": "Green",
        "n": "Nonpartisan",
        "np": "Nonpartisan",
        "nonpartisan": "Nonpartisan",
    }
    return labels.get(key, value)


def _candidate_link(cell: Tag, base_url: str) -> tuple[str, str]:
    for link in cell.find_all("a", href=True):
        name = clean_text(link.get_text(" ", strip=True))
        url = canonical_url(link["href"], base_url)
        if name and url and not name.casefold().startswith("image:"):
            return name.removesuffix(" Incumbent").strip(), url
    return "", ""


def parse_master_page(html: str, page_url: str = MASTER_URL) -> list[MasterCandidate]:
    soup = BeautifulSoup(html, "html.parser")
    rows: list[MasterCandidate] = []
    seen: set[tuple[str, str, str]] = set()
    for table in soup.find_all("table"):
        table_rows = table.find_all("tr")
        if not table_rows:
            continue
        headers = [clean_text(cell.get_text(" ", strip=True)).casefold() for cell in table_rows[0].find_all(["th", "td"])]
        if not {"candidate", "party", "office"}.issubset(headers):
            continue
        indexes = {name: headers.index(name) for name in ("candidate", "party", "office")}
        for source_row in table_rows[1:]:
            cells = source_row.find_all(["th", "td"], recursive=False)
            if len(cells) <= max(indexes.values()):
                continue
            candidate_name, candidate_url = _candidate_link(cells[indexes["candidate"]], page_url)
            party = clean_text(cells[indexes["party"]].get_text(" ", strip=True))
            office_cell = cells[indexes["office"]]
            office_text = clean_text(office_cell.get_text(" ", strip=True))
            office_link = office_cell.find("a", href=True)
            race_url = canonical_url(office_link["href"], page_url) if office_link else ""
            if not candidate_name or not party or not race_url:
                continue
            office = parse_office(office_text)
            unique = (race_url, candidate_url, identity_name(candidate_name))
            if unique in seen:
                continue
            seen.add(unique)
            rows.append(MasterCandidate(
                office.state, office.chamber, office.district, candidate_name,
                party, candidate_url, race_url, office_text
            ))
    if not rows:
        raise ScrapeError("No candidate/party/office tables were found on the master page")
    return rows


def _heading_level(tag: Tag) -> int:
    return int(tag.name[1]) if tag.name in HEADINGS else 99


def _heading_text(tag: Tag) -> str:
    return clean_text(tag.get_text(" ", strip=True)).casefold()


def _following_section(heading: Tag) -> list[Tag]:
    level = _heading_level(heading)
    nodes: list[Tag] = []
    for node in heading.find_all_next():
        if node is heading:
            continue
        if node.name in HEADINGS and _heading_level(node) <= level:
            break
        nodes.append(node)
    return nodes


def _party_after_link(link: Tag) -> str:
    fragments: list[str] = []
    for sibling in link.next_siblings:
        if isinstance(sibling, Tag) and sibling.name == "a":
            break
        fragments.append(sibling.get_text(" ", strip=True) if isinstance(sibling, Tag) else str(sibling))
        match = re.search(r"\(([^()]{1,40})\)", " ".join(fragments))
        if match:
            return clean_text(match.group(1))
    row = link.find_parent("tr")
    if row:
        match = re.search(r"\(([^()]{1,40})\)", clean_text(row.get_text(" ", strip=True)))
        if match:
            return clean_text(match.group(1))
    return ""


def parse_current_general_candidates(html: str, page_url: str) -> list[RaceCandidate]:
    soup = BeautifulSoup(html, "html.parser")
    headings = soup.find_all(list(HEADINGS))
    candidates_heading = next(
        (heading for heading in headings if _heading_text(heading) == "candidates and election results"),
        None,
    )
    if candidates_heading is None:
        raise ScrapeError("Missing current 'Candidates and election results' section")

    current_nodes = _following_section(candidates_heading)
    general_heading = next(
        (node for node in current_nodes if node.name in HEADINGS and _heading_text(node) == "general election"),
        None,
    )
    if general_heading is None:
        raise ScrapeError("The current results section has no general-election subsection")
    general_nodes = _following_section(general_heading)
    general_text = clean_text(" ".join(node.get_text(" ", strip=True) for node in general_nodes))
    if GENERAL_ELECTION_DATE.casefold() not in general_text.casefold():
        raise ScrapeError(f"Current general-election subsection does not confirm {GENERAL_ELECTION_DATE}")

    race_heading = next(
        (node for node in general_nodes if node.name in HEADINGS and _heading_text(node).startswith("general election for ")),
        None,
    )
    if race_heading is None:
        raise ScrapeError("Missing current general-election race heading")
    race_nodes = _following_section(race_heading)
    candidates: list[RaceCandidate] = []
    seen_urls: set[str] = set()

    # The current-race narrative is the least presentation-specific candidate list.
    # It is bounded by the current h5 race heading, so history farther down cannot leak in.
    paragraphs = [node for node in race_nodes if node.name == "p"]
    narrative = next((
        paragraph for paragraph in paragraphs
        if GENERAL_ELECTION_DATE.casefold() in clean_text(paragraph.get_text(" ", strip=True)).casefold()
        and "general election" in clean_text(paragraph.get_text(" ", strip=True)).casefold()
    ), None)
    containers: Iterable[Tag] = [narrative] if narrative else [node for node in race_nodes if node.name == "tr"]
    for container in containers:
        if container is None:
            continue
        for link in container.find_all("a", href=True):
            name = clean_text(link.get_text(" ", strip=True))
            url = canonical_url(link["href"], page_url)
            if not name or not url or url == canonical_url(page_url) or url in seen_urls:
                continue
            party = _party_after_link(link)
            if not party:
                continue
            seen_urls.add(url)
            candidates.append(RaceCandidate(name, party, url))
    if not candidates:
        raise ScrapeError("No candidates with profile URLs and party labels found in the current general election")
    return candidates


class CachedHttpClient:
    def __init__(self, cache_dir: Path, refresh: bool, delay: float, retries: int = 3):
        self.cache_dir = cache_dir
        self.refresh = refresh
        self.delay = delay
        self.retries = retries
        self.last_request = 0.0
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.8",
        })
        if sys.platform == "win32" and not os.environ.get("REQUESTS_CA_BUNDLE"):
            self.session.verify = self._windows_ca_bundle()

    def _windows_ca_bundle(self) -> str:
        """Combine Requests' roots with Windows roots without weakening TLS."""
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        bundle_path = self.cache_dir / "windows-system-ca-bundle.pem"
        certificates: list[str] = [Path(requests.certs.where()).read_text(encoding="ascii")]
        seen: set[str] = set()
        for store_name in ("ROOT", "CA"):
            for certificate, encoding, _trust in ssl.enum_certificates(store_name):
                if encoding != "x509_asn":
                    continue
                digest = hashlib.sha256(certificate).hexdigest()
                if digest in seen:
                    continue
                seen.add(digest)
                certificates.append(ssl.DER_cert_to_PEM_cert(certificate))
        bundle_path.write_text("\n".join(certificates), encoding="ascii")
        return str(bundle_path)

    def _cache_path(self, url: str) -> Path:
        digest = hashlib.sha256(url.encode("utf-8")).hexdigest()
        return self.cache_dir / f"{digest}.html"

    def get(self, url: str) -> tuple[str, bool]:
        cache_path = self._cache_path(url)
        if cache_path.exists() and not self.refresh:
            return cache_path.read_text(encoding="utf-8"), True
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        for attempt in range(self.retries + 1):
            wait = self.delay - (time.monotonic() - self.last_request)
            if wait > 0:
                time.sleep(wait)
            try:
                response = self.session.get(url, timeout=(15, 60))
            except requests.exceptions.SSLError as error:
                raise AccessBlockedError(
                    "TLS certificate validation failed. Configure REQUESTS_CA_BUNDLE with your "
                    "organization's trusted CA bundle; this importer will not disable verification."
                ) from error
            except requests.RequestException as error:
                if attempt == self.retries:
                    raise ScrapeError(f"Request failed after {self.retries + 1} attempts: {error}") from error
                time.sleep(2 ** attempt)
                continue
            finally:
                self.last_request = time.monotonic()
            if response.status_code == 403:
                raise AccessBlockedError(f"Ballotpedia returned HTTP 403 for {url}; no bypass was attempted")
            if response.status_code == 429 or response.status_code >= 500:
                if attempt == self.retries:
                    raise ScrapeError(f"Ballotpedia returned HTTP {response.status_code} after retries for {url}")
                retry_after = response.headers.get("Retry-After", "")
                time.sleep(float(retry_after) if retry_after.isdigit() else 2 ** attempt)
                continue
            response.raise_for_status()
            html = response.text
            parsed_page = BeautifulSoup(html, "html.parser")
            challenge_text = clean_text(parsed_page.get_text(" ", strip=True)).casefold()
            page_title = clean_text(parsed_page.title.get_text(" ", strip=True)).casefold() if parsed_page.title else ""
            if (
                "verify you are human" in challenge_text[:2000]
                or "attention required" in page_title
                or "access denied" in page_title
                or parsed_page.select_one("#challenge-container") is not None
                or "awswafintegration.gettoken" in html.casefold()
            ):
                raise AccessBlockedError(f"Ballotpedia presented a human-verification challenge for {url}")
            cache_path.write_text(html, encoding="utf-8")
            return html, False
        raise AssertionError("unreachable")


def _match_nominee(candidate: RaceCandidate, master_rows: list[MasterCandidate]) -> tuple[MasterCandidate | None, str]:
    if candidate.candidate_url:
        url_matches = [row for row in master_rows if row.candidate_url == candidate.candidate_url]
        if len(url_matches) == 1:
            return url_matches[0], "candidate_url"
        if len(url_matches) > 1:
            name_matches = [row for row in url_matches if identity_name(row.candidate_name) == identity_name(candidate.candidate_name)]
            if len(name_matches) == 1:
                return name_matches[0], "candidate_url_and_name"
    name_matches = [row for row in master_rows if identity_name(row.candidate_name) == identity_name(candidate.candidate_name)]
    if len(name_matches) == 1:
        return name_matches[0], "normalized_name"
    return None, "race_page_only"


def _write_csv(path: Path, fieldnames: list[str], rows: Iterable[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def scrape(args: argparse.Namespace) -> dict:
    output_dir = Path(args.output_dir).resolve()
    client = CachedHttpClient(Path(args.cache_dir).resolve(), args.refresh, args.delay, args.retries)
    master_html, master_cached = client.get(args.master_url)
    master_rows = parse_master_page(master_html, args.master_url)
    races: dict[str, list[MasterCandidate]] = {}
    for row in master_rows:
        if row.state in EXCLUDED_JURISDICTIONS:
            continue
        races.setdefault(row.race_url, []).append(row)
    race_items = sorted(races.items(), key=lambda item: (
        item[1][0].state, item[1][0].chamber, item[1][0].district
    ))
    if args.limit is not None:
        race_items = race_items[:args.limit]

    scraped_at = datetime.now(timezone.utc).isoformat()
    audit_rows: list[dict] = []
    error_rows: list[dict] = []
    cache_hits = int(master_cached)
    for index, (race_url, roster) in enumerate(race_items, start=1):
        office = roster[0]
        print(f"[{index}/{len(race_items)}] {office.race_office_text}", flush=True)
        try:
            race_html, cached = client.get(race_url)
            cache_hits += int(cached)
            race_candidates = parse_current_general_candidates(race_html, race_url)
            for candidate in race_candidates:
                master, match_method = _match_nominee(candidate, roster)
                raw_party = master.candidate_party_raw if master else candidate.candidate_party_raw
                audit_rows.append({
                    "state": office.state,
                    "chamber": office.chamber,
                    "district": office.district,
                    "candidate_name": master.candidate_name if master else candidate.candidate_name,
                    "candidate_party": normalize_party(raw_party),
                    "candidate_party_raw": raw_party,
                    "candidate_ballotpedia_url": candidate.candidate_url,
                    "race_ballotpedia_url": race_url,
                    "race_office_text": office.race_office_text,
                    "match_method": match_method,
                    "scraped_at": scraped_at,
                })
        except Exception as error:  # preserve per-race failures for review
            error_rows.append({
                "state": office.state,
                "chamber": office.chamber,
                "district": office.district,
                "race_ballotpedia_url": race_url,
                "race_office_text": office.race_office_text,
                "error_type": type(error).__name__,
                "error_message": str(error),
                "scraped_at": scraped_at,
            })

    audit_rows.sort(key=lambda row: (
        row["state"], row["chamber"],
        0 if row["district"] in {"Statewide", "At-large"} else int(row["district"]),
        row["candidate_name"],
    ))
    audit_fields = [
        "state", "chamber", "district", "candidate_name", "candidate_party",
        "candidate_party_raw", "candidate_ballotpedia_url", "race_ballotpedia_url",
        "race_office_text", "match_method", "scraped_at",
    ]
    nominee_fields = [
        "state", "chamber", "district", "candidate_name", "candidate_party",
        "candidate_party_raw", "candidate_ballotpedia_url", "race_ballotpedia_url", "scraped_at",
    ]
    error_fields = [
        "state", "chamber", "district", "race_ballotpedia_url", "race_office_text",
        "error_type", "error_message", "scraped_at",
    ]
    _write_csv(output_dir / "audit.csv", audit_fields, audit_rows)
    _write_csv(output_dir / "nominees.csv", nominee_fields, audit_rows)
    _write_csv(output_dir / "errors.csv", error_fields, error_rows)
    manifest = {
        "sourceUrl": args.master_url,
        "electionDate": GENERAL_ELECTION_DATE,
        "scrapedAt": scraped_at,
        "masterCandidateRows": len(master_rows),
        "masterRaceCount": len(races),
        "excludedJurisdictions": sorted(EXCLUDED_JURISDICTIONS),
        "attemptedRaceCount": len(race_items),
        "successfulRaceCount": len(race_items) - len(error_rows),
        "nomineeCount": len(audit_rows),
        "errorCount": len(error_rows),
        "cacheHits": cache_hits,
        "limited": args.limit is not None,
        "complete": args.limit is None and not error_rows,
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--master-url", default=MASTER_URL)
    parser.add_argument("--cache-dir", default="data/ballotpedia2026/cache")
    parser.add_argument("--output-dir", default="data/ballotpedia2026/output")
    parser.add_argument("--delay", type=float, default=1.25, help="Minimum seconds between network requests")
    parser.add_argument("--retries", type=int, default=3)
    parser.add_argument("--limit", type=int, help="Process only the first N unique races (development only)")
    parser.add_argument("--refresh", action="store_true", help="Ignore cached successful responses")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.delay < 0.5:
        parser.error("--delay must be at least 0.5 seconds")
    if args.retries < 0 or args.retries > 8:
        parser.error("--retries must be between 0 and 8")
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be positive")
    try:
        manifest = scrape(args)
    except Exception as error:
        print(f"Ballotpedia scrape failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(manifest, indent=2))
    return 0 if manifest["complete"] or args.limit is not None else 2


if __name__ == "__main__":
    raise SystemExit(main())
