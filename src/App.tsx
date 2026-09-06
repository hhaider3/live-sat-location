import { useEffect, useMemo, useRef, useState } from 'react';
import { createEngine, DEFAULT_DISPLAY, type Engine, type SatSelection } from './engine';
import { dataFreshness, deliveryStatus, ELEMENT_AGE_LIMIT_MS, GROUP_DEFS, loadGroup, type LoadedGroup, type Sat } from './satellites';
import { formatSpeed } from './time';
import PassPlanner from './PassPlanner';

const PRESETS = [1, 60, 600, 3600, 86400];
const PRESET_LABELS = ['1×', '60×', '10 min/s', '1 h/s', '1 d/s'];
const utc = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
const value = (v: number, digits = 1) => Number.isFinite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: digits }) : '—';
const localInput = (ms: number) => {
  const d = new Date(ms);
  return new Date(ms - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

function FreshnessBadge({ status }: { status: ReturnType<typeof dataFreshness> }) {
  return <span className={`badge ${status.toLowerCase()}`}>{status === 'Simulated' ? status : `${status} elements`}</span>;
}

export default function App() {
  const canvas = useRef<HTMLDivElement>(null);
  const engine = useRef<Engine | null>(null);
  const groupsRef = useRef<LoadedGroup[]>([]);
  const visibilityRef = useRef(new Map<string, boolean>());
  const refreshRef = useRef<() => void>(() => {});
  const search = useRef<HTMLInputElement>(null);
  const resultButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const [groups, setGroups] = useState<LoadedGroup[]>([]);
  const [visibility, setVisibility] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(GROUP_DEFS.length);
  const [simTime, setSimTime] = useState(Date.now());
  const [fps, setFps] = useState(60);
  const [selection, setSelection] = useState<SatSelection | null>(null);
  const [query, setQuery] = useState('');
  const [panelOpen, setPanelOpen] = useState(() => window.matchMedia('(min-width: 760px)').matches);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [playerOpen, setPlayerOpen] = useState(false);
  const [display, setDisplay] = useState(DEFAULT_DISPLAY);
  const [paused, setPaused] = useState(false);
  const [reverse, setReverse] = useState(false);
  const [exp, setExp] = useState(0);
  const [editingDate, setEditingDate] = useState(false);
  const [dateInput, setDateInput] = useState(localInput(Date.now()));
  const [dateError, setDateError] = useState('');
  const [engineError, setEngineError] = useState('');
  const speed = (reverse ? -1 : 1) * Math.pow(10, exp);

  useEffect(() => {
    if (!canvas.current) return;
    let scene: Engine;
    try { scene = createEngine(canvas.current, (t, f) => { setSimTime(t); setFps(f); }, setSelection); }
    catch { setEngineError('The 3D view needs WebGL. Enable hardware acceleration or try another browser.'); return; }
    engine.current = scene;
    const controller = new AbortController();
    let cancelled = false;
    let fetching = false;
    const refresh = async () => {
      if (fetching || cancelled) return;
      fetching = true; setLoading(GROUP_DEFS.length);
      await Promise.allSettled(GROUP_DEFS.map(async def => {
        try {
          let next = await loadGroup(def, controller.signal);
          if (cancelled) return;
          const previous = groupsRef.current.find(g => g.key === def.key);
          // A transient failed refresh must not replace an observed catalog with invented objects.
          if (next.error && previous?.sats.some(s => s.kind === 'sgp4')) next = { ...previous, servedStale: true, error: next.error };
          groupsRef.current = [...groupsRef.current.filter(g => g.key !== def.key), next]
            .sort((a, b) => GROUP_DEFS.findIndex(g => g.key === a.key) - GROUP_DEFS.findIndex(g => g.key === b.key));
          scene.setGroups(groupsRef.current);
          groupsRef.current.forEach(g => scene.setGroupVisible(g.key, visibilityRef.current.get(g.key) ?? true));
          setGroups([...groupsRef.current]);
        } finally { if (!cancelled) setLoading(count => count - 1); }
      }));
      fetching = false;
    };
    refreshRef.current = () => { void refresh(); };
    void refresh();
    const interval = window.setInterval(() => { if (!document.hidden) void refresh(); }, 2 * 3600000);
    const onVisible = () => {
      if (!document.hidden && groupsRef.current.some(g => g.fetchedAt === null || Date.now() - g.fetchedAt >= 2 * 3600000)) void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true; controller.abort(); clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      scene.dispose(); engine.current = null; groupsRef.current = [];
    };
  }, []);
  useEffect(() => { engine.current?.setSpeed(speed); }, [speed]);
  useEffect(() => { engine.current?.setPaused(paused); }, [paused]);
  useEffect(() => { engine.current?.setDisplay(display); }, [display]);
  useEffect(() => { if (!editingDate) setDateInput(localInput(simTime)); }, [simTime, editingDate]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, button, summary, a')) return;
      if (e.key === '/') { e.preventDefault(); search.current?.focus(); }
      if (e.code === 'Space') { e.preventDefault(); setPaused(p => !p); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const allSats = useMemo(() => groups.flatMap(g => g.sats.map(sat => ({ group: g, sat }))), [groups]);
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return allSats.filter(({ sat }) => sat.name.toLowerCase().includes(q) || sat.id.toLowerCase().includes(q)).slice(0, 30);
  }, [allSats, query]);
  const selectedGroup = groups.find(g => g.key === selection?.key);
  const selectedSat = selectedGroup?.sats.find(s => s.id === selection?.id);
  const isVisible = (key: string) => visibility[key] ?? true;
  const visibleCount = groups.filter(g => isVisible(g.key)).reduce((sum, g) => sum + g.sats.length, 0);
  const statuses = groups.flatMap(g => g.sats.map(sat => dataFreshness(g, Date.now(), sat)));
  const fresh = statuses.filter(s => s === 'Fresh').length;
  const stale = statuses.filter(s => s === 'Stale').length;
  const simulated = statuses.filter(s => s === 'Simulated').length;
  const isLiveTime = !paused && !reverse && exp === 0 && Math.abs(simTime - Date.now()) < 5000;
  const iss = allSats.find(({ sat }) => sat.id === '25544') ?? allSats.find(({ sat }) => sat.kind === 'kepler' && sat.name.startsWith('ISS-'));

  const setVisible = (key: string, visible: boolean) => {
    visibilityRef.current.set(key, visible);
    setVisibility(old => ({ ...old, [key]: visible }));
    engine.current?.setGroupVisible(key, visible);
  };
  const isolate = (key?: string) => GROUP_DEFS.forEach(g => setVisible(g.key, key === undefined || g.key === key));
  const selectSat = (group: LoadedGroup, sat: Sat) => {
    setVisible(group.key, true); engine.current?.selectSatellite(group.key, sat.id);
    setQuery(''); setDetailsOpen(true);
    if (window.innerWidth < 760) setPanelOpen(false);
  };
  const returnToLive = () => {
    setPaused(false); setReverse(false); setExp(0); setEditingDate(false); setDateError('');
    engine.current?.returnToLive(); setDateInput(localInput(Date.now()));
  };
  const jump = (ms: number) => { setPaused(true); engine.current?.setPaused(true); engine.current?.setTime(ms); };
  const applyDate = () => {
    const ms = new Date(dateInput).getTime();
    if (!Number.isFinite(ms) || ms < Date.UTC(1957, 0, 1) || ms > Date.UTC(2101, 0, 1)) {
      setDateError('Choose a valid local date between 1957 and 2100.'); return;
    }
    setDateError(''); setEditingDate(false); jump(ms);
  };

  return <main className="orbit-app">
    <div ref={canvas} className="scene" />
    {engineError && <div className="engine-error" role="alert">{engineError}</div>}
    <div className="explore-column">
      <section className="panel overview" aria-label="Satellite explorer">
        <div className="brand-row"><h1><span aria-hidden="true">◉</span> Earth Orbit</h1><span className={`badge ${isLiveTime ? 'fresh' : 'playback'}`}>{isLiveTime ? 'Live time' : paused ? 'Paused' : 'Playback'}</span></div>
        <p className="intro">Explore the objects moving around our planet.</p>
        <div className="catalog-summary" aria-live="polite">{loading > 0 ? `Loading ${loading} groups…` : <><span className="fresh-text">{fresh.toLocaleString()} fresh</span><span className="stale-text">{stale.toLocaleString()} stale</span><span>{simulated.toLocaleString()} simulated</span><span>satellites</span></>}</div>
        <div className="search-wrap"><label className="sr-only" htmlFor="satellite-search">Search satellites by name or catalog ID</label>
          <input id="satellite-search" ref={search} type="search" autoComplete="off" placeholder="Search name or catalog ID…" value={query}
            aria-controls={query.trim() ? 'search-results' : undefined}
            onChange={e => setQuery(e.target.value)} onKeyDown={e => {
              if (e.key === 'ArrowDown') { e.preventDefault(); resultButtons.current[0]?.focus(); }
              if (e.key === 'Enter' && results[0]) selectSat(results[0].group, results[0].sat);
              if (e.key === 'Escape') { e.stopPropagation(); setQuery(''); }
            }} />
          {!query && <kbd aria-hidden="true">/</kbd>}
        </div>
        {query.trim() && <div className="search-results" id="search-results">
          <p className="muted" role="status">{results.length ? `${results.length === 30 ? 'First 30' : results.length} matches. Arrow down to browse.` : loading ? 'No matches yet; catalog is loading.' : 'No satellites match this search.'}</p>
          <ul>{results.map(({ group, sat }, index) => <li key={`${group.key}:${sat.id}`}>
            <button ref={el => { resultButtons.current[index] = el; }} onClick={() => selectSat(group, sat)} onKeyDown={e => {
              if (e.key === 'ArrowDown') { e.preventDefault(); resultButtons.current[(index + 1) % results.length]?.focus(); }
              if (e.key === 'ArrowUp') { e.preventDefault(); if (index === 0) search.current?.focus(); else resultButtons.current[index - 1]?.focus(); }
              if (e.key === 'Escape') { e.stopPropagation(); setQuery(''); search.current?.focus(); }
            }}><span className="result-name">{sat.name}</span><span className="muted">{group.label} · {sat.kind === 'sgp4' ? `#${sat.id}` : 'Simulated'}</span></button>
          </li>)}</ul>
        </div>}
        <div className="quick-actions"><button className="action" disabled={!iss} onClick={() => iss && selectSat(iss.group, iss.sat)}>Find ISS</button><button className="action" onClick={() => engine.current?.resetView()}>Reset view</button></div>
      </section>

      {selection && selectedSat && selectedGroup && <section className="panel selection-panel" aria-label="Selected satellite">
        <div className="selection-heading"><button className="selection-title" aria-expanded={detailsOpen} aria-controls="satellite-details" onClick={() => setDetailsOpen(o => !o)}><span className="dot" style={{ background: selection.color }} /><h2>{selection.name}</h2><span aria-hidden="true">{detailsOpen ? '▾' : '▸'}</span></button><button className="icon-button" aria-label="Deselect satellite" title="Deselect (Esc)" onClick={() => engine.current?.clearSelection()}>×</button></div>
        {detailsOpen && <div id="satellite-details" className="satellite-details">
          <div className="selection-subtitle"><span>{selection.label}{selectedSat.kind === 'sgp4' ? ` · #${selection.id}` : ''}</span><FreshnessBadge status={dataFreshness(selectedGroup, Date.now(), selectedSat)} /></div>
          <dl className="metrics">
            <div><dt>Altitude</dt><dd>{value(selection.altitudeKm)} <small>km</small></dd></div>
            <div><dt>Velocity</dt><dd>{value(selection.velocityKmS, 2)} <small>km/s</small></dd></div>
            <div><dt>Latitude</dt><dd>{value(selection.latitude, 2)}°</dd></div>
            <div><dt>Longitude</dt><dd>{value(selection.longitude, 2)}°</dd></div>
            <div><dt>Orbital period</dt><dd>{value(selection.periodMin)} <small>min</small></dd></div>
            <div><dt>Inclination</dt><dd>{value(selection.inclination)}°</dd></div>
          </dl>
          {!Number.isFinite(selection.altitudeKm) && <p className="notice">Position unavailable at this time. Try a time closer to the element epoch.</p>}
          <div className="quick-actions"><button className={`action ${selection.following ? 'active' : ''}`} aria-pressed={selection.following} onClick={() => engine.current?.setFollowing(!selection.following)}>{selection.following ? 'Stop following' : 'Follow satellite'}</button><button className="action" onClick={() => isolate(selection.key)}>Isolate group</button></div>
          {selectedSat.kind === 'sgp4' ? <div className="data-detail"><p>Element epoch <time>{utc(selectedSat.epochMs)}</time></p><p>Last successful fetch <time>{selectedGroup.fetchedAt === null ? 'Unknown' : utc(selectedGroup.fetchedAt)}</time></p><p>{deliveryStatus(selectedGroup)}</p>
            {Math.abs(simTime - selectedSat.epochMs) > ELEMENT_AGE_LIMIT_MS && <p className="notice">Displayed time is more than 3.5 days from the elements. This extrapolation may be inaccurate.</p>}</div> : <p className="notice">Synthetic circular orbit. This object does not represent a current real-world position.</p>}
          {display.groundTrack && <p className="muted"><span className="track-key" /> Ground track: surface path over the next orbit.</p>}
          <PassPlanner key={`${selection.key}:${selection.id}:${selectedGroup.fetchedAt}`} sat={selectedSat} getTime={() => engine.current?.getTime() ?? simTime} onJump={jump} />
        </div>}
      </section>}
    </div>

    <aside className={`panel catalog-panel ${panelOpen ? 'open' : ''}`} aria-label="Constellations and appearance">
      <button className="panel-toggle" aria-expanded={panelOpen} aria-controls="catalog-content" onClick={() => { setPanelOpen(o => !o); if (!panelOpen && window.innerWidth < 760) setDetailsOpen(false); }}><span>Constellations <small>{visibleCount.toLocaleString()} visible</small></span><span aria-hidden="true">{panelOpen ? '▾' : '▸'}</span></button>
      {panelOpen && <div id="catalog-content" className="catalog-content">
        <div className="quick-actions"><button className="action small" onClick={() => isolate()}>Show all</button><button className="action small" disabled={loading > 0} onClick={() => refreshRef.current()}>{loading ? 'Loading…' : 'Refresh data'}</button></div>
        <ul className="group-list">{GROUP_DEFS.map(def => {
          const g = groups.find(g => g.key === def.key);
          return <li key={def.key}>
            <div className="group-row"><button className={`group-toggle ${isVisible(def.key) ? '' : 'dimmed'}`} aria-label={`${def.label} visibility`} aria-pressed={isVisible(def.key)} onClick={() => setVisible(def.key, !isVisible(def.key))}><span className="dot" style={{ background: def.color }} /><span>{def.label}</span><span className="group-count">{g?.sats.length.toLocaleString() ?? '…'}</span></button><button className="isolate-button" title={`Show only ${def.label}`} aria-label={`Isolate ${def.label}`} onClick={() => isolate(def.key)}>◎</button></div>
            <div className="group-meta">{g ? <><FreshnessBadge status={dataFreshness(g)} /><span title={g.fetchedAt === null ? g.error : utc(g.fetchedAt)}>{deliveryStatus(g)}</span></> : 'Loading orbital data…'}</div>
          </li>;
        })}</ul>
        <details className="display-settings"><summary>Display & guides</summary>
          <label>Satellite point size <output>{display.pointSize.toFixed(2)}×</output><input type="range" min="0.4" max="2" step="0.05" value={display.pointSize} onChange={e => setDisplay(d => ({ ...d, pointSize: Number(e.target.value) }))} /></label>
          <label>Satellite brightness <output>{Math.round(display.brightness * 100)}%</output><input type="range" min="0.15" max="1" step="0.05" value={display.brightness} onChange={e => setDisplay(d => ({ ...d, brightness: Number(e.target.value) }))} /></label>
          <label className="check-label"><input type="checkbox" checked={display.stars} onChange={e => setDisplay(d => ({ ...d, stars: e.target.checked }))} /> Background stars</label>
          <label className="check-label"><input type="checkbox" checked={display.groundTrack} onChange={e => setDisplay(d => ({ ...d, groundTrack: e.target.checked }))} /> Selected ground track</label>
          <label className="check-label"><input type="checkbox" checked={display.guides} onChange={e => setDisplay(d => ({ ...d, guides: e.target.checked }))} /> Equator & altitude guides</label>
          {display.guides && <ul className="guide-legend"><li style={{ color: '#5eead4' }}>Equator · surface</li><li style={{ color: '#38bdf8' }}>LEO upper boundary · 2,000 km</li><li style={{ color: '#facc15' }}>GPS reference · 20,180 km</li><li style={{ color: '#c4b5fd' }}>GEO reference · 35,786 km</li><li className="muted">Equatorial reference rings; zoom out to see higher orbits.</li></ul>}
        </details>
        <details className="data-help"><summary>About the data</summary><p>Fresh elements: epoch within 3.5 days of now. Stale elements: epoch outside that range. Mixed elements: a group contains both. The summary counts individual satellites. Fetch age and failed refreshes are shown separately; fetching an old orbit again does not make its elements fresh. These are display thresholds, not accuracy guarantees.</p><p>Simulation time is separate from data freshness. Synthetic groups are always marked Simulated.</p><p>Coordinates use a geodetic Earth model; the globe and guides use a mean-radius sphere. Speeds are relative to an Earth-centered inertial frame.</p><p><a href="https://celestrak.org/NORAD/documentation/gp-data-formats.php" target="_blank" rel="noreferrer">CelesTrak OMM data</a> · SGP4 propagation</p>{groups.some(g => g.rejectedCount) && <p>{groups.reduce((n, g) => n + g.rejectedCount, 0)} invalid or duplicate records excluded.</p>}</details>
      </div>}
    </aside>

    <footer className={`panel player ${playerOpen ? 'expanded' : ''}`} aria-label="Simulation time controls">
      <div className="time-header"><time>{utc(simTime)}</time><span className="fps">{fps.toFixed(0)} fps</span><button className="action live-button" onClick={returnToLive}>Return to live</button><button className="icon-button mobile-only" aria-label="Time settings" aria-expanded={playerOpen} aria-controls="time-settings" onClick={() => setPlayerOpen(o => !o)}>{playerOpen ? '▾' : '▴'}</button></div>
      <div className="playback-row"><button className="play-button" aria-label={paused ? 'Play simulation' : 'Pause simulation'} title="Space to play/pause" onClick={() => setPaused(p => !p)}>{paused ? '▶' : 'Ⅱ'}</button><button className={`action reverse-button ${reverse ? 'active' : ''}`} aria-label="Reverse time" aria-pressed={reverse} onClick={() => setReverse(r => !r)}>↶</button><label className="speed-control"><span className="sr-only">Playback speed</span><input type="range" min="0" max="5" step="0.01" value={exp} aria-valuetext={`${formatSpeed(speed)}${reverse ? ', reverse' : ', forward'}`} onChange={e => setExp(Number(e.target.value))} /></label><output className="speed-output">{formatSpeed(speed)}</output><div className="presets">{PRESETS.map((p, i) => <button className={`action small ${Math.abs(exp - Math.log10(p)) < 0.001 ? 'active' : ''}`} aria-pressed={Math.abs(exp - Math.log10(p)) < 0.001} key={p} onClick={() => setExp(Math.log10(p))}>{PRESET_LABELS[i]}</button>)}</div></div>
      <div id="time-settings" className="time-settings"><form onSubmit={e => { e.preventDefault(); applyDate(); }}><label htmlFor="simulation-date">Jump to local time <span>({timezone})</span></label><div className="date-row"><input id="simulation-date" type="datetime-local" min="1957-01-01T00:00" max="2100-12-31T23:59" value={dateInput} onFocus={() => setEditingDate(true)} onBlur={() => { if (!dateInput) setDateInput(localInput(simTime)); }} onChange={e => { setEditingDate(true); setDateInput(e.target.value); }} aria-describedby={dateError ? 'date-error' : undefined} /><button className="action" type="submit">Jump & pause</button></div></form>{dateError && <p id="date-error" role="alert" className="notice">{dateError}</p>}</div>
    </footer>
    <p className="canvas-hint">Drag to rotate · Scroll to zoom · / to search · Space to pause</p>
  </main>;
}
