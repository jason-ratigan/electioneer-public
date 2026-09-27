"""Collect 2026 congressional general-election candidates from Wikimedia.

House candidates come from the nationwide state tables. Senate candidates come
from each state's pre-populated general-election results table, because the
nationwide Senate infobox intentionally omits some minor candidates. Candidate
identities are optionally enriched from the FEC's public candidate master file.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import re
import ssl
import sys
import time
import unicodedata
import zipfile
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urlencode, urljoin

import requests
from bs4 import BeautifulSoup, Tag
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


API_URL = "https://en.wikipedia.org/w/api.php"
HOUSE_PAGE = "2026 United States House of Representatives elections"
SENATE_PAGE = "2026 United States Senate elections"
FEC_URL = "https://www.fec.gov/files/bulk-downloads/2026/cn26.zip"
USER_AGENT = "Electioneer/2.0 (https://github.com/jason-ratigan/electioneer) requests/2"
WIKIPEDIA_LICENSE = "CC BY-SA 4.0"
WIKIPEDIA_LICENSE_URL = "https://creativecommons.org/licenses/by-sa/4.0/"

STATE_ABBREVIATIONS = {
    "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR",
    "California": "CA", "Colorado": "CO", "Connecticut": "CT", "Delaware": "DE",
    "District of Columbia": "DC", "Florida": "FL", "Georgia": "GA", "Hawaii": "HI",
    "Idaho": "ID", "Illinois": "IL", "Indiana": "IN", "Iowa": "IA", "Kansas": "KS",
    "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME", "Maryland": "MD",
    "Massachusetts": "MA", "Michigan": "MI", "Minnesota": "MN", "Mississippi": "MS",
    "Missouri": "MO", "Montana": "MT", "Nebraska": "NE", "Nevada": "NV",
    "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY",
    "North Carolina": "NC", "North Dakota": "ND", "Ohio": "OH", "Oklahoma": "OK",
    "Oregon": "OR", "Pennsylvania": "PA", "Rhode Island": "RI",
    "South Carolina": "SC", "South Dakota": "SD", "Tennessee": "TN", "Texas": "TX",
    "Utah": "UT", "Vermont": "VT", "Virginia": "VA", "Washington": "WA",
    "West Virginia": "WV", "Wisconsin": "WI", "Wyoming": "WY",
}
STATE_BY_ABBREVIATION = {value: key for key, value in STATE_ABBREVIATIONS.items()}
PARTY_CODES = {
    "DEM": "Democratic", "DFL": "Democratic", "REP": "Republican", "LIB": "Libertarian",
    "GRE": "Green", "IND": "Independent", "NPA": "Independent", "NON": "Nonpartisan",
}
FIRST_NAME_EQUIVALENTS = {
    "andy": "andrew", "bill": "william", "bob": "robert", "chris": "christopher",
    "dan": "daniel", "dave": "david", "ed": "edward", "jim": "james",
    "joe": "joseph", "matt": "matthew", "mike": "michael", "nick": "nicholas",
    "pat": "patrick", "pete": "peter", "rick": "richard", "rob": "robert",
    "sam": "samuel", "steve": "steven", "tom": "thomas",
}


class SourceError(RuntimeError):
    pass


@dataclass
class Nominee:
    state: str
    chamber: str
    district: str
    candidate_name: str
    candidate_party: str
    candidate_party_raw: str
    candidate_source_url: str
    race_source_url: str
    source_page_title: str
    source_page_id: int
    source_revision_id: int
    official_source_url: str
    extraction_method: str
    source_status: str
    fec_candidate_id: str = ""
    fec_match_method: str = "unmatched"
    scraped_at: str = ""


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def identity_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", clean_text(value)).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "", normalized.casefold())


def name_tokens(value: str) -> list[str]:
    normalized = unicodedata.normalize("NFKD", clean_text(value)).encode("ascii", "ignore").decode().casefold()
    tokens = re.findall(r"[a-z0-9]+", normalized)
    return [token for token in tokens if token not in {"jr", "sr", "ii", "iii", "iv"}]


def normalize_party(value: str) -> str:
    raw = re.sub(r"\[\s*[a-z0-9]+\s*\]", "", clean_text(value), flags=re.I)
    raw = raw.removesuffix(" Party").replace(" (United States)", "")
    key = raw.casefold()
    if key in {"democratic", "democrat", "democratic-farmer-labor", "democratic (dfl)"}:
        return "Democratic"
    if key in {"republican", "gop"}:
        return "Republican"
    if key in {"independent", "no party listed", "no party preference", "unaffiliated"}:
        return "Independent"
    if key in {"libertarian", "green", "nonpartisan"}:
        return raw.title()
    return raw


def wikipedia_url(path: str) -> str:
    if not path or not path.startswith("/wiki/") or path.startswith("/wiki/File:"):
        return ""
    return urljoin("https://en.wikipedia.org", path.split("#", 1)[0])


def page_url(title: str) -> str:
    slug = quote(title.replace(" ", "_"), safe="()_',")
    return f"https://en.wikipedia.org/wiki/{slug}"


def windows_ca_bundle(cache_dir: Path) -> str:
    cache_dir.mkdir(parents=True, exist_ok=True)
    bundle_path = cache_dir / "windows-system-ca-bundle.pem"
    certificates = [Path(requests.certs.where()).read_text(encoding="ascii")]
    seen: set[str] = set()
    for store_name in ("ROOT", "CA"):
        for certificate, encoding, _trust in ssl.enum_certificates(store_name):
            if encoding != "x509_asn":
                continue
            digest = hashlib.sha256(certificate).hexdigest()
            if digest not in seen:
                seen.add(digest)
                certificates.append(ssl.DER_cert_to_PEM_cert(certificate))
    bundle_path.write_text("\n".join(certificates), encoding="ascii")
    return str(bundle_path)


class CachedClient:
    def __init__(self, cache_dir: Path, refresh: bool, delay: float):
        self.cache_dir = cache_dir
        self.refresh = refresh
        self.delay = delay
        self.last_request = 0.0
        self.cache_hits = 0
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})
        self.session.mount("https://", HTTPAdapter(max_retries=Retry(
            total=4,
            connect=4,
            read=4,
            status=4,
            backoff_factor=1.0,
            status_forcelist=(429, 500, 502, 503, 504),
            allowed_methods=frozenset({"GET"}),
            respect_retry_after_header=True,
        )))
        if sys.platform == "win32" and not os.environ.get("REQUESTS_CA_BUNDLE"):
            self.session.verify = windows_ca_bundle(cache_dir)

    def _wait(self) -> None:
        remaining = self.delay - (time.monotonic() - self.last_request)
        if remaining > 0:
            time.sleep(remaining)

    def get_bytes(self, url: str, cache_name: str, accept: str = "application/octet-stream") -> bytes:
        path = self.cache_dir / cache_name
        if path.exists() and not self.refresh:
            self.cache_hits += 1
            return path.read_bytes()
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._wait()
        try:
            response = self.session.get(url, headers={"Accept": accept}, timeout=(15, 90))
            self.last_request = time.monotonic()
            response.raise_for_status()
        except requests.RequestException as error:
            raise SourceError(f"Unable to retrieve {url}: {error}") from error
        path.write_bytes(response.content)
        return response.content

    def parse_page(self, title: str, prop: str = "text|revid") -> dict:
        query = {
            "action": "parse", "page": title, "prop": prop,
            "format": "json", "formatversion": "2", "redirects": "1",
        }
        url = f"{API_URL}?{urlencode(query)}"
        cache_name = f"wiki-{hashlib.sha256(url.encode()).hexdigest()}.json"
        payload = json.loads(self.get_bytes(url, cache_name, "application/json"))
        if "error" in payload:
            raise SourceError(f"Wikimedia API error for {title}: {payload['error']}")
        return payload["parse"]


def _state_from_district(text: str) -> tuple[str, str] | None:
    value = clean_text(text).replace("–", "-")
    for state in sorted(STATE_ABBREVIATIONS, key=len, reverse=True):
        if not value.casefold().startswith(state.casefold()):
            continue
        remainder = value[len(state):].strip(" -")
        if "at-large" in remainder.casefold():
            return state, "At-large"
        match = re.search(r"\d+", remainder)
        if match:
            return state, str(int(match.group()))
    return None


def _external_source(soup: BeautifulSoup, table: Tag) -> str:
    header = next((cell for cell in table.find_all(["th", "td"]) if "candidates" in clean_text(cell.get_text()).casefold()), None)
    if header:
        reference = header.find("a", href=re.compile(r"^#cite_note"))
        if reference:
            note = soup.find(id=reference["href"][1:])
            if note:
                external = note.find("a", class_="external", href=True)
                if external:
                    return external["href"]
    return ""


def parse_house(page: dict, scraped_at: str) -> list[Nominee]:
    soup = BeautifulSoup(page["text"], "html.parser")
    nominees: list[Nominee] = []
    seen: set[tuple[str, str, str]] = set()
    for table in soup.select("table.wikitable"):
        preceding = table.find_previous("h2")
        section = clean_text(preceding.get_text(" ", strip=True)) if preceding else ""
        if section not in STATE_ABBREVIATIONS and section != "Non-voting delegates":
            continue
        header_text = clean_text(" ".join(cell.get_text(" ", strip=True) for cell in table.find_all("th")[:12]))
        if "Candidates" not in header_text or "District" not in header_text:
            continue
        official_url = _external_source(soup, table)
        for row in table.find_all("tr"):
            cells = row.find_all(["th", "td"], recursive=False)
            if len(cells) < 2:
                continue
            race = _state_from_district(cells[0].get_text(" ", strip=True))
            if not race:
                continue
            state, district = race
            candidate_cell = cells[-1]
            for item in candidate_cell.find_all("li"):
                text = clean_text(item.get_text(" ", strip=True)).lstrip("▌ ")
                text = re.sub(r"\[\s*\d+\s*\]", "", text).strip()
                match = re.match(r"(.+?)\s+\(+([^()]+)\)+\s*$", text)
                raw_name = match.group(1).strip() if match else text
                party_raw = clean_text(match.group(2)) if match else ""
                link = item.find("a", href=re.compile(r"^/wiki/(?!File:|Republican_Party|Democratic_Party|Libertarian_Party|Green_Party)"))
                linked_name = clean_text(link.get_text(" ", strip=True)) if link else ""
                name = linked_name or raw_name
                source_url = wikipedia_url(link["href"]) if link else ""
                unique = (state, district, identity_text(name))
                if not unique[2] or unique in seen:
                    continue
                seen.add(unique)
                nominees.append(Nominee(
                    state=state, chamber="House", district=district,
                    candidate_name=name, candidate_party=normalize_party(party_raw),
                    candidate_party_raw=party_raw, candidate_source_url=source_url,
                    race_source_url=f"{page_url(HOUSE_PAGE)}#{quote(state.replace(' ', '_'))}",
                    source_page_title=page["title"], source_page_id=int(page["pageid"]),
                    source_revision_id=int(page["revid"]), official_source_url=official_url,
                    extraction_method="national_house_candidate_table",
                    source_status="general_candidate",
                    scraped_at=scraped_at,
                ))
    return nominees


def discover_senate_states(page: dict) -> list[str]:
    states = []
    for section in page.get("sections", []):
        name = clean_text(BeautifulSoup(section["line"], "html.parser").get_text(" ", strip=True))
        if str(section.get("level")) == "2" and name in STATE_ABBREVIATIONS:
            states.append(name)
    return states


def _senate_candidates_from_table(table: Tag) -> list[tuple[str, str, str]]:
    candidates: list[tuple[str, str, str]] = []
    for row in table.find_all("tr"):
        cells = row.find_all(["th", "td"], recursive=False)
        candidate_cell = next((cell for cell in cells if cell.get("scope") == "row"), None)
        if candidate_cell is None:
            continue
        index = cells.index(candidate_cell)
        if index < 1:
            continue
        name = re.sub(r"\s*\((?:incumbent|write-in)\)\s*$", "", clean_text(candidate_cell.get_text(" ", strip=True)), flags=re.I)
        if not name or re.fullmatch(r"(?:write-ins?|other|total votes?)", name, re.I):
            continue
        party_raw = clean_text(cells[index - 1].get_text(" ", strip=True))
        if not party_raw or re.fullmatch(r"(?:party|candidate)", party_raw, re.I):
            continue
        link = candidate_cell.find("a", href=re.compile(r"^/wiki/(?!File:)"))
        source_url = wikipedia_url(link["href"]) if link else ""
        candidates.append((name, party_raw, source_url))
    return candidates


def _heading_level(heading: Tag) -> int:
    return int(heading.name[1])


def _candidate_items_after(heading: Tag) -> list[Tag]:
    """Return list items belonging to one candidate-status heading."""
    level = _heading_level(heading)
    items: list[Tag] = []
    for node in heading.find_all_next():
        if node.name in {"h2", "h3", "h4", "h5", "h6"} and _heading_level(node) <= level:
            break
        if node.name == "li" and node.find_parent("table") is None:
            items.append(node)
    return items


def _candidate_from_item(item: Tag) -> tuple[str, str, str]:
    text = re.sub(r"\[\s*[a-z0-9]+\s*\]", "", clean_text(item.get_text(" ", strip=True)), flags=re.I)
    name = re.split(r"\s*(?:,|\s+[—–]\s+)\s*", text, maxsplit=1)[0].strip()
    embedded_party = ""
    parenthetical = re.match(r"(.+?)\s+\(([^()]*)\)\s*$", name)
    if parenthetical:
        label = clean_text(parenthetical.group(2))
        if label.casefold() == "incumbent" or any(
            word in label.casefold() for word in ("party", "independent", "libertarian", "green", "constitution")
        ):
            name = clean_text(parenthetical.group(1))
            if label.casefold() != "incumbent":
                embedded_party = normalize_party(label)
    link = next((candidate_link for candidate_link in item.find_all(
        "a", href=re.compile(r"^/wiki/(?!File:|Category:|Special:|Help:)")
    ) if identity_text(candidate_link.get_text(" ", strip=True)) == identity_text(name)), None)
    return name, wikipedia_url(link["href"]) if link is not None else "", embedded_party


def _party_from_candidate_heading(h2_text: str, h3_text: str, item_text: str) -> str:
    combined = f"{h2_text} {h3_text}".casefold()
    for token, party in (
        ("democratic", "Democratic"),
        ("republican", "Republican"),
        ("libertarian", "Libertarian"),
        ("constitution", "Constitution"),
        ("party for socialism and liberation", "Party for Socialism and Liberation"),
        ("green", "Green"),
    ):
        if token in combined:
            return party
    if "independent" in combined:
        return "Independent"
    # Some combined third-party lists identify the affiliation in the item.
    parenthetical = re.search(r"\(([^()]*(?:party|green|independent|libertarian)[^()]*)\)", item_text, re.I)
    return normalize_party(parenthetical.group(1)) if parenthetical else ""


def _senate_candidates_from_statuses(soup: BeautifulSoup) -> list[tuple[str, str, str, str]]:
    """Extract explicit nominees and listed independent/minor-party entrants.

    Major-party candidates must be under a ``Nominee`` heading. Candidate lists
    under independent/third-party sections use the source's ``Declared`` or
    ``Candidates`` status and retain that status in the audit output.
    """
    candidates: list[tuple[str, str, str, str]] = []
    seen: set[str] = set()
    for heading in soup.find_all(["h3", "h4"]):
        status = clean_text(heading.get_text(" ", strip=True))
        status_key = status.casefold()
        h2 = heading.find_previous("h2")
        h3 = heading.find_previous("h3")
        h2_text = clean_text(h2.get_text(" ", strip=True)) if h2 else ""
        h3_text = clean_text(h3.get_text(" ", strip=True)) if h3 else ""
        alternative_section = any(word in h2_text.casefold() for word in ("independent", "third", "constitution", "libertarian"))
        accepted = status_key == "nominee" or (
            alternative_section and status_key in {"declared", "candidates"}
        )
        if not accepted:
            continue
        for item in _candidate_items_after(heading):
            name, source_url, embedded_party = _candidate_from_item(item)
            key = identity_text(name)
            if not key or key in seen:
                continue
            party = embedded_party or _party_from_candidate_heading(
                h2_text, h3_text, clean_text(item.get_text(" ", strip=True))
            )
            seen.add(key)
            candidates.append((name, party, source_url, status_key))
    return candidates


def parse_senate_state(page: dict, state: str, scraped_at: str) -> list[Nominee]:
    soup = BeautifulSoup(page["text"], "html.parser")
    expected_caption = f"2026 United States Senate election in {state}".casefold()
    options: list[tuple[Tag, list[tuple[str, str, str]]]] = []
    for table in soup.select("table.wikitable"):
        caption = table.find("caption")
        caption_text = clean_text(caption.get_text(" ", strip=True)).casefold() if caption else ""
        caption_normalized = re.sub(r"[^a-z0-9]+", " ", caption_text).strip()
        expected_normalized = re.sub(r"[^a-z0-9]+", " ", expected_caption).strip()
        reverse_normalized = f"united states senate election in {state} 2026".casefold()
        if caption_normalized not in {expected_normalized, reverse_normalized}:
            continue
        candidates = _senate_candidates_from_table(table)
        if candidates:
            options.append((table, candidates))
    if options:
        table, candidates = max(options, key=lambda option: len(option[1]))
        official_url = next((
            link["href"] for link in table.select("a.external[href]")
            if ".gov" in link["href"].casefold()
        ), "")
        extracted = [(name, party, source_url, "general_results_table") for name, party, source_url in candidates]
        method = "state_senate_general_results_table"
    else:
        extracted = _senate_candidates_from_statuses(soup)
        official_url = ""
        method = "state_senate_candidate_status_sections"
    if not extracted:
        raise SourceError(f"No general-election candidate evidence found for Senate in {state}")
    return [Nominee(
        state=state, chamber="Senate", district="Statewide", candidate_name=name,
        candidate_party=normalize_party(party), candidate_party_raw=party,
        candidate_source_url=source_url, race_source_url=page_url(page["title"]),
        source_page_title=page["title"], source_page_id=int(page["pageid"]),
        source_revision_id=int(page["revid"]), official_source_url=official_url,
        extraction_method=method, source_status=status, scraped_at=scraped_at,
    ) for name, party, source_url, status in extracted]


def read_fec_candidates(content: bytes) -> list[dict]:
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        names = [name for name in archive.namelist() if not name.endswith("/")]
        if len(names) != 1:
            raise SourceError(f"Expected one FEC candidate master file; found {names}")
        text = archive.read(names[0]).decode("cp1252")
    fields = [
        "candidate_id", "candidate_name", "party", "election_year", "state",
        "office", "district", "incumbent_challenge", "status", "principal_committee",
        "street_1", "street_2", "city", "mail_state", "zip",
    ]
    candidates = []
    for values in csv.reader(io.StringIO(text), delimiter="|"):
        if len(values) != len(fields):
            continue
        row = dict(zip(fields, (clean_text(value) for value in values)))
        if row["election_year"] == "2026" and row["office"] in {"H", "S"}:
            candidates.append(row)
    return candidates


def fec_display_name(value: str) -> str:
    if "," not in value:
        return clean_text(value)
    last, rest = value.split(",", 1)
    return clean_text(f"{rest} {last}")


def _fec_name_match(nominee_name: str, fec_name: str) -> str:
    display = fec_display_name(fec_name)
    if identity_text(nominee_name) == identity_text(display):
        return "exact_name"
    nominee_tokens = name_tokens(nominee_name)
    fec_tokens = name_tokens(display)
    if len(nominee_tokens) >= 2 and len(fec_tokens) >= 2:
        nominee_first = FIRST_NAME_EQUIVALENTS.get(nominee_tokens[0], nominee_tokens[0])
        fec_first = FIRST_NAME_EQUIVALENTS.get(fec_tokens[0], fec_tokens[0])
        if nominee_first == fec_first and nominee_tokens[-1] == fec_tokens[-1]:
            return "first_last"
    return ""


def enrich_fec(nominees: list[Nominee], fec_candidates: list[dict]) -> dict[str, int]:
    counts = {"exact_name": 0, "first_last": 0, "unmatched": 0, "ambiguous": 0}
    for nominee in nominees:
        abbreviation = STATE_ABBREVIATIONS[nominee.state]
        office = "H" if nominee.chamber == "House" else "S"
        district = "00" if nominee.district in {"At-large", "Statewide"} else nominee.district.zfill(2)
        state_office_rows = [row for row in fec_candidates if (
            row["state"] == abbreviation and row["office"] == office
        )]
        district_rows = [row for row in state_office_rows if row["district"] == district]
        race_rows = district_rows or state_office_rows
        matches = [(row, _fec_name_match(nominee.candidate_name, row["candidate_name"])) for row in race_rows]
        matches = [(row, method) for row, method in matches if method]
        exact = [(row, method) for row, method in matches if method == "exact_name"]
        selected = exact if exact else matches
        unique_ids = {row["candidate_id"] for row, _method in selected}
        if len(unique_ids) == 1:
            row, method = selected[0]
            nominee.fec_candidate_id = row["candidate_id"]
            nominee.fec_match_method = method
            if not nominee.candidate_party:
                nominee.candidate_party_raw = PARTY_CODES.get(row["party"], row["party"])
                nominee.candidate_party = normalize_party(nominee.candidate_party_raw)
            counts[method] += 1
        elif selected:
            nominee.fec_match_method = "ambiguous"
            counts["ambiguous"] += 1
        else:
            counts["unmatched"] += 1
    return counts


def write_csv(path: Path, nominees: list[Nominee]) -> None:
    fields = list(asdict(nominees[0]).keys()) if nominees else list(Nominee.__dataclass_fields__)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(asdict(nominee) for nominee in nominees)


def collect(args: argparse.Namespace) -> dict:
    cache_dir = Path(args.cache_dir).resolve()
    output_dir = Path(args.output_dir).resolve()
    client = CachedClient(cache_dir, args.refresh, args.delay)
    scraped_at = datetime.now(timezone.utc).isoformat()

    house_page = client.parse_page(HOUSE_PAGE)
    house_nominees = parse_house(house_page, scraped_at)
    senate_index = client.parse_page(SENATE_PAGE, "sections|revid")
    senate_states = discover_senate_states(senate_index)
    senate_nominees: list[Nominee] = []
    senate_pages = []
    errors = []
    for index, state in enumerate(senate_states, start=1):
        print(f"[{index}/{len(senate_states)}] Senate: {state}", flush=True)
        title = f"2026 United States Senate election in {state}"
        try:
            state_page = client.parse_page(title)
            state_nominees = parse_senate_state(state_page, state, scraped_at)
            senate_nominees.extend(state_nominees)
            senate_pages.append({
                "state": state, "title": state_page["title"],
                "pageId": int(state_page["pageid"]), "revisionId": int(state_page["revid"]),
                "url": page_url(state_page["title"]),
                "extractionMethod": state_nominees[0].extraction_method,
                "candidateCount": len(state_nominees),
            })
        except Exception as error:
            errors.append({"state": state, "page_title": title, "error": str(error)})

    nominees = house_nominees + senate_nominees
    fec_content = client.get_bytes(FEC_URL, "fec-cn26.zip")
    fec_candidates = read_fec_candidates(fec_content)
    fec_counts = enrich_fec(nominees, fec_candidates)
    nominees.sort(key=lambda row: (
        row.chamber, STATE_ABBREVIATIONS[row.state],
        0 if row.district in {"At-large", "Statewide"} else int(row.district), row.candidate_name,
    ))

    house_races = {(row.state, row.district) for row in house_nominees}
    senate_races = {row.state for row in senate_nominees}
    duplicates: set[tuple[str, str, str, str]] = set()
    seen_nominees: set[tuple[str, str, str, str]] = set()
    for nominee in nominees:
        key = (nominee.state, nominee.chamber, nominee.district, identity_text(nominee.candidate_name))
        if key in seen_nominees:
            duplicates.add(key)
        seen_nominees.add(key)
        if not nominee.candidate_name or not nominee.candidate_party or not nominee.candidate_party_raw:
            errors.append({
                "state": nominee.state,
                "page_title": nominee.source_page_title,
                "error": f"Blank required candidate field for {nominee.chamber} {nominee.district}: {nominee.candidate_name!r}",
            })
    for state, chamber, district, name_key in sorted(duplicates):
        errors.append({
            "state": state,
            "page_title": HOUSE_PAGE if chamber == "House" else f"2026 United States Senate election in {state}",
            "error": f"Duplicate candidate identity in {chamber} {district}: {name_key}",
        })
    complete = (
        len(house_races) == 436
        and len(senate_races) == 33
        and len(senate_states) == 33
        and not errors
    )
    write_csv(output_dir / "nominees.csv", nominees)
    write_csv(output_dir / "audit.csv", nominees)
    output_dir.mkdir(parents=True, exist_ok=True)
    with (output_dir / "errors.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["state", "page_title", "error"])
        writer.writeheader()
        writer.writerows(errors)
    manifest = {
        "scrapedAt": scraped_at,
        "complete": complete,
        "housePage": {
            "title": house_page["title"], "pageId": int(house_page["pageid"]),
            "revisionId": int(house_page["revid"]), "url": page_url(HOUSE_PAGE),
        },
        "senateIndexPage": {
            "title": senate_index["title"], "pageId": int(senate_index["pageid"]),
            "revisionId": int(senate_index["revid"]), "url": page_url(SENATE_PAGE),
        },
        "senatePages": senate_pages,
        "license": WIKIPEDIA_LICENSE,
        "licenseUrl": WIKIPEDIA_LICENSE_URL,
        "houseRaceCount": len(house_races), "senateRaceCount": len(senate_races),
        "nomineeCount": len(nominees), "errorCount": len(errors),
        "fecCandidateRows": len(fec_candidates), "fecMatchCounts": fec_counts,
        "fecFile": {
            "url": FEC_URL,
            "sha256": hashlib.sha256(fec_content).hexdigest(),
            "byteSize": len(fec_content),
        },
        "senateExtractionCounts": {
            method: sum(1 for page in senate_pages if page["extractionMethod"] == method)
            for method in sorted({page["extractionMethod"] for page in senate_pages})
        },
        "cacheHits": client.cache_hits,
    }
    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", default="data/wikipedia2026/cache")
    parser.add_argument("--output-dir", default="data/wikipedia2026/output")
    parser.add_argument("--delay", type=float, default=0.25)
    parser.add_argument("--refresh", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.delay < 0.1:
        parser.error("--delay must be at least 0.1 seconds")
    try:
        manifest = collect(args)
    except Exception as error:
        print(f"Wikimedia nominee collection failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(manifest, indent=2))
    return 0 if manifest["complete"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
