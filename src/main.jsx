import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';

const electionTypes = [['', 'All elections'], ['general', 'General'], ['primary', 'Other primaries'], ['presidential_primary', 'Presidential primaries'], ['presidential_general', 'Presidential general']];

function App() {
  const [filters, setFilters] = useState({ type: '', cycle: '', office: '', query: '' });
  const [races, setRaces] = useState([]);
  const [facets, setFacets] = useState({ cycles: [], offices: [] });
  const [storage, setStorage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);

  const params = useMemo(() => new URLSearchParams(Object.entries(filters).filter(([, value]) => value)), [filters]);
  useEffect(() => { fetch('/api/archive/facets').then(r => r.json()).then(r => setFacets(r.data)); }, []);
  useEffect(() => { fetch('/api/storage').then(r => r.json()).then(r => setStorage(r.data)); }, []);
  useEffect(() => {
    setLoading(true);
    fetch(`/api/races?${params}`).then(r => r.json()).then(r => setRaces(r.data)).finally(() => setLoading(false));
  }, [params]);

  const update = event => setFilters(current => ({ ...current, [event.target.name]: event.target.value }));

  return <>
    <aside className="sidebar">
      <a className="brand"><span className="brand-mark">S</span><span>signal</span></a>
      <nav><a className="nav-item">⌂ Overview</a><a className="nav-item">⌁ Polls</a><a className="nav-item">◇ Elections</a><a className="nav-item active">↺ Historical</a></nav>
      <div className="sidebar-bottom"><div className="live-card"><span className="pulse"/><div><strong>Local archive</strong><small>{storage ? `${storage.megabytes} / ${storage.limitMegabytes} MB` : 'Checking DuckDB…'}</small></div></div></div>
    </aside>
    <main>
      <header className="topbar"><div className="eyebrow">HISTORICAL ARCHIVE</div><div className="top-actions"><span className="updated"><i/> Stored locally</span></div></header>
      <section className="hero"><div><p className="kicker">2000–PRESENT</p><h1>Explore election history.</h1><p>Navigate general, presidential, gubernatorial, congressional, and post-2014 primary records.</p></div></section>
      <section className="dashboard-grid archive-layout">
        <article className="panel archive-panel">
          <div className="panel-head"><div><span className="section-label">ARCHIVE BROWSER</span><h2>Election records</h2></div><span className="updated">{races.length} records</span></div>
          <div className="archive-filters">
            <label>Election type<select name="type" value={filters.type} onChange={update}>{electionTypes.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
            <label>Year<select name="cycle" value={filters.cycle} onChange={update}><option value="">All years</option>{facets.cycles.map(year=><option key={year}>{year}</option>)}</select></label>
            <label>Office<select name="office" value={filters.office} onChange={update}><option value="">All offices</option>{facets.offices.map(office=><option key={office}>{office}</option>)}</select></label>
            <label>Jurisdiction<input name="query" value={filters.query} onChange={update} placeholder="Search state…"/></label>
          </div>
          {loading ? <p className="empty-state">Loading archive…</p> : races.length ? races.map(race =>
            <button className={`history-row ${selected?.id===race.id?'selected':''}`} key={race.id} onClick={() => setSelected(race)}>
              <time>{race.cycle}</time><span><strong>{race.jurisdiction}</strong><small>{race.election_type} election</small></span><span>{race.office}</span><b>View →</b>
            </button>) : <p className="empty-state">No records match these filters.</p>}
        </article>
        <aside className="panel detail-panel">
          {selected ? <><span className="section-label">RECORD DETAIL</span><h2>{selected.jurisdiction} · {selected.office}</h2><dl><dt>Cycle</dt><dd>{selected.cycle}</dd><dt>Election</dt><dd>{selected.election_type}</dd><dt>Level</dt><dd>{selected.election_level}</dd><dt>Reporting</dt><dd>{selected.reporting}%</dd><dt>Source</dt><dd>{selected.source}</dd></dl><p>Historical results can be expanded here with county and precinct navigation after provider imports are connected.</p></> : <div className="empty-state"><b>Select a record</b><p>Choose an election to inspect its metadata and eventually compare returns over time.</p></div>}
        </aside>
      </section>
      <p className="demo-note">All currently seeded records are illustrative interface-test data, not historical results.</p>
    </main>
  </>;
}

createRoot(document.getElementById('root')).render(<App/>);
