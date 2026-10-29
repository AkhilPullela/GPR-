import React, { useMemo, useRef, useState } from 'react';
import { createDemoRun } from './gpr/demo.js';
import { summarizeRounds, summarizeRun, generateFindings } from './gpr/analyze.js';
import { importMarkersInWorker, parseChromeTraceInWorker } from './gpr/traceWorkerClient.js';
import { createSnapshot, reportHtml, reportCsvFiles, reportFileBase } from './gpr/reports.js';
import { SOURCE, displayValue, metricCoverage } from './gpr/model.js';
import './styles.css';

const nav = [
  ['overview', 'Overview', '◫'], ['trends', 'Performance trends', '⌁'], ['rounds', 'Round analysis', '▤'], ['bottlenecks', 'Bottlenecks', '⚑'], ['traces', 'Traces', '⇧'], ['reports', 'Reports', '⇩']
];
const pathFor = key => `/${key}`;
function readPage() { const key = location.pathname.replace(/^\//, '').split('/')[0]; return nav.some(item => item[0] === key) ? key : 'overview'; }

function timestampLabel(_baseTime, timestampMs) { return `+${timestampMs.toFixed(0)} ms`; }
function MetricChart({ title, samples, metric, color, unit, selected, onSelect, note, baseTime }) {
  const allValues = samples.filter(s => Number.isFinite(s[metric]));
  const stride = Math.max(1, Math.ceil(allValues.length / 1200));
  const values = stride > 1 ? allValues.filter((_, index) => index % stride === 0 || index === allValues.length - 1) : allValues;
  if (!values.length) return <section className="panel chart-panel"><div className="panel-heading"><h3>{title}</h3><span className="unit">{unit}</span></div><div className="chart-empty"><span className="empty-icon">∿</span><b>Not captured</b><p>{note || 'This run contains no supported measurements for this metric.'}</p></div></section>;
  const width = 640, height = 205, pad = { l: 38, r: 12, t: 14, b: 28 };
  const x0 = Math.min(...values.map(s => s.timestampMs)), x1 = Math.max(...values.map(s => s.timestampMs));
  const ys = values.map(s => s[metric]), low = Math.min(...ys), high = Math.max(...ys), span = high - low || 1;
  const x = v => pad.l + ((v - x0) / (x1 - x0 || 1)) * (width - pad.l - pad.r);
  const y = v => height - pad.b - ((v - low) / span) * (height - pad.t - pad.b);
  const points = values.map(s => `${x(s.timestampMs)},${y(s[metric])}`).join(' ');
  return <section className="panel chart-panel"><div className="panel-heading"><h3>{title}</h3><span className="unit">{unit} · observed</span></div><svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title} chart`}>
    {[0, .5, 1].map((tick, i) => <g key={i}><line x1={pad.l} x2={width - pad.r} y1={pad.t + tick * (height - pad.t - pad.b)} y2={pad.t + tick * (height - pad.t - pad.b)} className="gridline"/><text x={pad.l - 7} y={pad.t + tick * (height - pad.t - pad.b) + 4} textAnchor="end" className="axis-label">{(high - tick * span).toFixed(0)}</text></g>)}
    {selected && <rect x={x(selected[0])} y={pad.t} width={Math.max(0, x(selected[1]) - x(selected[0]))} height={height - pad.t - pad.b} fill="rgba(101,129,255,.12)"/>}
    <polyline points={points} fill="none" stroke={color} strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round"/>
    {values.map((s, i) => <circle key={`${s.timestampMs}-${i}`} cx={x(s.timestampMs)} cy={y(s[metric])} r="3.2" fill={color} tabIndex="0" aria-label={`${s.roundId ? `Round ${s.roundId}, ` : ''}${timestampLabel(baseTime, s.timestampMs)}, ${s[metric].toFixed(1)} ${unit}`} onClick={() => onSelect?.(s)} onKeyDown={e => e.key === 'Enter' && onSelect?.(s)}><title>{s.roundId ? `Round ${s.roundId} · ` : ''}${s[metric].toFixed(1)} ${unit}</title></circle>)}
    <text x={pad.l} y={height - 5} className="axis-label">Start</text><text x={width - pad.r} y={height - 5} textAnchor="end" className="axis-label">End</text>
  </svg></section>;
}
function Kpi({ title, value, unit, sub, status = 'neutral' }) { return <article className={`kpi ${status}`}><div className="kpi-top"><span>{title}</span><i /></div><strong>{value === undefined ? 'Not captured' : `${value}${unit || ''}`}</strong><small>{sub}</small></article>; }
function Severity({ value }) { return <span className={`severity ${value || 'info'}`}>{value || 'info'}</span>; }
function Empty({ title, children }) { return <div className="empty-state"><div className="empty-mark">GPR</div><h2>{title}</h2><div className="empty-copy">{children}</div></div>; }

export default function App() {
  const [page, setPage] = useState(readPage);
  const [run, setRun] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedRound, setSelectedRound] = useState(null);
  const [selectedPoint, setSelectedPoint] = useState(null);
  const [severityFilter, setSeverityFilter] = useState('all');
  const [availability, setAvailability] = useState('all');
  const [eventTypeFilter, setEventTypeFilter] = useState('all');
  const [sortKey, setSortKey] = useState('roundId');
  const [sortDir, setSortDir] = useState(1);
  const [range, setRange] = useState([0, 100]);
  const importController = useRef(null);
  const reportSnapshot = useMemo(() => run ? createSnapshot(run) : null, [run]);
  const summary = useMemo(() => run ? run.analysis?.summary || summarizeRun(run) : null, [run]);
  const findings = useMemo(() => run ? run.analysis?.findings || generateFindings(run) : [], [run]);
  const rankedFindings = useMemo(() => run?.analysis?.rankedFindings || findings.slice().sort((a, b) => ({ critical: 0, warning: 1, info: 2 }[a.severity] - { critical: 0, warning: 1, info: 2 }[b.severity])).slice(0, 100), [run, findings]);
  const rounds = useMemo(() => run ? run.analysis?.rounds || summarizeRounds({ ...run, findings }) : [], [run, findings]);
  const sortedSamples = useMemo(() => run ? (run.chartSamples ? run.samples : [...run.samples].sort((a, b) => a.timestampMs - b.timestampMs)) : [], [run]);
  const findingsByRound = useMemo(() => {
    const indexed = new Map();
    for (const finding of findings) {
      const bucket = indexed.get(finding.roundId) || [];
      bucket.push(finding);
      indexed.set(finding.roundId, bucket);
    }
    return indexed;
  }, [findings]);
  const severityByRound = useMemo(() => {
    const ranks = { critical: 0, warning: 1, info: 2 };
    const indexed = new Map();
    for (const finding of findings) {
      if (finding.roundId === undefined) continue;
      const rank = ranks[finding.severity] ?? 2;
      if (!indexed.has(finding.roundId) || rank < (ranks[indexed.get(finding.roundId)] ?? 2)) indexed.set(finding.roundId, finding.severity);
    }
    return indexed;
  }, [findings]);
  const filteredSamples = useMemo(() => {
    if (!run || (run.chartSamples && range[0] === 0 && range[1] === 100)) return [];
    const all = sortedSamples;
    if (all.length < 2) return all;
    const start = all[0].timestampMs + (all.at(-1).timestampMs - all[0].timestampMs) * range[0] / 100;
    const end = all[0].timestampMs + (all.at(-1).timestampMs - all[0].timestampMs) * range[1] / 100;
    return all.filter(s => s.timestampMs >= start && s.timestampMs <= end);
  }, [run, range, sortedSamples]);
  const chartSamples = useMemo(() => {
    if (!run) return {};
    if (!run.chartSamples || range[0] !== 0 || range[1] !== 100) return Object.fromEntries(['cpuPercent', 'fps', 'jsHeapUsedBytes', 'reactCommitMs'].map(metric => [metric, filteredSamples]));
    const [first, last] = run.chartTimeRange;
    const start = first + (last - first) * range[0] / 100, end = first + (last - first) * range[1] / 100;
    return Object.fromEntries(Object.entries(run.chartSamples).map(([metric, samples]) => [metric, samples.filter(sample => sample.timestampMs >= start && sample.timestampMs <= end)]));
  }, [run, range, filteredSamples]);
  const visibleFindings = useMemo(() => {
    if (!run || !run.samples.length) return findings;
    const [minTime, maxTime] = run.chartTimeRange || run.samples.reduce(([min, max], sample) => [Math.min(min, sample.timestampMs), Math.max(max, sample.timestampMs)], [Infinity, -Infinity]);
    const start = minTime + (maxTime - minTime) * range[0] / 100, end = minTime + (maxTime - minTime) * range[1] / 100;
    return findings.filter(f => { const a = f.startMs ?? f.endMs, b = f.endMs ?? f.startMs; return a === undefined || b === undefined || (b >= start && a <= end); });
  }, [run, range, findings]);
  const currentEvents = run?.events || [];
  const longTasks = useMemo(() => run?.longTasks || run?.tasks?.filter(task => task.durationMs >= 50) || [], [run]);

  React.useEffect(() => {
    const onPop = () => setPage(readPage());
    addEventListener('popstate', onPop);
    return () => { removeEventListener('popstate', onPop); importController.current?.abort(); };
  }, []);
  function go(key) { history.pushState({}, '', pathFor(key)); setPage(key); }
  function cancelImport() {
    if (!importController.current) return;
    importController.current.abort();
    importController.current = null;
    setBusy(false);
    setNotice('Trace processing cancelled.');
  }
  function loadDemo() { cancelImport(); setRun(createDemoRun()); setError(''); setNotice('Synthetic 32-round fixture loaded. It is not measured game data.'); setSelectedRound(null); setRange([0, 100]); }
  async function importTrace(file) {
    if (!file) return;
    cancelImport();
    const controller = new AbortController();
    importController.current = controller;
    setBusy(true); setError(''); setNotice('Reading and analyzing trace…');
    try {
      if (!/\.json$/i.test(file.name) && !file.type.includes('json')) throw new Error('Select a .json Chrome trace file.');
      const parsed = await parseChromeTraceInWorker(file, file.name, message => setNotice(message), controller.signal);
      if (controller.signal.aborted) return;
      setRun(parsed); setSelectedRound(null); setRange([0, 100]); setNotice(`Imported ${file.name}: ${parsed.metadata.normalizedEventCount.toLocaleString()} recognized events.`);
    } catch (e) { if (e.name !== 'AbortError') { setError(e.message || 'Trace import failed.'); setNotice(''); } }
    finally { if (importController.current === controller) { importController.current = null; setBusy(false); } }
  }
  async function importMarkers(file) {
    if (!file || !run) return;
    cancelImport();
    const controller = new AbortController();
    importController.current = controller;
    setBusy(true); setError(''); setNotice('Correlating markers and recalculating analysis…');
    try {
      const updated = await importMarkersInWorker(run, file, message => setNotice(message), controller.signal);
      if (!controller.signal.aborted) {
        setRun(updated);
        setNotice(`${updated.events.length} game markers imported.${updated.metadata.markerDiagnostics?.outOfOrderCount ? ` ${updated.metadata.markerDiagnostics.outOfOrderCount} out-of-order marker(s) were detected and sorted.` : ''}${updated.metadata.markerDiagnostics?.duplicateCount ? ` ${updated.metadata.markerDiagnostics.duplicateCount} duplicate(s) were discarded.` : ''} Timestamp alignment follows the marker JSON contract.`);
      }
    } catch (e) { if (e.name !== 'AbortError') setError(e.message || 'Marker import failed.'); }
    finally { if (importController.current === controller) { importController.current = null; setBusy(false); } }
  }
  function download(name, content, type = 'text/csv;charset=utf-8') {
    const blob = new Blob([content], { type }), url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportHtml() { if (!run || !reportSnapshot) return; try { download(`${reportFileBase(run)}.html`, reportHtml(reportSnapshot), 'text/html;charset=utf-8'); setNotice('Standalone HTML report downloaded.'); setError(''); } catch (e) { setError(`HTML export failed: ${e.message}`); } }
  function exportPdf() {
    if (!run || !reportSnapshot) return;
    try { const popup = window.open('', '_blank'); if (!popup) throw new Error('The report window was blocked. Allow pop-ups for this page, then retry.'); popup.document.open(); popup.document.write(reportHtml(reportSnapshot)); popup.document.close(); popup.document.title = `${reportFileBase(run)}.pdf`; setNotice('Print-ready report opened. Choose “Save as PDF” in the browser print dialog.'); setError(''); setTimeout(() => popup.print(), 500); }
    catch (e) { setError(`PDF workflow unavailable: ${e.message}`); }
  }
  function exportCsv() { if (!run || !reportSnapshot) return; try { const files = reportCsvFiles(reportSnapshot), base = reportFileBase(run); for (const [key, csv] of Object.entries(files)) download(`${base}-${key}.csv`, csv); setNotice('Four CSV files downloaded from one report snapshot.'); setError(''); } catch (e) { setError(`CSV export failed: ${e.message}`); } }
  function sortRounds(key) { if (sortKey === key) setSortDir(-sortDir); else { setSortKey(key); setSortDir(1); } }
  const orderedRounds = useMemo(() => [...rounds].sort((a, b) => { const av = sortKey === 'events' ? a.events?.length : a[sortKey], bv = sortKey === 'events' ? b.events?.length : b[sortKey]; if (!Number.isFinite(av)) return Number.isFinite(bv) ? 1 : 0; if (!Number.isFinite(bv)) return -1; return (av - bv) * sortDir; }).filter(r => {
    if (severityFilter !== 'all' && !(findingsByRound.get(r.roundId) || []).some(f => f.severity === severityFilter)) return false;
    if (availability === 'missing-fps' && r.fpsAvg !== undefined) return false;
    if (availability === 'with-data' && r.fpsAvg === undefined && r.cpuAvg === undefined && r.heapDelta === undefined) return false;
    if (eventTypeFilter !== 'all' && !r.events?.some(event => event.type === eventTypeFilter)) return false;
    return true;
  }), [rounds, sortKey, sortDir, severityFilter, availability, eventTypeFilter, findingsByRound]);

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><div className="brand-icon">G</div><div><b>GPR</b><small>GAME PERFORMANCE</small></div></div><div className="nav-label">WORKSPACE</div><nav aria-label="Main navigation">{nav.map(([key, label, icon]) => <button className={`nav-item ${page === key ? 'active' : ''}`} key={key} onClick={() => go(key)} aria-current={page === key ? 'page' : undefined}><span>{icon}</span>{label}</button>)}</nav><div className="sidebar-bottom"><div className="capture-status"><span className="status-dot"/><div><b>Manual capture</b><small>Trace import available</small></div></div><small className="version">GPR · report schema v1</small></div></aside>
    <main className="main-area"><header className="topbar"><div><div className="eyebrow">ZEUS VS HADES / PERFORMANCE LAB</div><h1>{nav.find(n => n[0] === page)?.[1]}</h1></div><div className="run-meta"><span className="run-dot"/><div><small>SELECTED RUN</small><strong>{run ? run.id : 'No run selected'}</strong></div><button className="button secondary compact" onClick={loadDemo}>Load demo</button></div></header>
      {run && <div className="run-strip"><span className={`source-chip ${run.source === SOURCE.DEMO ? 'demo' : ''}`}>{run.source === SOURCE.DEMO ? 'DEMO DATA — NOT MEASURED' : run.source === SOURCE.TRACE ? 'CHROME TRACE' : 'RUNTIME INSTRUMENTATION'}</span><span>Build <b>{run.buildId}</b></span><span>Environment <b>{run.environment}</b></span><span>{run.source === SOURCE.TRACE ? 'Imported' : 'Started'} <b>{new Date(run.startedAt).toLocaleString()}</b></span>{run.events.length > 0 && <span>{run.metadata?.markedRoundCount ?? new Set(run.events.map(e => e.roundId)).size} marked rounds</span>}</div>}
      {(error || notice) && <div className={`toast ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>{error || notice}<button aria-label="Dismiss message" onClick={() => { setError(''); setNotice(''); }}>×</button></div>}
      {busy && <div className="progress"><span/>Processing trace in background…<button className="text-button" onClick={cancelImport}>Cancel</button></div>}
      {!run ? <div className="content"><Empty title="Start with a performance run">Import a Chrome DevTools trace to analyze observed browser activity, or load the clearly labelled synthetic fixture to explore the dashboard.<div className="empty-actions"><label className="button primary">Import Chrome trace<input type="file" accept=".json,application/json" hidden onChange={e => importTrace(e.target.files?.[0])}/></label><button className="button secondary" onClick={loadDemo}>Load demo fixture</button></div><p className="subtle">CPU utilization, game rounds, and framework activity only appear when supported measurements or markers are provided.</p></Empty></div> : <div className="content">
        {page === 'overview' && <>
          <section className="kpi-grid"><Kpi title="CPU utilization" value={summary.cpuAvg} unit="%" sub={summary.cpuAvg === undefined ? 'Not captured — task time is not CPU %' : `Average · peak ${summary.cpuPeak}%`}/><Kpi title="Frame performance" value={summary.fpsAvg} unit=" FPS" sub={summary.frameP95 === undefined ? 'No frame-time percentiles captured' : `Frame time p95 ${summary.frameP95} ms`} status={summary.slowFrames > 0 ? 'warning' : 'good'}/><Kpi title="JavaScript heap" value={summary.heapMax === undefined ? undefined : `${(summary.heapMax / 1048576).toFixed(1)} MiB`} sub={summary.heapDelta === undefined ? 'Change not captured' : `Observed change ${(summary.heapDelta / 1048576).toFixed(1)} MiB · not proof of leak`}/><Kpi title="React / Redux" value={summary.reactCommitP95} unit=" ms" sub={summary.reactCommitP95 === undefined ? 'Instrumentation not captured' : 'React commit p95'} status="neutral"/></section>
          <div className="charts-grid"><MetricChart title="CPU utilization" samples={chartSamples.cpuPercent} baseTime={run.startedAt} metric="cpuPercent" color="#6b8cff" unit="%" note="Browser traces typically report task activity, not CPU utilization."/><MetricChart title="Frame rate" samples={chartSamples.fps} baseTime={run.startedAt} metric="fps" color="#47d6b1" unit="FPS" onSelect={setSelectedPoint}/><MetricChart title="JavaScript heap" samples={chartSamples.jsHeapUsedBytes} baseTime={run.startedAt} metric="jsHeapUsedBytes" color="#ad87ff" unit="bytes"/><MetricChart title="React / Redux activity" samples={chartSamples.reactCommitMs} baseTime={run.startedAt} metric="reactCommitMs" color="#f3b855" unit="ms" note="Requires the optional application instrumentation adapter."/></div>
          <div className="columns"><section className="panel"><div className="panel-heading"><div><h3>Key findings</h3><p>Observed evidence, not proof of causation</p></div><button className="text-button" onClick={() => go('bottlenecks')}>View all →</button></div><FindingsList findings={findings.slice(0, 4)}/></section><section className="panel"><div className="panel-heading"><div><h3>Report outputs</h3><p>Exports share one normalized snapshot</p></div></div><div className="export-actions"><button className="button secondary" onClick={exportHtml}>↓ HTML report</button><button className="button secondary" onClick={exportPdf}>▣ Save as PDF</button><button className="button secondary" onClick={exportCsv}>⇩ CSV files</button></div><small className="subtle">PDF uses the browser print dialog. CSV produces four files.</small></section></div>
          <RoundTable rounds={rounds.slice(0, 8)} severityByRound={severityByRound} sortKey={sortKey} sortDir={sortDir} sortRounds={sortRounds} select={setSelectedRound} baseTime={run.startedAt}/><BottleneckTable findings={rankedFindings.slice(0, 5)} totalCount={findings.length}/>
        </>}
        {page === 'trends' && <><section className="panel range-panel"><div><h3>Time range</h3><p>Selection is applied consistently to all metric charts.</p></div><div className="range-controls"><label>Start <input type="range" min="0" max="95" value={range[0]} onChange={e => setRange([Math.min(Number(e.target.value), range[1] - 5), range[1]])}/><output>{range[0]}%</output></label><label>End <input type="range" min="5" max="100" value={range[1]} onChange={e => setRange([range[0], Math.max(Number(e.target.value), range[0] + 5)])}/><output>{range[1]}%</output></label><button className="button secondary compact" onClick={() => setRange([0, 100])}>Reset</button></div></section><div className="charts-grid"><MetricChart title="CPU utilization" samples={chartSamples.cpuPercent} baseTime={run.startedAt} metric="cpuPercent" color="#6b8cff" unit="%"/><MetricChart title="Frame rate" samples={chartSamples.fps} baseTime={run.startedAt} metric="fps" color="#47d6b1" unit="FPS" onSelect={setSelectedPoint}/><MetricChart title="JavaScript heap" samples={chartSamples.jsHeapUsedBytes} baseTime={run.startedAt} metric="jsHeapUsedBytes" color="#ad87ff" unit="bytes"/><MetricChart title="React / Redux activity" samples={chartSamples.reactCommitMs} baseTime={run.startedAt} metric="reactCommitMs" color="#f3b855" unit="ms"/></div><section className="panel"><div className="panel-heading"><div><h3>Game event markers</h3><p>Explicit imported markers; no inferred round boundaries</p></div></div>{currentEvents.length ? <><div className="event-track">{currentEvents.slice(0, 200).map((e, i) => <button key={`${e.timestampMs}-${i}`} className={`event-marker ${e.type.startsWith('bonus') ? 'bonus' : ''}`} onClick={() => setSelectedRound(e.roundId)} title={`${e.type} · ${timestampLabel(run.startedAt, e.timestampMs)}`}><i/>{e.type.replace(/([A-Z])/g, ' $1')} · R{e.roundId}</button>)}</div>{currentEvents.length > 200 && <small className="subtle">Showing first 200 of {currentEvents.length} markers.</small>}</> : <div className="inline-empty">No game markers are available. Import a marker sidecar on the Traces page to correlate rounds and events.</div>}{selectedPoint && <div className="evidence-box"><b>Selected sample</b><span>{selectedPoint.roundId ? `Round ${selectedPoint.roundId} · ` : ''}{timestampLabel(run.startedAt, selectedPoint.timestampMs)} · {Number.isFinite(selectedPoint.fps) ? `${selectedPoint.fps.toFixed(1)} FPS` : 'metric value unavailable'} · {selectedPoint.source}{selectedPoint.evidence?.eventName ? ` · ${selectedPoint.evidence.eventName}` : ''}{selectedPoint.evidence?.traceFile ? ` · ${selectedPoint.evidence.traceFile} @ ${selectedPoint.evidence.startUs} μs` : ''}</span></div>}</section><section className="panel"><div className="panel-heading"><h3>Correlated findings</h3></div><FindingsList findings={visibleFindings}/></section></>}
        {page === 'rounds' && <><section className="filterbar"><div><h3>Round-by-round performance</h3><p>{rounds.length ? `${rounds.length} explicit round intervals` : 'Round-level analysis unavailable without game markers.'}</p></div><label>Severity <select value={severityFilter} onChange={e => setSeverityFilter(e.target.value)}><option value="all">All severities</option><option value="critical">Critical</option><option value="warning">Warning</option><option value="info">Info</option></select></label><label>Availability <select value={availability} onChange={e => setAvailability(e.target.value)}><option value="all">All data</option><option value="with-data">Has measurements</option><option value="missing-fps">Missing FPS</option></select></label><label>Event <select value={eventTypeFilter} onChange={e => setEventTypeFilter(e.target.value)}><option value="all">All events</option><option value="bonusStart">Bonus start</option><option value="bonusEnd">Bonus end</option><option value="winAnimationStart">Win animation</option><option value="roundStart">Round start</option><option value="roundEnd">Round end</option></select></label></section><RoundTable rounds={orderedRounds} severityByRound={severityByRound} sortKey={sortKey} sortDir={sortDir} sortRounds={sortRounds} select={setSelectedRound} baseTime={run.startedAt}/>{selectedRound && <section className="panel detail-panel"><div className="panel-heading"><div><h3>Round {selectedRound} inspection</h3><p>Measurements are bounded by explicit marker timestamps.</p></div><button className="text-button" onClick={() => setSelectedRound(null)}>Close ×</button></div><div className="detail-grid">{[['Average CPU', rounds.find(r => r.roundId === selectedRound)?.cpuAvg, '%'], ['Average FPS', rounds.find(r => r.roundId === selectedRound)?.fpsAvg, ' FPS'], ['Frame p95', rounds.find(r => r.roundId === selectedRound)?.frameP95, ' ms'], ['Heap delta', rounds.find(r => r.roundId === selectedRound)?.heapDelta, ' bytes']].map(([label, value, unit]) => <div key={label}><small>{label}</small><b>{displayValue(value)}{Number.isFinite(value) ? unit : ''}</b></div>)}</div><FindingsList findings={findings.filter(f => f.roundId === selectedRound)}/></section>}</>}
        {page === 'bottlenecks' && <><section className="panel"><div className="panel-heading"><div><h3>Ranked findings</h3><p>Prioritized by severity; investigation suggestions are evidence-aware.</p></div><label>Severity <select value={severityFilter} onChange={e => setSeverityFilter(e.target.value)}><option value="all">All</option><option value="critical">Critical</option><option value="warning">Warning</option><option value="info">Info</option></select></label></div><FindingsList findings={findings.filter(f => severityFilter === 'all' || f.severity === severityFilter)} detailed/></section><BottleneckTable findings={rankedFindings} totalCount={findings.length}/></>}
        {page === 'traces' && <><div className="trace-grid"><section className="panel import-panel"><div className="panel-heading"><div><h3>Import Chrome trace</h3><p>Chrome DevTools Performance JSON exports</p></div></div><label className="drop-zone" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); importTrace(e.dataTransfer.files?.[0]); }}><span className="upload-icon">⇧</span><b>{busy ? 'Parsing…' : 'Choose trace JSON'}</b><small>Drag a trace here or choose a JSON file · streamed in a background worker</small><input type="file" accept=".json,application/json" onChange={e => importTrace(e.target.files?.[0])}/></label><div className="trace-note"><b>Recognized:</b> traceEvents arrays, {`{traceEvents: [...]}`} and common wrapper shapes; complete-duration and paired B/E events, thread metadata, recognized frames, heap counters, and main-thread tasks.<br/><b>Not claimed:</b> CPU utilization from task duration or rounds without explicit markers.</div><hr/><h3>Optional game marker sidecar</h3><p>Import marker JSON aligned to the trace clock. Unsupported or invalid markers are rejected with details.</p><label className="button secondary">Import markers<input type="file" accept=".json,application/json" hidden disabled={run.source === SOURCE.DEMO} onChange={e => importMarkers(e.target.files?.[0])}/></label>{run.source === SOURCE.DEMO && <small className="subtle block">Load a real trace before attaching markers. Demo data remains isolated.</small>}</section><section className="panel"><div className="panel-heading"><div><h3>Trace metadata</h3><p>Current run provenance and parsing coverage</p></div></div><MetaList run={run}/></section></div><section className="panel"><div className="panel-heading"><h3>Metric coverage</h3></div><Coverage run={run}/></section><section className="panel"><div className="panel-heading"><div><h3>Observed long tasks</h3><p>Task duration is not CPU utilization. Threshold: 50 ms.</p></div><span className="count-chip">{longTasks.length}</span></div><TaskTable tasks={longTasks}/></section><section className="panel"><div className="panel-heading"><h3>Correlated game markers</h3></div>{run.events.length ? <div className="table-wrap"><table><thead><tr><th>Timestamp (ms)</th><th>Round</th><th>Type</th><th>Name</th></tr></thead><tbody>{run.events.slice(0, 200).map((e, i) => <tr key={`${e.timestampMs}-${i}`}><td>{e.timestampMs.toFixed(2)}</td><td>{e.roundId}</td><td>{e.type}</td><td>{e.name || '—'}</td></tr>)}</tbody></table>{run.events.length > 200 && <small className="subtle">Showing first 200 of {run.events.length} markers.</small>}</div> : <p className="inline-empty">No correlated game markers yet. Trace-only analysis remains available.</p>}</section></>}
        {page === 'reports' && <><div className="report-layout"><section className="panel"><div className="panel-heading"><div><h3>Report snapshot</h3><p>Generated from the selected normalized run</p></div><span className="count-chip">schema v1</span></div><MetaList run={run}/><hr/><Coverage run={run}/></section><section className="panel"><div className="panel-heading"><div><h3>Export report</h3><p>All outputs derive from the same data snapshot.</p></div></div><div className="report-buttons"><button className="export-card" onClick={exportHtml}><span>HTML</span><b>Download standalone HTML report</b><small>Portable standalone report with coverage and findings</small><i>↓</i></button><button className="export-card" onClick={exportPdf}><span>PDF</span><b>Print-ready PDF workflow</b><small>Opens browser print; choose Save as PDF</small><i>▣</i></button><button className="export-card" onClick={exportCsv}><span>CSV</span><b>Download four data files</b><small>Rounds, samples, findings, and game events</small><i>⇩</i></button></div>{run.source === SOURCE.DEMO && <div className="warning-box">DEMO DATA — NOT MEASURED. This label is included in exported reports.</div>}</section></div><section className="panel"><div className="panel-heading"><div><h3>Baseline comparison</h3><p>A baseline is only comparable when build, environment, source, and measurement definitions align.</p></div></div><div className="inline-empty">No second compatible run is selected. Baseline deviation is intentionally not calculated.</div></section><section className="panel"><div className="panel-heading"><h3>Capture status</h3></div><p>Automatic browser capture is not implemented. Use Chrome DevTools to capture a trace and import it here. React/Redux instrumentation adapters are not connected to the game application.</p></section></>}
      </div>}
    </main>
    <footer className="mobile-nav">{nav.map(([key, label, icon]) => <button key={key} onClick={() => go(key)} className={page === key ? 'active' : ''}><span>{icon}</span><small>{label.split(' ')[0]}</small></button>)}</footer>
  </div>;
}

function FindingsList({ findings, detailed = false }) {
  if (!findings.length) return <div className="inline-empty">No findings supported by the available evidence.</div>;
  const visible = findings.slice(0, 100);
  return <><div className="finding-list">{visible.map(f => <article key={f.id} className="finding-row"><div className="finding-icon">{f.severity === 'critical' ? '!' : f.severity === 'warning' ? '△' : 'i'}</div><div className="finding-copy"><div className="finding-title"><b>{f.title}</b><Severity value={f.severity}/></div><p>{f.description}</p><div className="finding-meta"><span>{f.category}</span>{f.roundId && <span>Round {f.roundId}</span>}{Number.isFinite(f.value) && <span>{f.value} {f.unit}</span>}{f.evidence?.length > 0 && <span>{f.evidence.length} evidence reference(s)</span>}</div>{detailed && <small className="investigate">Next: inspect the cited trace event or profile interval and compare with an equivalent run.</small>}</div></article>)}</div>{findings.length > 100 && <small className="subtle">Showing first 100 of {findings.length} findings. Full findings remain included in report exports.</small>}</>;
}
function RoundTable({ rounds, severityByRound, sortKey, sortDir, sortRounds, select, baseTime }) {
  const columns = [['roundId','Round'],['startMs','Start timestamp'],['endMs','End timestamp'],['cpuAvg','Avg CPU %'],['cpuPeak','Peak CPU %'],['fpsAvg','Avg FPS'],['frameP50','Frame p50 ms'],['frameP95','Frame p95 ms'],['frameP99','Frame p99 ms'],['slowFrames','Slow frames'],['heapBefore','Heap before MiB'],['heapAfter','Heap after MiB'],['heapDelta','Heap Δ MiB'],['longTaskCount','Long tasks'],['longTaskDurationMs','Long task duration ms'],['events','Game markers'],['findingCount','Findings']];
  if (!rounds.length) return <section className="panel"><div className="panel-heading"><h3>Round analysis</h3></div><div className="inline-empty">No complete explicit round markers are available. Import marker data; rounds are not inferred from trace timing.</div></section>;
  return <section className="panel table-panel"><div className="panel-heading"><div><h3>Round-by-round performance</h3><p>Select a round to inspect available measurements.</p></div><span className="count-chip">{rounds.length} rounds</span></div><div className="table-wrap"><table><thead><tr>{columns.map(([key, label]) => <th key={key}><button className="sort-button" onClick={() => sortRounds(key)}>{label}{sortKey === key ? sortDir === 1 ? ' ↑' : ' ↓' : ''}</button></th>)}</tr></thead><tbody>{rounds.slice(0, 200).map(r => { const severity = severityByRound.get(r.roundId) || 'info'; return <tr key={r.roundId} className={select ? 'click-row' : ''} tabIndex={select ? 0 : undefined} aria-label={select ? `Inspect round ${r.roundId}` : undefined} onKeyDown={e => { if (select && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(r.roundId); } }} onClick={() => select?.(r.roundId)}><td><b>#{r.roundId}</b></td><td>{Number.isFinite(r.startMs) ? timestampLabel(baseTime, r.startMs) : '—'}</td><td>{Number.isFinite(r.endMs) ? timestampLabel(baseTime, r.endMs) : 'Not captured'}</td><td>{displayValue(r.cpuAvg)}</td><td>{displayValue(r.cpuPeak)}</td><td>{displayValue(r.fpsAvg)}</td><td>{displayValue(r.frameP50)}</td><td>{displayValue(r.frameP95)}</td><td>{displayValue(r.frameP99)}</td><td>{displayValue(r.slowFrames, 0)}</td><td>{r.heapBefore === undefined ? 'Not captured' : (r.heapBefore / 1048576).toFixed(1)}</td><td>{r.heapAfter === undefined ? 'Not captured' : (r.heapAfter / 1048576).toFixed(1)}</td><td>{r.heapDelta === undefined ? 'Not captured' : (r.heapDelta / 1048576).toFixed(1)}</td><td>{displayValue(r.longTaskCount, 0)}</td><td>{displayValue(r.longTaskDurationMs)}</td><td>{r.events?.filter(event => event.type.startsWith('bonus') || event.type.startsWith('winAnimation')).map(event => event.type).join(', ') || '—'}</td><td>{r.findingCount} · <Severity value={severity}/></td></tr>; })}</tbody></table></div>{rounds.length > 200 && <small className="subtle">Showing first 200 of {rounds.length} rounds.</small>}</section>;
}
function BottleneckTable({ findings, totalCount = findings.length }) { return <section className="panel table-panel"><div className="panel-heading"><div><h3>Top bottlenecks</h3><p>Prioritized observations linked to available run evidence.</p></div></div>{findings.length ? <><div className="table-wrap"><table><thead><tr><th>Finding</th><th>Category</th><th>Severity</th><th>Round</th><th>Observed value</th></tr></thead><tbody>{findings.slice(0, 100).map(f => <tr key={f.id}><td><b>{f.title}</b><small className="table-sub">{f.description}</small></td><td>{f.category}</td><td><Severity value={f.severity}/></td><td>{f.roundId ?? '—'}</td><td>{Number.isFinite(f.value) ? `${f.value} ${f.unit || ''}` : 'Not captured'}</td></tr>)}</tbody></table></div>{totalCount > findings.length && <small className="subtle">Showing {findings.length} prioritized findings of {totalCount}; full findings are retained in reports.</small>}</> : <div className="inline-empty">No findings available.</div>}</section>; }
function MetaList({ run }) { const items = [['Run ID', run.id], ['Game', run.game], ['Build', run.buildId], ['Environment', run.environment], [run.source === SOURCE.TRACE ? 'Imported at' : 'Started', new Date(run.startedAt).toLocaleString()], ['Source', run.source], ['Samples', run.samples.length], ['Events', run.metadata?.eventCount ?? run.events.length], ['Normalized events', run.metadata?.normalizedEventCount ?? '—'], ['Skipped malformed timestamps', run.metadata?.diagnostics?.malformedTimestampCount ?? '—'], ['Duplicate events discarded', run.metadata?.diagnostics?.duplicateEventCount ?? '—'], ['Unmatched duration markers', run.metadata?.diagnostics ? run.metadata.diagnostics.unmatchedEndCount + run.metadata.diagnostics.incompleteBeginCount : '—'], ['Threads', run.metadata?.threadInfo?.length ?? '—']]; return <div className="meta-list">{items.map(([k,v]) => <div key={k}><span>{k}</span><b>{v}</b></div>)}{run.metadata?.threadInfo?.length > 0 && <details><summary>Process / thread information</summary><ul>{run.metadata.threadInfo.slice(0, 30).map((line,i) => <li key={i}>{line}</li>)}</ul></details>}{run.metadata?.limitations?.map((item,i)=><p className="limitation" key={i}>ⓘ {item}</p>)}</div>; }
function Coverage({ run }) { const coverage = run.analysis?.summary.coverage || metricCoverage(run); return <div className="coverage-grid">{Object.entries(coverage).map(([name, info]) => <div key={name} className="coverage-item"><span className={info.available ? 'cover-dot yes' : 'cover-dot'}/><div><b>{name}</b><small>{info.available ? 'Available' : 'Not captured'} · {info.note}</small></div></div>)}</div>; }
function TaskTable({ tasks }) { return tasks.length ? <div className="table-wrap"><table><thead><tr><th>Time (relative ms)</th><th>Duration</th><th>Event</th><th>Round</th><th>Thread evidence</th></tr></thead><tbody>{tasks.slice(0, 150).map((t,i)=><tr key={`${t.timestampMs}-${i}`}><td>{t.timestampMs.toFixed(2)}</td><td><Severity value={t.durationMs >= 100 ? 'critical' : 'warning'}/>&nbsp;{t.durationMs.toFixed(1)} ms</td><td>{t.eventName}</td><td>{t.roundId ?? '—'}</td><td>{t.evidence?.threadId ?? '—'} / {t.evidence?.processId ?? '—'}</td></tr>)}</tbody></table>{tasks.length > 150 && <small className="subtle">Showing first 150 of {tasks.length} tasks.</small>}</div> : <div className="inline-empty">No supported main-thread tasks found. Thread metadata may be absent.</div>; }
