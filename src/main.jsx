import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { geoAlbersUsa, geoMercator, geoPath } from 'd3-geo';
import { feature, mesh } from 'topojson-client';
import statesTopology from 'us-atlas/states-10m.json';
import '../styles.css';

const offices = [
  { slug: 'president', label: 'Presidential', short: 'President' },
  { slug: 'governor', label: 'Gubernatorial', short: 'Governor' },
  { slug: 'us_house', label: 'House', short: 'U.S. House' },
  { slug: 'us_senate', label: 'Senate', short: 'U.S. Senate' }
];

const states = feature(statesTopology, statesTopology.objects.states);
const stateBorders = mesh(statesTopology, statesTopology.objects.states, (left, right) => left !== right);
const nationalProjection = geoAlbersUsa().fitExtent([[22, 18], [958, 588]], states);
const nationalPath = geoPath(nationalProjection);

const partyColors = {
  DEM: '#2f6fdb', D: '#2f6fdb', Democratic: '#2f6fdb',
  REP: '#d95662', R: '#d95662', Republican: '#d95662',
  LIB: '#d99b27', L: '#d99b27', Libertarian: '#d99b27',
  GRN: '#3e9a69', G: '#3e9a69', Green: '#3e9a69'
};

const formatNumber = new Intl.NumberFormat('en-US');
const formatPercent = value => `${(value || 0).toFixed(1)}%`;
const fips = value => String(value).padStart(2, '0');

function partyColor(choice) {
  return partyColors[choice?.partyAbbreviation] || partyColors[choice?.party] || '#7c8797';
}

function resultLeader(choices = []) {
  return [...choices].sort((left, right) => right.votes - left.votes)[0] || null;
}

function resultShare(votes, total) {
  return total ? (votes / total) * 100 : 0;
}

function useJson(url, dependencies = []) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  useEffect(() => {
    if (!url) {
      setState({ data: null, loading: false, error: null });
      return undefined;
    }
    const controller = new AbortController();
    setState(current => ({ ...current, loading: true, error: null }));
    fetch(url, { signal: controller.signal })
      .then(response => response.ok ? response.json() : response.json().then(body => Promise.reject(new Error(body.error || response.statusText))))
      .then(body => setState({ data: body.data, loading: false, error: null }))
      .catch(error => {
        if (error.name !== 'AbortError') setState({ data: null, loading: false, error });
      });
    return () => controller.abort();
  }, dependencies);
  return state;
}

function Icon({ children }) {
  return <span className="nav-icon" aria-hidden="true">{children}</span>;
}

function Sidebar({ storage, national, onNational }) {
  return <aside className="sidebar">
    <button className="brand" onClick={onNational} aria-label="Signal election hub home">
      <span className="brand-mark">S</span><span>signal</span>
    </button>
    <nav aria-label="Primary navigation">
      <button className={`nav-item ${national ? 'active' : ''}`} onClick={onNational}><Icon>⌂</Icon><span>Election hub</span></button>
      <button className="nav-item" onClick={onNational}><Icon>◎</Icon><span>Historical results</span></button>
      <button className="nav-item" disabled title="No polling data has been imported"><Icon>⌁</Icon><span>Polls</span><small>No data</small></button>
      <button className="nav-item" disabled title="No live election feed is configured"><Icon>◉</Icon><span>Election night</span><small>Offline</small></button>
    </nav>
    <div className="sidebar-context">
      <span className="context-label">AVAILABLE DATA</span>
      <strong>Presidential · 2000–2028</strong>
      <p>Electoral College results and allocations; popular votes where imported</p>
    </div>
    <div className="sidebar-bottom">
      <div className="live-card"><span className="pulse"/><div><strong>PostgreSQL archive</strong><small>{storage ? `${storage.megabytes} MB · ${formatNumber.format(storage.vote_totals)} vote rows` : 'Checking database…'}</small></div></div>
    </div>
  </aside>;
}

function OfficeControls({ office, onOffice, cycles, cycle, onCycle }) {
  return <div className="control-strip">
    <div className="office-tabs" role="tablist" aria-label="Office">
      {offices.map(item => <button
        key={item.slug}
        className={office === item.slug ? 'active' : ''}
        role="tab"
        aria-selected={office === item.slug}
        onClick={() => onOffice(item.slug)}
      >{item.label}</button>)}
    </div>
    <div className="view-controls">
      <label>Year<select value={cycle} onChange={event => onCycle(Number(event.target.value))}>{cycles.map(year => <option key={year} value={year}>{year}</option>)}</select></label>
      <div className="mode-toggle" aria-label="Data mode">
        <button className="active">Historical</button>
        <button disabled title="No polling data imported">Polls</button>
        <button disabled title="No live feed configured">Election night</button>
      </div>
    </div>
  </div>;
}

function ResultList({ title, subtitle, choices = [], totalVotes = 0, compact = false }) {
  return <section className={`result-list ${compact ? 'compact' : ''}`}>
    <div className="result-list-head"><div><span className="section-label">VOTE TOTALS</span><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><strong>{formatNumber.format(totalVotes)}<small>total votes</small></strong></div>
    <div className="choice-list">
      {choices.map(choice => {
        const share = resultShare(choice.votes, totalVotes);
        return <div className="choice-row" key={choice.id}>
          <i style={{ background: partyColor(choice) }}/>
          <div><strong>{choice.ballotName}</strong><small>{choice.party || choice.partyAbbreviation || 'No party listed'}</small></div>
          <div className="choice-bar"><span style={{ width: `${share}%`, background: partyColor(choice) }}/></div>
          <b>{formatNumber.format(choice.votes)}<small>{formatPercent(share)}</small></b>
        </div>;
      })}
    </div>
  </section>;
}

function ElectoralVotes({ electoral, stateFips = null }) {
  if (!electoral?.allocatedVotes) return null;
  const state = stateFips && electoral.states.find(item => item.stateFips === fips(stateFips));
  const allocation = state ? state.allocatedVotes : electoral.allocatedVotes;
  const recipients = state ? state.votes.map(item => ({ ...item, name: item.recipientName }))
    : electoral.totals.map(item => ({ ...item, name: item.recipientName }));
  const reported = recipients.reduce((sum, item) => sum + item.votes, 0);
  const sourceUrl = state?.votes[0]?.sourceUrl || state?.allocationSourceUrl;
  return <section className="electoral-card" aria-label="Electoral College results">
    <div className="electoral-card-head">
      <div><span className="section-label">ELECTORAL COLLEGE</span><h2>{state ? `${allocation} electoral votes` : `${electoral.cycle} electoral votes`}</h2></div>
      {!state && <strong>{reported}<small>of {allocation} {electoral.status === 'projected' ? 'projected' : 'recorded'} · {electoral.majority} to win</small></strong>}
    </div>
    {recipients.length ? <div className="electoral-choices">{recipients.map(item => <div className="electoral-choice" key={item.name}>
      <i style={{ background: partyColor({ partyAbbreviation: item.partyAbbreviation }) }}/>
      <span>{item.name}</span><strong>{item.votes}</strong>
    </div>)}</div> : <p>No electoral votes recorded yet.</p>}
    {reported < allocation && <p>{allocation - reported} {electoral.status === 'certified' ? 'vote not cast' : 'votes awaiting results'}.</p>}
    <footer>{state ? <>{state.votes[0]?.status === 'projected' && <span>Projected · </span>}<a href={sourceUrl} target="_blank" rel="noreferrer">{state.votes.length ? 'Result source' : 'Allocation source'}</a></>
      : <span>{electoral.status === 'projected' ? 'Projections are provisional.' : electoral.status === 'pending' ? 'Allocations are based on the 2020 Census; results are pending.' : electoral.status === 'partial' ? 'Partial results from linked sources.' : 'Certified results from the National Archives.'} State allocations include D.C.</span>}</footer>
  </section>;
}

function NationalMap({ contests, districts, electoral, office, officeLabel, cycle, onSelect, onSelectElectoral }) {
  const [unavailable, setUnavailable] = useState(null);
  const byState = useMemo(() => {
    const map = new Map();
    for (const contest of contests) {
      const key = fips(contest.state.fips);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(contest);
    }
    return map;
  }, [contests]);
  const byContest = useMemo(() => new Map(contests.map(contest => [contest.id, contest])), [contests]);
  const electoralByState = useMemo(() => new Map((electoral?.states || []).map(item => [item.stateFips, item])), [electoral]);
  const districtMode = office === 'us_house' && districts?.features?.length;

  const selectState = (stateFeature, preferredContestId = null) => {
    const stateContests = byState.get(fips(stateFeature.id));
    if (stateContests?.length) {
      setUnavailable(null);
      onSelect(stateContests, preferredContestId);
    } else if (office === 'president' && electoralByState.has(fips(stateFeature.id))) {
      setUnavailable(null);
      onSelectElectoral({ fips: fips(stateFeature.id), name: stateFeature.properties.name });
    } else {
      setUnavailable(stateFeature.properties.name);
    }
  };

  const selectDistrict = district => {
    const contest = byContest.get(district.properties.contestId);
    const stateContests = byState.get(fips(district.properties.stateFips));
    if (contest && stateContests?.length) {
      setUnavailable(null);
      onSelect(stateContests, contest.id);
    } else {
      setUnavailable(`${district.properties.stateName} ${district.properties.districtLabel}`);
    }
  };

  return <div className="map-card national-map-card">
    <div className="map-card-head">
      <div><span className="section-label">NATIONAL OVERVIEW</span><h1>{cycle} {officeLabel} results</h1><p>{districtMode ? 'Select a congressional district to inspect its result.' : electoral ? 'Select a state to inspect its Electoral College allocation and results.' : 'Select a state to inspect county and precinct returns.'}</p></div>
      <div className="map-key"><span><i className="data-fill"/>{electoral ? 'Electoral votes reported' : 'Imported results'}</span><span><i className="empty-fill"/>{electoral ? 'Awaiting result' : 'Not imported'}</span></div>
    </div>
    {unavailable && <div className="map-notice"><strong>{unavailable}</strong> has not been imported yet.<button onClick={() => setUnavailable(null)} aria-label="Dismiss">×</button></div>}
    <div className="map-stage">
      <svg viewBox="0 0 980 610" role="img" aria-label={`Map of ${cycle} ${officeLabel} result availability by state`}>
        <g className="state-shapes">
          {states.features.map(item => {
            const electoralState = office === 'president' ? electoralByState.get(fips(item.id)) : null;
            const imported = byState.has(fips(item.id)) || Boolean(electoralState?.votes.length);
            const contest = byState.get(fips(item.id))?.[0];
            const leader = resultLeader(contest?.choices);
            const electoralLeader = electoralState?.votes?.[0];
            const color = electoralLeader ? partyColor({ partyAbbreviation: electoralLeader.partyAbbreviation }) : partyColor(leader);
            return <path
              key={item.id}
              d={nationalPath(item)}
              className={imported && !districtMode ? 'state imported' : 'state'}
              style={imported && !districtMode ? { fill: color } : undefined}
              role="button"
              tabIndex="0"
              aria-label={`${item.properties.name}: ${electoralState ? `${electoralState.allocatedVotes} electoral votes${electoralLeader ? `, ${electoralLeader.recipientName} ${electoralLeader.votes}` : ', results pending'}` : imported ? 'results available' : 'not imported'}`}
              onClick={() => selectState(item)}
              onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') selectState(item); }}
            ><title>{item.properties.name}{electoralState ? ` — ${electoralState.allocatedVotes} electoral votes${electoralLeader ? `; ${electoralState.votes.map(vote => `${vote.recipientName} ${vote.votes}`).join(', ')}` : ' awaiting results'}` : imported && leader ? ` — ${leader.ballotName} received the most votes in imported results` : ' — not imported'}</title></path>;
          })}
          {districtMode && districts.features.map(item => {
            const contest = byContest.get(item.properties.contestId);
            const leader = resultLeader(contest?.choices || item.properties.choices);
            return <path
              key={item.id}
              d={nationalPath(item)}
              className={`district-shape ${contest ? 'imported' : ''}`}
              style={contest ? { fill: partyColor(leader) } : undefined}
              role="button"
              tabIndex="0"
              aria-label={`${item.properties.stateName} ${item.properties.districtLabel}: ${contest ? 'results available' : 'not imported'}`}
              onClick={() => selectDistrict(item)}
              onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') selectDistrict(item); }}
            ><title>{item.properties.stateAbbreviation} {item.properties.districtLabel}{leader ? ` — ${leader.ballotName} received the most votes` : ' — results unavailable'}</title></path>;
          })}
          <path className="state-borders" d={nationalPath(stateBorders)}/>
        </g>
      </svg>
      {!contests.length && !electoral?.states?.length && <div className="map-empty"><strong>No results found</strong><span>Choose another office or year.</span></div>}
    </div>
    <footer><span><i className="source-dot"/>{electoral ? 'Electoral College allocations: National Archives' : 'Imported results available nationwide'}</span><span>{districtMode ? 'District color reflects the leading candidate.' : electoral ? 'State color reflects the leading electoral vote recipient.' : 'State color reflects the choice with the most reported votes.'}</span></footer>
  </div>;
}

function LocalMap({ collection, selectedId, onSelect, level }) {
  const width = 720;
  const height = 560;
  const projection = useMemo(() => {
    if (!collection?.features?.length) return null;
    return geoMercator().fitExtent([[35, 25], [width - 35, height - 25]], collection);
  }, [collection]);
  const path = useMemo(() => projection ? geoPath(projection) : null, [projection]);
  if (!path || !collection.features.length) return <div className="local-map-empty"><strong>No {level} geometry is available.</strong><span>Run the geography import before opening this view.</span></div>;
  return <svg className="local-map" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${level} election result map`}>
    {collection.features.map(item => {
      const leader = resultLeader(item.properties.choices);
      const selected = item.id === selectedId;
      const regionName = item.properties.name
        || `${item.properties.stateAbbreviation || ''} ${item.properties.districtLabel || ''}`.trim();
      return <path
        key={item.id}
        d={path(item)}
        className={`local-region ${selected ? 'selected' : ''}`}
        style={{ fill: partyColor(leader) }}
        role="button"
        tabIndex="0"
        aria-label={`${regionName}, ${formatNumber.format(item.properties.totalVotes)} votes`}
        onClick={() => onSelect(item)}
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') onSelect(item); }}
      ><title>{regionName} — {formatNumber.format(item.properties.totalVotes)} total votes</title></path>;
    })}
  </svg>;
}

function StateView({ contests, initialContest, districts, electoral, onBack }) {
  const [contestId, setContestId] = useState(initialContest.id);
  const [level, setLevel] = useState(initialContest.office.slug === 'us_house' ? 'district' : 'county');
  const [selectedRegion, setSelectedRegion] = useState(null);
  const contest = contests.find(item => item.id === contestId) || initialContest;
  const isHouse = contest.office.slug === 'us_house';
  const precinctMapAvailable = contest.source !== 'MIT Election Data and Science Lab';
  const geographyUrl = level === 'district' ? null : `/api/hub/contests/${contest.id}/geographies?level=${level}`;
  const geography = useJson(geographyUrl, [contest.id, level]);
  const stateDistricts = useMemo(() => ({
    type: 'FeatureCollection',
    features: districts?.features?.filter(item => fips(item.properties.stateFips) === fips(contest.state.fips)) || []
  }), [districts, contest.state.fips]);

  useEffect(() => {
    setContestId(initialContest.id);
    setLevel(initialContest.office.slug === 'us_house' ? 'district' : 'county');
  }, [initialContest.id, initialContest.office.slug]);
  useEffect(() => setSelectedRegion(null), [contest.id, level]);
  useEffect(() => {
    if (!precinctMapAvailable && level === 'precinct') setLevel('county');
  }, [contest.id, precinctMapAvailable, level]);
  const detail = level === 'district' ? null : selectedRegion?.properties;
  const officeLabel = offices.find(item => item.slug === contest.office.slug)?.short || contest.office.name;
  const mapCollection = level === 'district' ? stateDistricts : geography.data;
  const mapLoading = level === 'district' ? !districts : geography.loading;
  const selectedMapId = level === 'district'
    ? stateDistricts.features.find(item => item.properties.contestId === contest.id)?.id
    : selectedRegion?.id;
  const selectMapRegion = item => {
    if (level === 'district') {
      if (item.properties.contestId) setContestId(item.properties.contestId);
    } else {
      setSelectedRegion(item);
    }
  };
  const mapTitle = level === 'district'
    ? `${contest.state.name} congressional districts`
    : detail?.name || `${contest.state.name} results`;
  const mapInstruction = level === 'district'
    ? 'Select a district to update the results.'
    : `Select a ${level} to see its vote count.`;

  return <div className="state-view">
    <div className="breadcrumbs"><button onClick={onBack}>United States</button><span>›</span><strong>{contest.state.name}</strong>{detail && <><span>›</span><strong>{detail.name}</strong></>}</div>
    <div className="state-heading">
      <div><span className="section-label">STATE EXPLORER</span><h1>{contest.state.name}</h1><p>{contest.cycle} {officeLabel} · {contest.stage} election</p></div>
      <button className="back-button" onClick={onBack}>← Back to U.S. map</button>
    </div>
    <div className="state-grid">
      <section className="map-card state-map-card">
        <div className="map-card-head local-head">
          <div><h2>{mapTitle}</h2><p>{mapInstruction}</p></div>
          <div className="level-toggle" aria-label="Map detail level">
            {isHouse && <button className={level === 'district' ? 'active' : ''} onClick={() => setLevel('district')}>Districts</button>}
            <button className={level === 'county' ? 'active' : ''} onClick={() => setLevel('county')}>Counties</button>
            {!isHouse && <button className={level === 'precinct' ? 'active' : ''} onClick={() => setLevel('precinct')} disabled={!precinctMapAvailable} title={precinctMapAvailable ? undefined : 'Precinct results require a boundary crosswalk'}>Precincts</button>}
          </div>
        </div>
        <div className={`local-map-wrap ${mapLoading ? 'loading' : ''}`}>
          {mapLoading ? <div className="map-empty"><span className="spinner"/><span>Drawing {level} map…</span></div>
            : geography.error ? <div className="map-empty error"><strong>Could not load the map</strong><span>{geography.error.message}</span></div>
              : <LocalMap collection={mapCollection} selectedId={selectedMapId} onSelect={selectMapRegion} level={level}/>}
        </div>
        <footer><span><i className="source-dot"/>{level === 'district' ? 'U.S. Census Bureau boundaries' : contest.source}</span><span>{level === 'district' ? `${contest.cycle === 2020 ? '116th' : contest.cycle === 2024 ? '118th' : '120th'} Congress boundaries used for the ${contest.cycle} election.` : contest.source === 'MIT Election Data and Science Lab' ? 'County totals are aggregated from MEDSL precinct and voting-mode rows.' : level === 'county' ? 'County totals are summed from imported precinct returns.' : 'Precinct votes are allocated by VEST from source reporting units.'}</span></footer>
      </section>
      <aside className="state-results">
        {contests.length > 1 && <label className="contest-select">Contest<select value={contestId} onChange={event => setContestId(event.target.value)}>{contests.map(item => <option key={item.id} value={item.id}>{item.districtLabel || item.name}</option>)}</select></label>}
        {contest.office.slug === 'president' && <ElectoralVotes electoral={electoral} stateFips={contest.state.fips}/>}
        <ResultList
          title={detail?.name || contest.districtLabel || contest.state.name}
          subtitle={detail ? `${contest.cycle} ${officeLabel}` : `${contest.reporting ?? 0}% reporting · ${contest.resultStatus?.replaceAll('_', ' ')}`}
          choices={detail?.choices || contest.choices}
          totalVotes={detail?.totalVotes ?? contest.totalVotes}
          compact
        />
        <div className="metadata-card">
          <span className="section-label">RESULT DETAILS</span>
          <dl><dt>Election date</dt><dd>{new Date(`${contest.electionDate}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</dd><dt>Reporting</dt><dd>{contest.reporting == null ? 'Unknown' : `${contest.reporting}%`}</dd><dt>Source</dt><dd>{contest.source}</dd><dt>Geography</dt><dd>{detail ? level : isHouse ? contest.districtLabel : 'Statewide'}</dd></dl>
          {level !== 'district' && (detail?.isEstimated ?? true) && <p>Precinct-level VEST values are allocated from source reporting units. County totals shown here are derived from those precinct values.</p>}
        </div>
      </aside>
    </div>
  </div>;
}

function ElectoralStateView({ state, electoral, onBack }) {
  return <div className="state-view">
    <div className="breadcrumbs"><button onClick={onBack}>United States</button><span>›</span><strong>{state.name}</strong></div>
    <div className="state-heading">
      <div><span className="section-label">STATE EXPLORER</span><h1>{state.name}</h1><p>{electoral.cycle} Presidential general election</p></div>
      <button className="back-button" onClick={onBack}>← Back to U.S. map</button>
    </div>
    <ElectoralVotes electoral={electoral} stateFips={state.fips}/>
    <p className="electoral-context">State popular vote detail is available when a presidential result source has been imported.</p>
  </div>;
}

function StateUnavailable({ state, officeLabel, cycle, onBack }) {
  return <div className="state-view">
    <div className="breadcrumbs"><button onClick={onBack}>United States</button><span>›</span><strong>{state.name}</strong></div>
    <div className="state-heading">
      <div><span className="section-label">STATE EXPLORER</span><h1>{state.name}</h1><p>{cycle} {officeLabel} · general election</p></div>
      <button className="back-button" onClick={onBack}>← Back to U.S. map</button>
    </div>
    <section className="map-card state-unavailable" aria-live="polite">
      <strong>No matching results have been imported.</strong>
      <p>{state.name} remains selected. Choose another office or year above, or return to the national map.</p>
    </section>
  </div>;
}

function App() {
  const [office, setOffice] = useState('president');
  const [cycle, setCycle] = useState(2020);
  const [selectedState, setSelectedState] = useState(null);
  const [selectedContestId, setSelectedContestId] = useState(null);
  const options = useJson('/api/hub/options', []);
  const overview = useJson(`/api/hub/overview?office=${office}&cycle=${cycle}&stage=general`, [office, cycle]);
  const electoral = useJson(office === 'president' ? `/api/hub/electoral-college?cycle=${cycle}` : null, [office, cycle]);
  const districtGeometry = useJson(
    office === 'us_house' ? `/api/hub/districts?cycle=${cycle}&stage=general` : null,
    [office, cycle]
  );
  const storage = useJson('/api/storage', []);

  const officeOption = options.data?.offices?.find(item => item.slug === office);
  const cycles = officeOption?.cycles?.length ? officeOption.cycles : [2020];
  const officeLabel = offices.find(item => item.slug === office)?.short || office;
  const stateContests = useMemo(() => {
    if (!selectedState || !overview.data) return [];
    return overview.data
      .filter(contest => fips(contest.state.fips) === fips(selectedState.fips))
      .sort((left, right) => (left.districtLabel || '').localeCompare(
        right.districtLabel || '', undefined, { numeric: true }
      ));
  }, [overview.data, selectedState]);

  useEffect(() => {
    if (!cycles.includes(cycle)) setCycle(cycles[0]);
  }, [office, options.data]);
  useEffect(() => setSelectedContestId(null), [office, cycle]);

  const goNational = () => {
    setSelectedState(null);
    setSelectedContestId(null);
  };
  const changeOffice = slug => setOffice(slug);
  const enterState = (contests, preferredContestId = null) => {
    setSelectedState(contests[0].state);
    setSelectedContestId(preferredContestId);
  };
  const enterElectoralState = state => {
    setSelectedState(state);
    setSelectedContestId(null);
  };
  const initialContest = stateContests.find(contest => contest.id === selectedContestId) || stateContests[0];

  return <div className="app-shell">
    <Sidebar storage={storage.data} national={!selectedState} onNational={goNational}/>
    <main>
      <header className="topbar"><div><span className="topbar-title">ELECTION DATA CENTER</span><span className="topbar-path">{selectedState?.name || 'United States'}</span></div><div className="top-status"><i/> Historical archive connected</div></header>
      <OfficeControls office={office} onOffice={changeOffice} cycles={cycles} cycle={cycle} onCycle={setCycle}/>
      <div className="workspace">
        {overview.error || electoral.error ? <div className="page-error"><strong>The election hub could not load.</strong><span>{(overview.error || electoral.error).message}</span></div>
          : overview.loading || electoral.loading ? <div className="page-loading"><span className="spinner"/><strong>Loading election results…</strong></div>
            : selectedState
              ? stateContests.length
                ? <StateView contests={stateContests} initialContest={initialContest} districts={districtGeometry.data} electoral={electoral.data} onBack={goNational}/>
                : office === 'president' && electoral.data?.states?.some(item => item.stateFips === fips(selectedState.fips))
                  ? <ElectoralStateView state={selectedState} electoral={electoral.data} onBack={goNational}/>
                : <StateUnavailable state={selectedState} officeLabel={officeLabel} cycle={cycle} onBack={goNational}/>
              : <>{office === 'president' && <ElectoralVotes electoral={electoral.data}/>}<NationalMap contests={overview.data || []} districts={districtGeometry.data} electoral={office === 'president' ? electoral.data : null} office={office} officeLabel={officeLabel} cycle={cycle} onSelect={enterState} onSelectElectoral={enterElectoralState}/></>}
      </div>
    </main>
  </div>;
}

createRoot(document.getElementById('root')).render(<App/>);
