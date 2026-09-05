import { useEffect, useRef, useState } from 'react';
import PassWorker from './passes.worker?worker&inline';
import { CITIES, validObserver, type PassResult } from './passes';
import type { Sat } from './satellites';

export default function PassPlanner({ sat, getTime, onJump }: { sat: Sat; getTime: () => number; onJump: (ms: number) => void }) {
  const [city, setCity] = useState('Phoenix');
  const [lat, setLat] = useState('33.45');
  const [lon, setLon] = useState('-112.07');
  const [result, setResult] = useState<PassResult | null>(null);
  const [start, setStart] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const worker = useRef<Worker | null>(null);
  const clear = () => { worker.current?.terminate(); worker.current = null; setBusy(false); setResult(null); setError(''); };
  useEffect(() => () => worker.current?.terminate(), []);
  const calculate = () => {
    clear();
    const observer = { latitude: Number(lat), longitude: Number(lon) };
    if (!lat.trim() || !lon.trim() || !validObserver(observer)) { setError('Enter latitude −90 to 90 and longitude −180 to 180.'); return; }
    const from = getTime(); setStart(from); setBusy(true);
    try {
      const w = new PassWorker(); worker.current = w;
      w.onmessage = (event: MessageEvent<{ result?: PassResult; error?: string }>) => {
        if (worker.current !== w) return;
        setBusy(false); setResult(event.data.result ?? null); setError(event.data.error ?? '');
        w.terminate(); worker.current = null;
      };
      w.onerror = () => { setError('Pass calculation failed. Try again.'); setBusy(false); w.terminate(); worker.current = null; };
      w.postMessage({ sat, observer, start: from });
    } catch { setBusy(false); setError('Pass calculations require browser Web Worker support.'); }
  };
  const time = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(5, 19) + ' UTC';
  return <details className="pass-planner">
    <summary>Upcoming passes</summary>
    <p className="muted">Next 24 hours from the displayed time, above 10° elevation. Geometric passes; visibility in the night sky is not predicted.</p>
    {sat.kind === 'kepler' && <p className="notice">Illustrative passes for a simulated object.</p>}
    <label>Observer city<select value={city} onChange={e => {
      clear(); setCity(e.target.value); const match = CITIES.find(c => c.name === e.target.value);
      if (match) { setLat(String(match.latitude)); setLon(String(match.longitude)); }
    }}>{CITIES.map(c => <option key={c.name}>{c.name}</option>)}<option>Custom coordinates</option></select></label>
    <div className="coordinate-inputs">
      <label>Latitude (°)<input type="number" min="-90" max="90" step="any" value={lat} onChange={e => { clear(); setCity('Custom coordinates'); setLat(e.target.value); }} /></label>
      <label>Longitude (°)<input type="number" min="-180" max="180" step="any" value={lon} onChange={e => { clear(); setCity('Custom coordinates'); setLon(e.target.value); }} /></label>
    </div>
    <button className="action" onClick={calculate} disabled={busy}>{busy ? 'Calculating…' : 'Calculate passes'}</button>
    <div role="status">
      {error && <p className="notice">{error}</p>}
      {result?.failed && <p className="notice">Orbit could not be propagated throughout this window. Try a time closer to the element epoch.</p>}
      {result && !result.failed && <>
        <p className="muted">Window begins {time(start!)}. Recalculate after changing time.</p>
        {!result.passes.length && <p>No passes above 10° in this window.</p>}
        <ol className="pass-list">{result.passes.map(pass => <li key={pass.start}>
          <span>{pass.ongoing ? 'Already above 10°' : time(pass.start)}</span>
          <span className="muted">{pass.maxElevation.toFixed(1)}° peak · {((pass.end - pass.start) / 60000).toFixed(1)} min{pass.continues ? ' (continues beyond window)' : ''}</span>
          <button className="action small" onClick={() => onJump(pass.peak)}>View peak</button>
        </li>)}</ol>
      </>}
    </div>
  </details>;
}
