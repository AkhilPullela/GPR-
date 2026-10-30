import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createDemoRun } from './gpr/demo.js';
import { analyzeRun, summarizeRounds, summarizeRun, generateFindings } from './gpr/analyze.js';
import { importMarkersInWorker, parseChromeTraceInWorker } from './gpr/traceWorkerClient.js';
import { createSnapshot, reportHtml, reportCsvFiles, reportFileBase } from './gpr/reports.js';
import { SOURCE, displayValue, metricAvailability, METRIC_STATUS_LABEL, SEVERITY_RANK } from './gpr/model.js';
import { GLOSSARY } from './gpr/glossary.js';
import { createImportManager, initialImportState, isBusyStage, STAGE_LABEL } from './gpr/importSession.js';
import './styles.css';

const nav = [
  ['overview', 'Overview', '◫'], ['trends', 'Performance trends', '⌁'], ['rounds', 'Round analysis', '▤'], ['bottlenecks', 'Bottlenecks', '⚑'], ['traces', 'Traces', '⇧'], ['reports', 'Reports', '⇩']
];
const pathFor = key => `/${key}`;
function readPage() { const key = location.pathname.replace(/^\//, '').split('/')[0]; return nav.some(item => item[0] === key) ? key : 'overview'; }
function timestampLabel(timestampMs) { return `+${timestampMs.toFixed(0)} ms`; }
function formatBytes(bytes) { return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MiB` : `${(bytes / 1024).toFixed(0)} KiB`; }
function formatDuration(ms) { return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`; }

/** Accessible definition popover. Native title is avoided so the text is keyboard reachable. */
function Term({ id, children }) {
  const entry = GLOSSARY[id];
  const [open, setOpen] = useState(false);
  if (!entry) return <>{children}</>;
  return <span className="term-wrap">
    <button type="button" className="term" aria-expanded={open} aria-label={`${entry.term}: ${entry.definition}`} onClick={() => setOpen(v => !v)} onBlur={() => setOpen(false)}>{children ?? entry.term}<i aria-hidden="true">?</i></button>
    {open && <span role="tooltip" className="term-popover"><b>{entry.term}</b>{entry.definition}</span>}
  </span>;
}

function MetricChart({ title, samples, metric, color, unit, selected, onSelect, note, term, findings, onOpenFinding }) {
  const allValues = useMemo(() => samples.filter(s => Number.isFinite(s[metric])), [samples, metric]);
  const width = 640, height = 205, pad = { l: 44, r: 12, t: 14, b: 28 };
  if (!allValues.length) return <section className="panel chart-panel"><div className="panel-heading"><h3>{term ? <Term id={term}>{title}</Term> : title}</h3><span className="unit">{unit}</span></div><div className="chart-empty"><span className="empty-icon">∿</span><b>Not captured</b><p>{note || 'This run contains no supported measurements for this metric. It is not shown as zero.'}</p></div></section>;
  const values = allValues;
  const x0 = values[0].timestampMs, x1 = values[values.length - 1].timestampMs;
  const ys = values.map(s => s[metric]);
  const low = ys.reduce((a, b) => Math.min(a, b), Infinity), high = ys.reduce((a, b) => Math.max(a, b), -Infinity), span = high - low || 1;
  const x = v => pad.l + ((v - x0) / (x1 - x0 || 1)) * (width - pad.l - pad.r);
  const y = v => height - pad.b - ((v - low) / span) * (height - pad.t - pad.b);
  const points = values.map(s => `${x(s.timestampMs).toFixed(1)},${y(s[metric]).toFixed(1)}`).join(' ');
  const coverage = `${values.length} sample(s) from ${timestampLabel(x0)} to ${timestampLabel(x1)}`;
  return <section className="panel chart-panel">
    <div className="panel-heading"><h3>{term ? <Term id={term}>{title}</Term> : title}</h3><span className="unit">{unit} · observed</span></div>
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title} chart. ${coverage}.`}>
      {[0, .5, 1].map((tick, i) => <g key={i}><line x1={pad.l} x2={width - pad.r} y1={pad.t + tick * (height - pad.t - pad.b)} y2={pad.t + tick * (height - pad.t - pad.b)} className="gridline"/><text x={pad.l - 7} y={pad.t + tick * (height - pad.t - pad.b) + 4} textAnchor="end" className="axis-label">{(high - tick * span).toFixed(0)}</text></g>)}
      {selected && <rect x={x(selected[0])} y={pad.t} width={Math.max(0, x(selected[1]) - x(selected[0]))} height={height - pad.t - pad.b} fill="rgba(101,129,255,.12)"/>}
      <polyline points={points} fill="none" stroke={color} strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round"/>
      {values.map((s, i) => <circle key={`${s.timestampMs}-${i}`} cx={x(s.timestampMs)} cy={y(s[metric])} r="3.2" fill={color} tabIndex="0" aria-label={`${s.roundId ? `Round ${s.roundId}, ` : ''}${timestampLabel(s.timestampMs)}, ${s[metric].toFixed(1)} ${unit}`} onClick={() => onSelect?.(s)} onKeyDown={e => e.key === 'Enter' && onSelect?.(s)}><title>{s.roundId ? `Round ${s.roundId} · ` : ''}${timestampLabel(s.timestampMs)} · ${s[metric].toFixed(1)} ${unit}</title></circle>)}
      <text x={pad.l} y={height - 5} className="axis-label">Start</text><text x={pad.r} y={height - 5} textAnchor="end" className="axis-label">End</text>
    </svg>
    <div className="chart-foot"><small className="subtle">{coverage}</small>{onOpenFinding && findings?.length > 0 && <button className="text-button" onClick={() => onOpenFinding(findings)}>Open related findings →</button>}</div>
  </section>;
}

function Kpi({ title, term, value, unit, sub, status = 'neutral', statusKey, availability }) {
  const info = statusKey && availability ? availability[statusKey] : undefined;
  const unavailable = info && !info.available;
  return <article className={`kpi ${status} ${unavailable ? 'kpi-unavailable' : ''}`}>
    <div className="kpi-top"><span>{term ? <Term id={term}>{title}</Term> : title}</span><i /></div>
    <strong>{unavailable ? 'Not captured' : (value === undefined || value === null ? 'Not captured' : `${value}${unit || ''}`)}</strong>
    {info && <span className={`metric-status status-${info.status}`}>{METRIC_STATUS_LABEL[info.status]}</span>}
    <small>{unavailable && info ? info.reason : sub}</small>
  </article>;
}
function Severity({ value }) { return <span className={`severity ${value || 'info'}`}>{value || 'info'}</span>; }
function Empty({ title, children }) { return <div className="empty-state"><div className="empty-mark">GPR</div><h2>{title}</h2><div className="empty-copy">{children}</div></div>; }

export default function App() {
  const [page, setPage] = useState(readPage);
  const [run, setRun] = useState(null);
  const [importState, setImportState] = useState(initialImportState);
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
  const [view, setView] = useState('simple');
  const [showAllFindings, setShowAllFindings] = useState(false);
  const importManager = useRef(null);
  const markerController = useRef(null);
  const lastFile = useRef(null);
  const timer = useRef(null);
  // Bumped on every accepted import so child panels remount with fresh data
  // instead of holding on to a previous run's local state.
  const [runEpoch, setRunEpoch] = useState(0);

  if (!importManager.current) {
    importManager.current = createImportManager({
      parse: (file, fileName, onProgress, signal) => parseChromeTraceInWorker(file, fileName, onProgress, signal),
      onState: state => setImportState(state),
      onResult: (parsed, file) => {
        // Atomic handoff: metadata and analysis land in one state update.
        lastFile.current = file;
        setRun(parsed);
        setSelectedRound(null);
        setSelectedPoint(null);
        setRange([0, 100]);
        setSeverityFilter('all');
        setAvailability('all');
        setEventTypeFilter('all');
        setRunEpoch(epoch => epoch + 1);
        setError('');
        setNotice(`Imported ${file.name}: ${parsed.metadata.normalizedEventCount.toLocaleString()} recognized events, ${parsed.tasks.length.toLocaleString()} main-thread tasks.`);
      },
      onError: () => {
        // The previous successful run is intentionally left in place.
        setNotice('');
      }
    });
  }

  const reportSnapshot = useMemo(() => run ? createSnapshot(run) : null, [run]);
  const summary = useMemo(() => run ? run.analysis?.summary || summarizeRun(run) : null, [run]);
  const findings = useMemo(() => run ? run.analysis?.findings || generateFindings(run) : [], [run]);
  const rankedFindings = useMemo(() => run?.analysis?.rankedFindings || findings.slice().sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)), [run, findings]);
  const rounds = useMemo(() => run ? run.analysis?.rounds || summarizeRounds({ ...run, findings }) : [], [run, findings]);
  const sortedSamples = useMemo(() => run ? (run.analysis?.chartSamples ? run.samples : run.samples) : [], [run]);
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
    const indexed = new Map();
    for (const finding of findings) {
      if (finding.roundId === undefined) continue;
      const rank = SEVERITY_RANK[finding.severity] ?? 2;
      if (!indexed.has(finding.roundId) || rank < (SEVERITY_RANK[indexed.get(finding.roundId)] ?? 2)) indexed.set(finding.roundId, finding.severity);
    }
    return indexed;
  }, [findings]);
  const chartSamples = useMemo(() => {
    if (!run) return {};
    const source = run.analysis?.chartSamples || {};
    const [first, last] = run.analysis?.chartTimeRange || [0, 0];
    const start = first + (last - first) * range[0] / 100, end = first + (last - first) * range[1] / 100;
    return Object.fromEntries(Object.entries(source).map(([metric, samples]) => [metric, samples.filter(sample => sample.timestampMs >= start && sample.timestampMs <= end)]));
  }, [run, range]);
  const visibleFindings = useMemo(() => {
    if (!run || !run.samples.length) return findings;
    const [minTime, maxTime] = run.analysis?.chartTimeRange || [run.samples[0].timestampMs, run.samples[run.samples.length - 1].timestampMs];
    const start = minTime + (maxTime - minTime) * range[0] / 100, end = minTime + (maxTime - minTime) * range[1] / 100;
    return findings.filter(f => { const a = f.startMs ?? f.endMs, b = f.endMs ?? f.startMs; return a === undefined || b === undefined || (b >= start && a <= end); });
  }, [run, range, findings]);
  const currentEvents = run?.events || [];
  const longTasks = useMemo(() => run?.analysis?.longTasks || run?.tasks?.filter(task => task.durationMs >= 50) || [], [run]);
  const selectedRoundData = useMemo(() => rounds.find(r => r.roundId === selectedRound), [rounds, selectedRound]);

  useEffect(() => {
    const onPop = () => setPage(readPage());
    addEventListener('popstate', onPop);
    return () => { removeEventListener('popstate', onPop); importManager.current?.dispose(); clearInterval(timer.current); };
  }, []);

  function startTimer() {
    clearInterval(timer.current);
    const startedAt = Date.now();
    timer.current = setInterval(() => setImportState(s => (s.status === 'idle' || s.status === 'completed' || s.status === 'error' || s.status === 'cancelled') ? s : { ...s, elapsedMs: Date.now() - startedAt }), 250);
  }
  function stopTimer() { clearInterval(timer.current); timer.current = null; }

  function go(key) { history.pushState({}, '', pathFor(key)); setPage(key); }
  function cancelImport() {
    importManager.current?.cancel();
    if (markerController.current) { markerController.current.abort(); markerController.current = null; }
    stopTimer();
    setNotice('Trace processing cancelled. The original file is unchanged.');
  }
  function loadDemo() { cancelImport(); setRun(analyzeRun(createDemoRun())); setError(''); setNotice('Synthetic 32-round fixture loaded. It is not measured game data.'); setSelectedRound(null); setRange([0, 100]); setRunEpoch(epoch => epoch + 1); importManager.current?.reset(); }
  function resetImport() { lastFile.current = null; importManager.current?.reset(); }
  function importTrace(file) { if (!file) return; startTimer(); importManager.current?.start(file).finally(stopTimer); }
  function retryImport() { if (lastFile.current) importTrace(lastFile.current); }

  async function importMarkers(file) {
    if (!file || !run) return;
    cancelImport();
    const controller = new AbortController();
    markerController.current = controller;
    startTimer();
    setImportState(s => ({ ...s, status: 'analyzing', stage: 'analyzing', message: 'Correlating markers and recalculating analysis…', error: '', canRetry: false }));
    setError('');
    try {
      const updated = await importMarkersInWorker(run, file, progress => {
        if (!controller.signal.aborted) setImportState(s => ({ ...s, stage: progress.stage || s.stage, message: progress.message, percent: Number.isFinite(progress.percent) ? progress.percent : undefined }));
      }, controller.signal);
      if (!controller.signal.aborted) {
        setRun(updated);
        setRunEpoch(epoch => epoch + 1);
        stopTimer();
        setImportState(s => ({ ...s, status: 'completed', stage: 'completed', message: `${updated.events.length} game markers imported.`, percent: undefined, canCancel: false }));
        setNotice(`${updated.events.length} game markers imported.${updated.metadata.markerDiagnostics?.outOfOrderCount ? ` ${updated.metadata.markerDiagnostics.outOfOrderCount} out-of-order marker(s) were detected and sorted.` : ''}${updated.metadata.markerDiagnostics?.duplicateCount ? ` ${updated.metadata.markerDiagnostics.duplicateCount} duplicate(s) were discarded.` : ''} Timestamp alignment follows the marker JSON contract.`);
      }
    } catch (e) {
      stopTimer();
      if (e.name !== 'AbortError') { setError(e.message || 'Marker import failed.'); setImportState(s => ({ ...s, status: 'error', stage: 'error', message: e.message || 'Marker import failed.', canRetry: false, canCancel: false })); }
    } finally { if (markerController.current === controller) markerController.current = null; }
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
  function openFindings(list) { setPage('bottlenecks'); history.pushState({}, '', pathFor('bottlenecks')); if (list?.length) setSeverityFilter('all'); }

  const orderedRounds = useMemo(() => [...rounds].sort((a, b) => { const av = sortKey === 'events' ? a.events?.length : a[sortKey], bv = sortKey === 'events' ? b.events?.length : b[sortKey]; if (!Number.isFinite(av)) return Number.isFinite(bv) ? 1 : 0; if (!Number.isFinite(bv)) return -1; return (av - bv) * sortDir; }).filter(r => {
    if (severityFilter !== 'all' && !(findingsByRound.get(r.roundId) || []).some(f => f.severity === severityFilter)) return false;
    if (availability === 'missing-fps' && r.fpsAvg !== undefined) return false;
    if (availability === 'with-data' && r.fpsAvg === undefined && r.cpuAvg === undefined && r.heapDelta === undefined) return false;
    if (eventTypeFilter !== 'all' && !r.events?.some(event => event.type === eventTypeFilter)) return false;
    return true;
  }), [rounds, sortKey, sortDir, severityFilter, availability, eventTypeFilter, findingsByRound]);

  const isBusy = isBusyStage(importState.stage);

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><div className="brand-icon">G</div><div><b>GPR</b><small>GAME PERFORMANCE</small></div></div><div className="nav-label">WORKSPACE</div><nav aria-label="Main navigation">{nav.map(([key, label, icon]) => <button className={`nav-item ${page === key ? 'active' : ''}`} key={key} onClick={() => go(key)} aria-current={page === key ? 'page' : undefined}><span>{icon}</span>{label}</button>)}</nav><div className="sidebar-bottom"><div className="capture-status"><span className="status-dot"/><div><b>Manual capture</b><small>Trace import available</small></div></div><small className="version">GPR · report schema v2</small></div></aside>
    <main className="main-area"><header className="topbar"><div><div className="eyebrow">ZEUS VS HADES / PERFORMANCE LAB</div><h1>{nav.find(n => n[0] === page)?.[1]}</h1></div><div className="run-meta"><span className="run-dot"/><div><small>SELECTED RUN</small><strong>{run ? run.id : 'No run selected'}</strong></div><button className="button secondary compact" onClick={loadDemo}>Load demo</button></div></header>
      {run && <div className="run-strip"><span className={`source-chip ${run.source === SOURCE.DEMO ? 'demo' : ''}`}>{run.source === SOURCE.DEMO ? 'DEMO DATA — NOT MEASURED' : run.source === SOURCE.TRACE ? 'CHROME TRACE' : 'RUNTIME INSTRUMENTATION'}</span><span>Build <b>{run.buildId}</b></span><span>Environment <b>{run.environment}</b></span><span>{run.source === SOURCE.TRACE ? 'Imported' : 'Started'} <b>{new Date(run.startedAt).toLocaleString()}</b></span>{run.events.length > 0 && <span>{run.metadata?.markedRoundCount ?? new Set(run.events.map(e => e.roundId)).size} marked rounds</span>}</div>}
      {(error || notice) && <div className={`toast ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>{error || notice}<button aria-label="Dismiss message" onClick={() => { setError(''); setNotice(''); }}>×</button></div>}
      <div className="toolbar-row">
        <div className="view-switch" role="group" aria-label="Detail level"><span className="view-label">Detail</span><button className={view === 'simple' ? 'active' : ''} onClick={() => setView('simple')} aria-pressed={view === 'simple'}>Simple</button><button className={view === 'technical' ? 'active' : ''} onClick={() => setView('technical')} aria-pressed={view === 'technical'}>Technical</button></div>
        <small className="subtle">{view === 'simple' ? 'Plain-English findings, impact, and next steps.' : 'Timeline, distributions, raw events, and evidence.'}</small>
      </div>
      {!run ? <div className="content"><Empty title="Start with a performance run">Import a Chrome DevTools trace to analyze observed browser activity, or load the clearly labelled synthetic fixture to explore the dashboard.<div className="empty-actions"><TraceFileInput onFile={importTrace} className="button primary" label="Import Chrome trace"/><button className="button secondary" onClick={loadDemo}>Load demo fixture</button></div><p className="subtle">Main-thread busy time, game rounds, and framework activity only appear when supported measurements or markers are provided. CPU utilization is never invented from task time.</p></Empty></div> : <div className="content">
        {page === 'overview' && <>
          <Overview summary={summary} run={run} findings={rankedFindings} rounds={rounds} coverage={summary.coverage} coverageAvailability={run.metadata?.availability || metricAvailability(run)} chartSamples={chartSamples} view={view} selectedPoint={selectedPoint} setSelectedPoint={setSelectedPoint} go={go} openFindings={openFindings} selectedRound={selectedRound} setSelectedRound={setSelectedRound} severityByRound={severityByRound} sortKey={sortKey} sortDir={sortDir} sortRounds={sortRounds} showAll={showAllFindings} setShowAll={setShowAllFindings} exportHtml={exportHtml} exportPdf={exportPdf} exportCsv={exportCsv}/>
        </>}
        {page === 'trends' && <>
          <section className="panel range-panel"><div><h3>Time range</h3><p>Selection is applied consistently to all metric charts.</p></div><div className="range-controls"><label>Start <input type="range" min="0" max="95" value={range[0]} onChange={e => setRange([Math.min(Number(e.target.value), range[1] - 5), range[1]])}/><output>{range[0]}%</output></label><label>End <input type="range" min="5" max="100" value={range[1]} onChange={e => setRange([range[0], Math.max(Number(e.target.value), range[0] + 5)])}/><output>{range[1]}%</output></label><button className="button secondary compact" onClick={() => setRange([0, 100])}>Reset</button></div></section>
          <div className="charts-grid">
            <MetricChart title="Main-thread busy time" term="mainThreadBlocking" samples={chartSamples.mainThreadBusyPercent || []} metric="mainThreadBusyPercent" color="#6b8cff" unit="%" note="Derived from main-thread task intervals, merged so nested work is counted once. This is not CPU utilization." onSelect={setSelectedPoint} findings={findings.filter(f => f.category === 'cpu')} onOpenFinding={openFindings}/>
            <MetricChart title="Frame rate" term="fps" samples={chartSamples.fps || []} metric="fps" color="#47d6b1" unit="FPS" onSelect={setSelectedPoint} findings={findings.filter(f => f.category === 'frames')} onOpenFinding={openFindings}/>
            <MetricChart title="JavaScript heap" term="jsHeap" samples={chartSamples.jsHeapUsedBytes || []} metric="jsHeapUsedBytes" color="#ad87ff" unit="bytes" onSelect={setSelectedPoint} findings={findings.filter(f => f.category === 'memory')} onOpenFinding={openFindings}/>
            <MetricChart title="CPU utilization" term="mainThreadBlocking" samples={chartSamples.cpuPercent || []} metric="cpuPercent" color="#6b8cff" unit="%" note="Chrome DevTools traces do not record CPU utilization. This chart stays empty unless the trace contains explicit utilization samples." onSelect={setSelectedPoint} findings={findings.filter(f => f.category === 'cpu')} onOpenFinding={openFindings}/>
          </div>
          <section className="panel"><div className="panel-heading"><div><h3>Game event markers</h3><p>Explicit imported markers; no inferred round boundaries</p></div></div>{currentEvents.length ? <><div className="event-track">{currentEvents.slice(0, 200).map((e, i) => <button key={`${e.timestampMs}-${i}`} className={`event-marker ${e.type.startsWith('bonus') ? 'bonus' : ''}`} onClick={() => setSelectedRound(e.roundId)} title={`${e.type} · ${timestampLabel(e.timestampMs)}`}><i/>{e.type.replace(/([A-Z])/g, ' $1')} · R{e.roundId}</button>)}</div>{currentEvents.length > 200 && <small className="subtle">Showing first 200 of {currentEvents.length} markers.</small>}</> : <div className="inline-empty">No game markers are available. Import a marker sidecar on the Traces page to correlate rounds and events. Trace-level analysis remains valid.</div>}{selectedPoint && <div className="evidence-box"><b>Selected sample</b><span>{selectedPoint.roundId ? `Round ${selectedPoint.roundId} · ` : ''}{timestampLabel(selectedPoint.timestampMs)} · {Number.isFinite(selectedPoint.fps) ? `${selectedPoint.fps.toFixed(1)} FPS` : 'metric value unavailable'} · {selectedPoint.source}{selectedPoint.evidence?.eventName ? ` · ${selectedPoint.evidence.eventName}` : ''}{selectedPoint.evidence?.traceFile ? ` · ${selectedPoint.evidence.traceFile} @ ${selectedPoint.evidence.startUs} μs` : ''}</span></div>}</section>
          <section className="panel"><div className="panel-heading"><h3>Correlated findings</h3><p>Findings whose time range intersects the selected window.</p></div><FindingsList findings={visibleFindings} detailed={view === 'technical'} view={view}/></section>
        </>}
        {page === 'rounds' && <>
          <section className="filterbar"><div><h3>Round-by-round performance</h3><p>{rounds.length ? `${rounds.length} explicit round intervals` : 'Round-level analysis unavailable without game markers. Trace-level findings remain available.'}</p></div><label>Severity <select value={severityFilter} onChange={e => setSeverityFilter(e.target.value)}><option value="all">All severities</option><option value="critical">Critical</option><option value="warning">Warning</option><option value="info">Info</option></select></label><label>Availability <select value={availability} onChange={e => setAvailability(e.target.value)}><option value="all">All data</option><option value="with-data">Has measurements</option><option value="missing-fps">Missing FPS</option></select></label><label>Event <select value={eventTypeFilter} onChange={e => setEventTypeFilter(e.target.value)}><option value="all">All events</option><option value="bonusStart">Bonus start</option><option value="bonusEnd">Bonus end</option><option value="winAnimationStart">Win animation</option><option value="roundStart">Round start</option><option value="roundEnd">Round end</option></select></label></section>
          <RoundTable rounds={orderedRounds} severityByRound={severityByRound} sortKey={sortKey} sortDir={sortDir} sortRounds={sortRounds} select={setSelectedRound} view={view}/>
          {selectedRoundData && <section className="panel detail-panel"><div className="panel-heading"><div><h3>Round {selectedRound} inspection</h3><p>Measurements are bounded by explicit marker timestamps.</p></div><button className="text-button" onClick={() => setSelectedRound(null)}>Close ×</button></div><div className="detail-grid">{[['Average CPU', selectedRoundData.cpuAvg, '%', 'mainThreadBlocking'], ['Average FPS', selectedRoundData.fpsAvg, ' FPS', 'fps'], ['Frame p95', selectedRoundData.frameP95, ' ms', 'frameP95'], ['Heap delta', selectedRoundData.heapDelta, ' bytes', 'heapGrowth']].map(([label, value, unit, term]) => <div key={label}><small><Term id={term}>{label}</Term></small><b>{displayValue(value)}{Number.isFinite(value) ? unit : ''}</b></div>)}</div>{selectedRoundData.incomplete && <p className="limitation">ⓘ This round has a start marker but no matching end marker, so bounded measurements are unavailable.</p>}<FindingsList findings={findings.filter(f => f.roundId === selectedRound)} view={view}/></section>}
        </>}
        {page === 'bottlenecks' && <>
          <section className="panel"><div className="panel-heading"><div><h3>Ranked findings</h3><p>Prioritized by transparent factors: severity, duration, recurrence, and evidence quality.</p></div><label>Severity <select value={severityFilter} onChange={e => setSeverityFilter(e.target.value)}><option value="all">All</option><option value="critical">Critical</option><option value="warning">Warning</option><option value="info">Info</option></select></label></div><FindingsList findings={rankedFindings.filter(f => severityFilter === 'all' || f.severity === severityFilter)} detailed view={view} all={showAllFindings} onToggleAll={setShowAllFindings}/></section>
          <BottleneckTable findings={rankedFindings} totalCount={findings.length} view={view}/>
        </>}
        {page === 'traces' && <>
          <div className="trace-grid">
            <section className="panel import-panel">
              <div className="panel-heading"><div><h3>Import Chrome trace</h3><p>Chrome DevTools Performance JSON exports</p></div></div>
              <ImportPanel key={runEpoch} state={importState} onFile={importTrace} onCancel={cancelImport} onRetry={retryImport} onReset={resetImport} isBusy={isBusy}/>
              <div className="trace-note"><b>Recognized:</b> traceEvents arrays, {`{traceEvents: [...]}`}, and common wrapper shapes; complete-duration and paired B/E events, thread metadata, recognized frames, heap counters, and main-thread tasks.<br/><b>Not claimed:</b> CPU utilization from task duration or rounds without explicit markers. Parsing runs in a background worker, so the file is read once and never re-read or copied into the UI.</div>
              <hr/><h3>Optional game marker sidecar</h3><p>Import marker JSON aligned to the trace clock. Unsupported or invalid markers are rejected with details.</p><TraceFileInput onFile={importMarkers} className="button secondary" label="Import markers" disabled={run.source === SOURCE.DEMO}/>{run.source === SOURCE.DEMO && <small className="subtle block">Load a real trace before attaching markers. Demo data remains isolated.</small>}
            </section>
            <section className="panel"><div className="panel-heading"><div><h3>Trace metadata</h3><p>Current run provenance and parsing coverage</p></div></div><MetaList run={run}/></section>
          </div>
          <section className="panel"><div className="panel-heading"><h3>Metric coverage</h3></div><Coverage run={run}/></section>
          {view === 'technical' && <><section className="panel"><div className="panel-heading"><div><h3>Observed long tasks</h3><p>Task duration is not CPU utilization. Threshold: 50 ms.</p></div><span className="count-chip">{longTasks.length}</span></div><TaskTable tasks={longTasks}/></section>
          <section className="panel"><div className="panel-heading"><h3>Correlated game markers</h3></div>{run.events.length ? <div className="table-wrap"><table><thead><tr><th>Timestamp (ms)</th><th>Round</th><th>Type</th><th>Name</th></tr></thead><tbody>{run.events.slice(0, 200).map((e, i) => <tr key={`${e.timestampMs}-${i}`}><td>{e.timestampMs.toFixed(2)}</td><td>{e.roundId}</td><td>{e.type}</td><td>{e.name || '—'}</td></tr>)}</tbody></table>{run.events.length > 200 && <small className="subtle">Showing first 200 of {run.events.length} markers.</small>}</div> : <p className="inline-empty">No correlated game markers yet. Trace-only analysis remains available.</p>}</section></>}
        </>}
        {page === 'reports' && <>
          <div className="report-layout"><section className="panel"><div className="panel-heading"><div><h3>Report snapshot</h3><p>Generated from the selected normalized run</p></div><span className="count-chip">schema v2</span></div><MetaList run={run}/><hr/><Coverage run={run}/></section><section className="panel"><div className="panel-heading"><div><h3>Export report</h3><p>All outputs derive from the same data snapshot.</p></div></div><div className="report-buttons"><button className="export-card" onClick={exportHtml}><span>HTML</span><b>Download standalone HTML report</b><small>Executive summary, findings, charts, and metric definitions</small><i>↓</i></button><button className="export-card" onClick={exportPdf}><span>PDF</span><b>Print-ready PDF workflow</b><small>Paginated, no clipped charts; choose Save as PDF</small><i>▣</i></button><button className="export-card" onClick={exportCsv}><span>CSV</span><b>Download four data files</b><small>Rounds, samples, findings, and game events</small><i>⇩</i></button></div>{run.source === SOURCE.DEMO && <div className="warning-box">DEMO DATA — NOT MEASURED. This label is included in exported reports.</div>}</section></div>
          <section className="panel"><div className="panel-heading"><div><h3>Baseline comparison</h3><p>A baseline is only comparable when build, environment, source, and measurement definitions align.</p></div></div><div className="inline-empty">No second compatible run is selected. Baseline deviation is intentionally not calculated.</div></section>
          <section className="panel"><div className="panel-heading"><h3>Capture status</h3></div><p>Automatic browser capture is not implemented. Use Chrome DevTools to capture a trace and import it here. React/Redux instrumentation adapters are not connected to the game application.</p></section>
        </>}
      </div>}
    </main>
    <footer className="mobile-nav">{nav.map(([key, label, icon]) => <button key={key} onClick={() => go(key)} className={page === key ? 'active' : ''}><span>{icon}</span><small>{label.split(' ')[0]}</small></button>)}</footer>
  </div>;
}

function Overview({ summary, run, findings, rounds, coverage, coverageAvailability, chartSamples, view, selectedPoint, setSelectedPoint, go, openFindings, selectedRound, setSelectedRound, severityByRound, sortKey, sortDir, sortRounds, showAll, setShowAll, exportHtml, exportPdf, exportCsv }) {
  const captured = Object.values(coverage).filter(c => c.available).length;
  const hasRounds = rounds.length > 0;
  return <>
    <section className="analysis-banner">
      <div className={`analysis-status ${findings.some(f => f.severity === 'critical') ? 'attention' : 'ok'}`}><span className="status-mark" aria-hidden="true">{findings.some(f => f.severity === 'critical') ? '!' : '✓'}</span><div><b>{run.source === SOURCE.DEMO ? 'Demo fixture analyzed' : 'Trace analyzed successfully'}</b><small>{summary.sampleCount.toLocaleString()} samples · {(run.metadata?.eventCount ?? 0).toLocaleString()} events · {run.tasks?.length?.toLocaleString() ?? 0} main-thread tasks · {findings.length} findings · {captured}/{Object.keys(coverage).length} metric areas captured</small></div></div>
      <div className="analysis-next"><small>Investigate first</small><b>{findings[0] ? findings[0].title : 'No findings from the available evidence'}</b>{findings[0] && <button className="text-button" onClick={() => go('bottlenecks')}>Open findings →</button>}</div>
    </section>
    <section className="kpi-grid">
      <Kpi title="Main-thread activity" term="mainThreadBlocking" value={summary.longTaskCount} sub={summary.busyAvg === undefined ? `${run.tasks?.length ?? 0} tasks observed · no busy windows derived · long-task threshold 50 ms` : `${run.tasks?.length ?? 0} tasks · busy avg ${summary.busyAvg}% · peak ${summary.busyPeak}% · long-task threshold 50 ms`} status={summary.longTaskCount || summary.busyPeak >= 85 ? 'warning' : 'good'} statusKey="mainThreadBusy" availability={coverageAvailability}/>
      <Kpi title="Frame timing" term="frameTime" value={summary.fpsAvg} unit=" FPS" sub={summary.frameP95 === undefined ? 'No supported frame timing events found' : `p95 ${summary.frameP95} ms · ${summary.frameCount} frame intervals · 60 FPS budget 16.7 ms`} status={summary.slowFrames > 0 ? 'warning' : 'good'} statusKey="frames" availability={coverageAvailability}/>
      <Kpi title="JavaScript heap" term="jsHeap" value={summary.heapMax === undefined ? undefined : (summary.heapMax / 1048576).toFixed(1)} unit=" MiB" sub={summary.heapDelta === undefined ? `${summary.heapSampleCount} samples · change not captured` : `${summary.heapSampleCount} samples · change ${(summary.heapDelta / 1048576).toFixed(1)} MiB · growth is not proof of a leak`} statusKey="memory" availability={coverageAvailability}/>
      <Kpi title="React / Redux activity" term="reactRender" value={summary.reactCommitP95 === undefined ? undefined : Number(summary.reactCommitP95.toFixed(1))} unit=" ms" sub={summary.reactCommitP95 === undefined ? 'Instrumentation not captured' : `React commit p95 · ${summary.reactSampleCount} samples`} status="neutral" statusKey="reactRedux" availability={coverageAvailability}/>
    </section>
    <div className="charts-grid">
      <MetricChart title="Main-thread busy time" term="mainThreadBlocking" samples={chartSamples.mainThreadBusyPercent || []} metric="mainThreadBusyPercent" color="#6b8cff" unit="%" note="Derived from main-thread task intervals, merged so nested work is counted once. This is not CPU utilization." onSelect={setSelectedPoint} findings={findings.filter(f => f.category === 'cpu')} onOpenFinding={openFindings}/>
      <MetricChart title="Frame rate" term="fps" samples={chartSamples.fps || []} metric="fps" color="#47d6b1" unit="FPS" onSelect={setSelectedPoint} findings={findings.filter(f => f.category === 'frames')} onOpenFinding={openFindings}/>
      <MetricChart title="JavaScript heap" term="jsHeap" samples={chartSamples.jsHeapUsedBytes || []} metric="jsHeapUsedBytes" color="#ad87ff" unit="bytes" onSelect={setSelectedPoint} findings={findings.filter(f => f.category === 'memory')} onOpenFinding={openFindings}/>
      {coverageAvailability?.reactRedux?.available
        ? <MetricChart title="React / Redux activity" term="reactRender" samples={chartSamples.reactCommitMs || []} metric="reactCommitMs" color="#f3b855" unit="ms" onSelect={setSelectedPoint} findings={findings.filter(f => f.category === 'react-redux')} onOpenFinding={openFindings}/>
        : <MetricChart title="CPU utilization" term="mainThreadBlocking" samples={chartSamples.cpuPercent || []} metric="cpuPercent" color="#6b8cff" unit="%" note="Chrome DevTools traces do not record CPU utilization. This chart stays empty unless the trace contains explicit utilization samples." onSelect={setSelectedPoint} findings={findings.filter(f => f.category === 'cpu')} onOpenFinding={openFindings}/>}
    </div>
    <section className="panel"><div className="panel-heading"><h3>Metric coverage</h3><p>What this trace actually contains. Missing metrics are not shown as zero.</p></div><Coverage run={run} availability={coverageAvailability}/></section>
    <TraceDiagnostics run={run}/>
    <div className="columns">
      <section className="panel"><div className="panel-heading"><div><h3>Top findings</h3><p>Ranked by severity, duration, recurrence, and evidence quality.</p></div><button className="text-button" onClick={() => go('bottlenecks')}>View all →</button></div><FindingsList findings={findings.slice(0, 4)} view={view}/></section>
      <section className="panel"><div className="panel-heading"><div><h3>Report outputs</h3><p>Exports share one normalized snapshot</p></div></div><div className="export-actions"><button className="button secondary" onClick={exportHtml}>↓ HTML report</button><button className="button secondary" onClick={exportPdf}>▣ Save as PDF</button><button className="button secondary" onClick={exportCsv}>⇩ CSV files</button></div><small className="subtle">PDF uses the browser print dialog with page numbers. CSV produces four files.</small></section>
    </div>
    {hasRounds && <RoundTable rounds={rounds.slice(0, 8)} severityByRound={severityByRound} sortKey={sortKey} sortDir={sortDir} sortRounds={sortRounds} select={setSelectedRound} view={view}/>}
    {!hasRounds && <section className="panel"><div className="panel-heading"><h3>Round analysis</h3></div><div className="inline-empty">No round markers were imported, so findings cannot be grouped by round. Trace-level analysis above remains valid. Import a marker sidecar on the Traces page to enable round correlation.</div></section>}
    <BottleneckTable findings={findings.slice(0, 5)} totalCount={findings.length} view={view}/>
  </>;
}

/** File input that always resets its value, so re-selecting the same file fires change again. */
function TraceFileInput({ onFile, className, accept = '.json,application/json', label, hidden = true, disabled = false }) {
  const input = useRef(null);
  const handle = event => { const file = event.target.files?.[0]; if (input.current) input.current.value = ''; if (file) onFile(file); };
  const control = <input ref={input} type="file" accept={accept} hidden={hidden} disabled={disabled} onChange={handle}/>;
  return label ? <label className={className}>{label}{control}</label> : control;
}

function ImportPanel({ state, onFile, onCancel, onRetry, onReset, isBusy }) {
  const [dragOver, setDragOver] = useState(false);
  const statusLabel = STAGE_LABEL[state.stage] || STAGE_LABEL[state.status] || 'Idle';
  return <div className="import-wrap">
    <label className={`drop-zone ${dragOver ? 'dragging' : ''} ${isBusy ? 'busy' : ''}`}
      onDragOver={e => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => { e.preventDefault(); setDragOver(false); const file = e.dataTransfer.files?.[0]; if (file) onFile(file); }}>
      <span className="upload-icon" aria-hidden="true">⇧</span>
      <b>{isBusy ? state.message || 'Processing…' : 'Choose trace JSON or drop it here'}</b>
      <small>Chrome DevTools Performance export · .json · no fixed size limit (bounded by browser memory)</small>
      <TraceFileInput onFile={onFile}/>
    </label>
    <div className="import-status" role="status" aria-live="polite">
      <div className="import-status-head">
        <span className={`stage-dot ${state.status}`} aria-hidden="true"/>
        <b>{statusLabel}</b>
        {state.fileName && <span className="file-chip" title={state.fileName}>{state.fileName}{state.fileSize !== undefined ? ` · ${formatBytes(state.fileSize)}` : ''}</span>}
        {state.elapsedMs !== undefined && isBusy && <span className="subtle">elapsed {formatDuration(state.elapsedMs)}</span>}
      </div>
      {state.message && <p className={`import-message ${state.status === 'error' ? 'error' : ''}`}>{state.message}</p>}
      {state.detail && isBusy && <small className="subtle">{state.detail}</small>}
      {isBusy && <>
        {Number.isFinite(state.percent) ? <div className="progress-measured" role="progressbar" aria-valuenow={state.percent} aria-valuemin="0" aria-valuemax="100"><span style={{ width: `${state.percent}%` }}/></div> : <div className="progress indeterminate" aria-hidden="true"><span/></div>}
        <small className="subtle">{Number.isFinite(state.percent) ? `${state.percent}% of file bytes read` : 'Progress cannot be measured reliably for this stage; no estimate is shown.'}</small>
        {Number.isFinite(state.eventCount) && <small className="subtle">{state.eventCount.toLocaleString()} events parsed so far.</small>}
      </>}
      <div className="import-actions">
        {isBusy && <button className="button secondary compact" onClick={onCancel}>Cancel import</button>}
        {state.canRetry && <button className="button secondary compact" onClick={onRetry}>Retry</button>}
        {(state.status === 'completed' || state.status === 'error' || state.status === 'cancelled') && <button className="text-button" onClick={onReset}>Clear status</button>}
      </div>
      {state.status === 'error' && <small className="subtle">The original file on disk was not modified. You can retry with the same file or a fresh export.</small>}
    </div>
  </div>;
}

function FindingsList({ findings, detailed = false, view = 'simple', all = false, onToggleAll }) {
  if (!findings.length) return <div className="inline-empty">No findings supported by the available evidence. This can mean the trace is healthy, or that the relevant metrics were not captured — check metric coverage.</div>;
  const limit = all ? findings.length : (detailed ? 25 : 8);
  const visible = findings.slice(0, limit);
  return <><div className="finding-list">{visible.map(f => <article key={f.id} className={`finding-row sev-${f.severity}`}>
    <div className="finding-icon" aria-hidden="true">{f.severity === 'critical' ? '!' : f.severity === 'warning' ? '△' : 'i'}</div>
    <div className="finding-copy">
      <div className="finding-title"><b>{f.title}</b><span className="finding-badges"><Severity value={f.severity}/><span className="priority-chip" title="Priority score from severity, duration, recurrence, and evidence quality">P{f.priority ?? '—'}</span></span></div>
      <p>{view === 'simple' ? (f.observed || f.description) : f.description}</p>
      {view === 'simple' && f.interpretation && <p className="finding-why"><b>Why it matters:</b> {f.interpretation}</p>}
      <div className="finding-meta">
        {f.category && <span>{f.category}</span>}
        {f.roundId !== undefined && <span>Round {f.roundId}</span>}
        {Number.isFinite(f.startMs) && <span>{timestampLabel(f.startMs)}{Number.isFinite(f.endMs) && f.endMs !== f.startMs ? ` – ${timestampLabel(f.endMs)}` : ''}</span>}
        {Number.isFinite(f.value) && <span>{f.value} {f.unit}</span>}
        {(f.recurrence ?? 1) > 1 && <span>{f.recurrence}×</span>}
        {f.evidence?.length > 0 && <span>{f.evidence.length} evidence ref(s)</span>}
      </div>
      {detailed && <>
        {f.rule && <p className="finding-rule">Rule: {f.rule}{f.threshold !== undefined ? ` · threshold ${f.threshold} ${f.unit || ''}` : ''} · priority {f.priority} ({priorityFactors(f)})</p>}
        {f.evidenceNote && <p className="finding-evidence"><b>Evidence quality:</b> {f.evidenceNote}</p>}
        {(f.investigation || []).length > 0 && <div className="finding-investigate"><b>Investigate</b><ol>{f.investigation.map((step, i) => <li key={i}>{step}</li>)}</ol></div>}
        {f.evidence?.length > 0 && <details className="finding-evidence-detail"><summary>Evidence ({f.evidence.length})</summary><ul>{f.evidence.slice(0, 10).map((e, i) => <li key={i}>{e.eventName || 'event'} · {e.traceFile} @ {e.startUs} μs · {Math.round((e.durationUs || 0) / 1000)} ms · thread {e.threadId ?? '—'} / process {e.processId ?? '—'}</li>)}</ul></details>}
      </>}
    </div>
  </article>)}</div>
  {findings.length > limit && <div className="finding-more">{onToggleAll ? <button className="text-button" onClick={() => onToggleAll(!all)}>{all ? 'Show fewer' : `Show all ${findings.length} findings`}</button> : <small className="subtle">Showing {limit} of {findings.length}. Full findings remain included in report exports.</small>}</div>}</>;
}
function priorityFactors(f) {
  const parts = [];
  parts.push(f.severity);
  if (Number.isFinite(f.value)) parts.push(`${f.value} ${f.unit || ''}`.trim());
  if ((f.recurrence ?? 1) > 1) parts.push(`${f.recurrence}×`);
  parts.push(`${f.evidenceQuality ?? 'partial'} evidence`);
  return parts.join(', ');
}

function RoundTable({ rounds, severityByRound, sortKey, sortDir, sortRounds, select, view = 'simple' }) {
  const columns = [['roundId','Round'],['startMs','Start'],['endMs','End'],['fpsAvg','Avg FPS'],['frameP95','Frame p95 ms'],['slowFrames','Slow frames'],['longTaskCount','Long tasks'],['heapDelta','Heap Δ MiB'],['findingCount','Findings']];
  const technicalColumns = [['roundId','Round'],['startMs','Start timestamp'],['endMs','End timestamp'],['cpuAvg','Avg CPU %'],['cpuPeak','Peak CPU %'],['fpsAvg','Avg FPS'],['frameP50','Frame p50 ms'],['frameP95','Frame p95 ms'],['frameP99','Frame p99 ms'],['slowFrames','Slow frames'],['heapBefore','Heap before MiB'],['heapAfter','Heap after MiB'],['heapDelta','Heap Δ MiB'],['longTaskCount','Long tasks'],['longTaskDurationMs','Long task duration ms'],['events','Game markers'],['findingCount','Findings']];
  const cols = view === 'technical' ? technicalColumns : columns;
  if (!rounds.length) return <section className="panel"><div className="panel-heading"><h3>Round analysis</h3></div><div className="inline-empty">No complete explicit round markers are available. Import marker data; rounds are not inferred from trace timing.</div></section>;
  return <section className="panel table-panel"><div className="panel-heading"><div><h3>Round-by-round performance</h3><p>Select a round to inspect available measurements.</p></div><span className="count-chip">{rounds.length} rounds</span></div><div className="table-wrap"><table><thead><tr>{cols.map(([key, label]) => <th key={key}><button className="sort-button" onClick={() => sortRounds(key)}>{label}{sortKey === key ? sortDir === 1 ? ' ↑' : ' ↓' : ''}</button></th>)}</tr></thead><tbody>{rounds.slice(0, 200).map(r => { const severity = severityByRound.get(r.roundId) || 'info'; return <tr key={r.roundId} className={select ? 'click-row' : ''} tabIndex={select ? 0 : undefined} aria-label={select ? `Inspect round ${r.roundId}` : undefined} onKeyDown={e => { if (select && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(r.roundId); } }} onClick={() => select?.(r.roundId)}>
      <td><b>#{r.roundId}</b>{r.incomplete && <small className="table-sub">incomplete</small>}</td>
      <td>{Number.isFinite(r.startMs) ? timestampLabel(r.startMs) : '—'}</td>
      <td>{Number.isFinite(r.endMs) ? timestampLabel(r.endMs) : 'Not captured'}</td>
      {view === 'technical' && <><td>{displayValue(r.cpuAvg)}</td><td>{displayValue(r.cpuPeak)}</td></>}
      <td>{displayValue(r.fpsAvg)}</td>
      {view === 'technical' && <td>{displayValue(r.frameP50)}</td>}
      <td>{displayValue(r.frameP95)}</td>
      {view === 'technical' && <td>{displayValue(r.frameP99)}</td>}
      <td>{displayValue(r.slowFrames, 0)}</td>
      {view === 'technical' && <><td>{r.heapBefore === undefined ? 'Not captured' : (r.heapBefore / 1048576).toFixed(1)}</td><td>{r.heapAfter === undefined ? 'Not captured' : (r.heapAfter / 1048576).toFixed(1)}</td></>}
      <td>{r.heapDelta === undefined ? 'Not captured' : (r.heapDelta / 1048576).toFixed(1)}</td>
      <td>{displayValue(r.longTaskCount, 0)}</td>
      {view === 'technical' && <><td>{displayValue(r.longTaskDurationMs)}</td><td>{r.events?.filter(event => event.type.startsWith('bonus') || event.type.startsWith('winAnimation')).map(event => event.type).join(', ') || '—'}</td></>}
      <td>{r.findingCount} · <Severity value={severity}/></td></tr>; })}</tbody></table></div>{rounds.length > 200 && <small className="subtle">Showing first 200 of {rounds.length} rounds.</small>}</section>;
}

function BottleneckTable({ findings, totalCount = findings.length, view = 'simple' }) {
  return <section className="panel table-panel"><div className="panel-heading"><div><h3>Prioritized findings table</h3><p>Transparent priority = severity + duration + recurrence + evidence quality.</p></div></div>{findings.length ? <><div className="table-wrap"><table><thead><tr><th>Finding</th><th>Category</th><th>Severity</th><th>Priority</th><th>Round</th><th>Observed value</th>{view === 'technical' && <th>Rule</th>}</tr></thead><tbody>{findings.slice(0, 100).map(f => <tr key={f.id}><td><b>{f.title}</b><small className="table-sub">{f.observed || f.description}</small></td><td>{f.category}</td><td><Severity value={f.severity}/></td><td>{f.priority ?? '—'}</td><td>{f.roundId ?? '—'}</td><td>{Number.isFinite(f.value) ? `${f.value} ${f.unit || ''}` : 'Not captured'}</td>{view === 'technical' && <td><small className="table-sub">{f.rule || '—'}</small></td>}</tr>)}</tbody></table></div>{totalCount > findings.length && <small className="subtle">Showing {findings.length} prioritized findings of {totalCount}; full findings are retained in reports.</small>}</> : <div className="inline-empty">No findings available.</div>}</section>;
}

function MetaList({ run }) {
  const items = [
    ['Run ID', run.id], ['Game', run.game], ['Build', run.buildId], ['Environment', run.environment],
    [run.source === SOURCE.TRACE ? 'Imported at' : 'Started', new Date(run.startedAt).toLocaleString()], ['Source', run.source],
    ['Samples', run.samples.length.toLocaleString()], ['Events', (run.metadata?.eventCount ?? run.events.length).toLocaleString()],
    ['Normalized events', (run.metadata?.normalizedEventCount ?? '—').toLocaleString?.() ?? '—'],
    ['Trace duration', Number.isFinite(run.metadata?.traceDurationMs) ? `${(run.metadata.traceDurationMs / 1000).toFixed(1)} s` : '—'],
    ['Source format', run.metadata?.sourceFormat ?? '—'],
    ['File size', run.metadata?.fileSize ? formatBytes(run.metadata.fileSize) : '—'],
    ['Skipped malformed timestamps', run.metadata?.diagnostics?.malformedTimestampCount ?? '—'],
    ['Duplicate events discarded', run.metadata?.diagnostics?.duplicateEventCount ?? '—'],
    ['Unmatched duration markers', run.metadata?.diagnostics ? run.metadata.diagnostics.unmatchedEndCount + run.metadata.diagnostics.incompleteBeginCount : '—'],
    ['Threads', run.metadata?.threadInfo?.length ?? '—']
  ];
  return <div className="meta-list">{items.map(([k, v]) => <div key={k}><span>{k}</span><b>{v}</b></div>)}{run.metadata?.threadInfo?.length > 0 && <details><summary>Process / thread information</summary><ul>{run.metadata.threadInfo.slice(0, 30).map((line, i) => <li key={i}>{line}</li>)}</ul></details>}{run.metadata?.limitations?.map((item, i) => <p className="limitation" key={i}>ⓘ {item}</p>)}</div>;
}

function Coverage({ run, availability }) {
  const metrics = availability || run.metadata?.availability || metricAvailability(run);
  return <div className="coverage-grid">{Object.entries(metrics).filter(([key]) => !key.startsWith('__')).map(([name, info]) => <div key={name} className={`coverage-item status-${info.status}`}><span className={info.available ? 'cover-dot yes' : 'cover-dot'}/><div><b>{name}</b><span className={`metric-status status-${info.status}`}>{info.label || METRIC_STATUS_LABEL[info.status]}</span><small>{info.reason || info.note}</small>{!info.available && info.howToCapture && <small className="coverage-hint">To capture: {info.howToCapture}</small>}</div></div>)}</div>;
}

/** Event counts, categories, phases, and process/thread coverage for the imported trace. */
function TraceDiagnostics({ run }) {
  const diagnostics = run.metadata?.diagnostics;
  const availability = run.metadata?.availability || metricAvailability(run);
  const unavailable = Object.entries(availability).filter(([key, info]) => !key.startsWith('__') && !info.available).map(([key, info]) => ({ key, ...info }));
  if (!diagnostics) return null;
  return <section className="panel diagnostics-panel"><div className="panel-heading"><div><h3>Trace diagnostics</h3><p>What was actually in the file, and which metrics could be recovered from it.</p></div></div>
    <div className="diagnostics-grid">
      <div className="diag-item"><small>Events in file</small><b>{(run.metadata?.eventCount ?? 0).toLocaleString()}</b></div>
      <div className="diag-item"><small>Normalized events</small><b>{(run.metadata?.normalizedEventCount ?? 0).toLocaleString()}</b></div>
      <div className="diag-item"><small>Processes</small><b>{(run.metadata?.processCount ?? 0).toLocaleString()}</b></div>
      <div className="diag-item"><small>Threads named</small><b>{(run.metadata?.threadInfo?.length ?? 0).toLocaleString()}</b></div>
      <div className="diag-item"><small>Main thread identified</small><b>{run.metadata?.mainThreadDetected ? 'Yes' : 'No'}</b></div>
      <div className="diag-item"><small>Trace duration</small><b>{Number.isFinite(run.metadata?.traceDurationMs) ? `${(run.metadata.traceDurationMs / 1000).toFixed(1)} s` : 'Not captured'}</b></div>
    </div>
    {diagnostics.phases?.length > 0 && <div className="diag-block"><b>Event phases</b><div className="chip-row">{diagnostics.phases.map(phase => <span className="diag-chip" key={phase.name}>{phase.name} · {phase.count.toLocaleString()}</span>)}</div></div>}
    {diagnostics.categories?.length > 0 && <div className="diag-block"><b>Top event categories</b><div className="chip-row">{diagnostics.categories.slice(0, 12).map(category => <span className="diag-chip" key={category.name}>{category.name} · {category.count.toLocaleString()}</span>)}</div></div>}
    <div className="diag-block"><b>Metrics that could not be recovered</b>{unavailable.length ? <ul className="diag-list">{unavailable.map(info => <li key={info.key}><b>{info.key}</b> — {info.reason} {info.howToCapture && <span className="subtle">Next time: {info.howToCapture}</span>}</li>)}</ul> : <p className="inline-empty">Every supported metric was recovered from this trace.</p>}</div>
  </section>;
}

function TaskTable({ tasks }) { return tasks.length ? <div className="table-wrap"><table><thead><tr><th>Time (relative)</th><th>Duration</th><th>Event</th><th>Round</th><th>Thread evidence</th></tr></thead><tbody>{tasks.slice(0, 150).map((t, i) => <tr key={`${t.timestampMs}-${i}`}><td>{timestampLabel(t.timestampMs)}</td><td><Severity value={t.durationMs >= 100 ? 'critical' : 'warning'}/>&nbsp;{t.durationMs.toFixed(1)} ms</td><td>{t.eventName}</td><td>{t.roundId ?? '—'}</td><td>{t.evidence?.threadId ?? '—'} / {t.evidence?.processId ?? '—'}</td></tr>)}</tbody></table>{tasks.length > 150 && <small className="subtle">Showing first 150 of {tasks.length} tasks.</small>}</div> : <div className="inline-empty">No supported main-thread tasks found. Thread metadata may be absent.</div>; }
