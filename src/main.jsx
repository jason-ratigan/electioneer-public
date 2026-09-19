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
      <strong>Delaware · 2020</strong>
      <p>President, Governor, U.S. House and U.S. Senate</p>
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

function NationalMap({ contests, officeLabel, cycle, onSelect }) {
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

  const selectState = stateFeature => {
    const stateContests = byState.get(fips(stateFeature.id));
    if (stateContests?.length) {
      setUnavailable(null);
      onSelect(stateContests);
    } else {
      setUnavailable(stateFeature.properties.name);
    }
  };

  return <div className="map-card national-map-card">
    <div className="map-card-head">
      <div><span className="section-label">NATIONAL OVERVIEW</span><h1>{cycle} {officeLabel} results</h1><p>Select a state to inspect county and precinct returns.</p></div>
      <div className="map-key"><span><i className="data-fill"/>Imported results</span><span><i className="empty-fill"/>Not imported</span></div>
    </div>
    {unavailable && <div className="map-notice"><strong>{unavailable}</strong> has not been imported yet.<button onClick={() => setUnavailable(null)} aria-label="Dismiss">×</button></div>}
    <div className="map-stage">
      <svg viewBox="0 0 980 610" role="img" aria-label={`Map of ${cycle} ${officeLabel} result availability by state`}>
        <g className="state-shapes">
          {states.features.map(item => {
            const imported = byState.has(fips(item.id));
            const contest = byState.get(fips(item.id))?.[0];
            const leader = resultLeader(contest?.choices);
            return <path
              key={item.id}
              d={nationalPath(item)}
              className={imported ? 'state imported' : 'state'}
              style={imported ? { fill: partyColor(leader) } : undefined}
              role="button"
              tabIndex="0"
              aria-label={`${item.properties.name}: ${imported ? 'results available' : 'not imported'}`}
              onClick={() => selectState(item)}
              onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') selectState(item); }}
            ><title>{item.properties.name}{imported && leader ? ` — ${leader.ballotName} received the most votes in imported results` : ' — not imported'}</title></path>;
          })}
          <path className="state-borders" d={nationalPath(stateBorders)}/>
        </g>
      </svg>
      {!contests.length && <div className="map-empty"><strong>No results found</strong><span>Choose another office or year.</span></div>}
    </div>
    <footer><span><i className="source-dot"/>Data currently available for Delaware</span><span>State color reflects the choice with the most reported votes.</span></footer>
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
  return <svg className="local-map" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Delaware ${level} election result map`}>
    {collection.features.map(item => {
      const leader = resultLeader(item.properties.choices);
      const selected = item.id === selectedId;
      return <path
        key={item.id}
        d={path(item)}
        className={`local-region ${selected ? 'selected' : ''}`}
        style={{ fill: partyColor(leader) }}
        role="button"
        tabIndex="0"
        aria-label={`${item.properties.name}, ${formatNumber.format(item.properties.totalVotes)} votes`}
        onClick={() => onSelect(item)}
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') onSelect(item); }}
      ><title>{item.properties.name} — {formatNumber.format(item.properties.totalVotes)} total votes</title></path>;
    })}
  </svg>;
}

function StateView({ contests, initialContest, onBack }) {
  const [contestId, setContestId] = useState(initialContest.id);
  const [level, setLevel] = useState('county');
  const [selectedRegion, setSelectedRegion] = useState(null);
  const contest = contests.find(item => item.id === contestId) || initialContest;
  const geography = useJson(`/api/hub/contests/${contest.id}/geographies?level=${level}`, [contest.id, level]);

  useEffect(() => setSelectedRegion(null), [contest.id, level]);
  const detail = selectedRegion?.properties;
  const officeLabel = offices.find(item => item.slug === contest.office.slug)?.short || contest.office.name;

  return <div className="state-view">
    <div className="breadcrumbs"><button onClick={onBack}>United States</button><span>›</span><strong>{contest.state.name}</strong>{detail && <><span>›</span><strong>{detail.name}</strong></>}</div>
    <div className="state-heading">
      <div><span className="section-label">STATE EXPLORER</span><h1>{contest.state.name}</h1><p>{contest.cycle} {officeLabel} · {contest.stage} election</p></div>
      <button className="back-button" onClick={onBack}>← Back to U.S. map</button>
    </div>
    <div className="state-grid">
      <section className="map-card state-map-card">
        <div className="map-card-head local-head">
          <div><h2>{detail ? detail.name : `${contest.state.name} results`}</h2><p>Click a {level} to see its vote count.</p></div>
          <div className="level-toggle" aria-label="Map detail level"><button className={level === 'county' ? 'active' : ''} onClick={() => setLevel('county')}>Counties</button><button className={level === 'precinct' ? 'active' : ''} onClick={() => setLevel('precinct')}>Precincts</button></div>
        </div>
        <div className={`local-map-wrap ${geography.loading ? 'loading' : ''}`}>
          {geography.loading ? <div className="map-empty"><span className="spinner"/><span>Drawing {level} map…</span></div>
            : geography.error ? <div className="map-empty error"><strong>Could not load the map</strong><span>{geography.error.message}</span></div>
              : <LocalMap collection={geography.data} selectedId={selectedRegion?.id} onSelect={setSelectedRegion} level={level}/>}
        </div>
        <footer><span><i className="source-dot"/>{contest.source}</span><span>{level === 'county' ? 'County totals are summed from imported precinct returns.' : 'Precinct votes are allocated by VEST from source reporting units.'}</span></footer>
      </section>
      <aside className="state-results">
        {contests.length > 1 && <label className="contest-select">Contest<select value={contestId} onChange={event => setContestId(event.target.value)}>{contests.map(item => <option key={item.id} value={item.id}>{item.districtLabel || item.name}</option>)}</select></label>}
        <ResultList
          title={detail?.name || contest.districtLabel || contest.state.name}
          subtitle={detail ? `${contest.cycle} ${officeLabel}` : `${contest.reporting ?? 0}% reporting · ${contest.resultStatus?.replaceAll('_', ' ')}`}
          choices={detail?.choices || contest.choices}
          totalVotes={detail?.totalVotes ?? contest.totalVotes}
          compact
        />
        <div className="metadata-card">
          <span className="section-label">RESULT DETAILS</span>
          <dl><dt>Election date</dt><dd>{new Date(`${contest.electionDate}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</dd><dt>Reporting</dt><dd>{contest.reporting == null ? 'Unknown' : `${contest.reporting}%`}</dd><dt>Source</dt><dd>{contest.source}</dd><dt>Geography</dt><dd>{detail ? level : 'Statewide'}</dd></dl>
          {(detail?.isEstimated ?? true) && <p>Precinct-level VEST values are allocated from source reporting units. County totals shown here are derived from those precinct values.</p>}
        </div>
      </aside>
    </div>
  </div>;
}

function App() {
  const [office, setOffice] = useState('president');
  const [cycle, setCycle] = useState(2020);
  const [stateContests, setStateContests] = useState(null);
  const options = useJson('/api/hub/options', []);
  const overview = useJson(`/api/hub/overview?office=${office}&cycle=${cycle}&stage=general`, [office, cycle]);
  const storage = useJson('/api/storage', []);

  const officeOption = options.data?.offices?.find(item => item.slug === office);
  const cycles = officeOption?.cycles?.length ? officeOption.cycles : [2020];
  const officeLabel = offices.find(item => item.slug === office)?.short || office;

  useEffect(() => {
    if (!cycles.includes(cycle)) setCycle(cycles[0]);
  }, [office, options.data]);
  useEffect(() => setStateContests(null), [office, cycle]);

  const goNational = () => setStateContests(null);
  const changeOffice = slug => { setOffice(slug); setStateContests(null); };

  return <div className="app-shell">
    <Sidebar storage={storage.data} national={!stateContests} onNational={goNational}/>
    <main>
      <header className="topbar"><div><span className="topbar-title">ELECTION DATA CENTER</span><span className="topbar-path">{stateContests ? stateContests[0].state.name : 'United States'}</span></div><div className="top-status"><i/> Historical archive connected</div></header>
      <OfficeControls office={office} onOffice={changeOffice} cycles={cycles} cycle={cycle} onCycle={setCycle}/>
      <div className="workspace">
        {overview.error ? <div className="page-error"><strong>The election hub could not load.</strong><span>{overview.error.message}</span></div>
          : overview.loading ? <div className="page-loading"><span className="spinner"/><strong>Loading election results…</strong></div>
            : stateContests
              ? <StateView contests={stateContests} initialContest={stateContests[0]} onBack={goNational}/>
              : <NationalMap contests={overview.data || []} officeLabel={officeLabel} cycle={cycle} onSelect={setStateContests}/>}
      </div>
    </main>
  </div>;
}

createRoot(document.getElementById('root')).render(<App/>);
