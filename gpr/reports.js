import { buildReportSnapshot, priorityReason } from './analyze.js';
import { THRESHOLDS } from './model.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const csvCell = value => {
  if (value === undefined || value === null || value === '') return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
export function toCsv(rows, columns) {
  return [columns.map(c => csvCell(c.label)).join(','), ...rows.map(row => columns.map(c => csvCell(typeof c.value === 'function' ? c.value(row) : row[c.value])).join(','))].join('\r\n');
}
function dateFile(run, type) {
  const game = (run.game || 'game').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const id = (run.buildId && run.buildId !== 'unknown-build' ? run.buildId : run.id).replace(/[^a-zA-Z0-9_-]/g, '-');
  return `${game}-${id}-${type}`;
}
const fmt = (value, unit = '') => (value === undefined || value === null || value === '' ? 'Not captured' : `${esc(value)}${unit}`);

function inlineChart(samples, key, label, color, unit) {
  const allValues = samples.filter(s => Number.isFinite(s[key]));
  if (!allValues.length) return `<div class="mini-chart"><b>${esc(label)}</b><p>Not captured</p></div>`;
  const stride = Math.max(1, Math.ceil(allValues.length / 1000));
  const values = stride > 1 ? allValues.filter((_, index) => index % stride === 0 || index === allValues.length - 1) : allValues;
  const w = 560, h = 100, pad = 8, minX = values[0].timestampMs, maxX = values[values.length - 1].timestampMs, ys = values.map(s => s[key]), minY = ys.reduce((a, b) => Math.min(a, b), Infinity), maxY = ys.reduce((a, b) => Math.max(a, b), -Infinity), span = maxY - minY || 1;
  const points = values.map(s => `${pad + (s.timestampMs - minX) / (maxX - minX || 1) * (w - pad * 2)},${h - pad - (s[key] - minY) / span * (h - pad * 2)}`).join(' ');
  return `<div class="mini-chart"><b>${esc(label)}</b><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)} trend" preserveAspectRatio="none"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="2"/></svg><small>${esc(minY.toFixed(1))}–${esc(maxY.toFixed(1))} ${esc(unit)} · ${values.length} of ${allValues.length} samples</small></div>`;
}

export function reportHtml(snapshot) {
  const { run, summary, findings, rounds, coverage } = snapshot;
  const demo = run.source === 'demo-fixture';
  const metric = (label, value, unit = '') => `<article><small>${esc(label)}</small><strong>${fmt(value, unit)}</strong></article>`;
  const rows = rounds.map(r => `<tr data-finding-count="${r.findingCount}"><td>${r.roundId}</td><td>${Number.isFinite(r.startMs) ? `+${r.startMs.toFixed(0)} ms` : '—'}</td><td>${fmt(r.cpuAvg)}</td><td>${fmt(r.fpsAvg)}</td><td>${fmt(r.frameP95)}</td><td>${r.heapDelta === undefined ? 'Not captured' : `${(r.heapDelta / 1048576).toFixed(1)} MiB`}</td><td>${r.findingCount}</td></tr>`).join('');
  const findingRows = findings.map(f => `<li class="finding sev-${esc(f.severity)}">
    <div class="finding-head"><b>${esc(f.severity.toUpperCase())} · ${esc(f.title)}</b><span class="prio">priority ${f.priority ?? '—'}</span></div>
    <p>${esc(f.observed || f.description)}</p>
    ${f.interpretation ? `<p><b>Why it matters:</b> ${esc(f.interpretation)}</p>` : ''}
    ${f.rule ? `<p class="muted">Rule: ${esc(f.rule)}${f.threshold !== undefined ? ` · threshold ${esc(f.threshold)} ${esc(f.unit || '')}` : ''} · evidence: ${esc(f.evidenceQuality || 'n/a')}</p>` : ''}
    ${f.evidenceNote ? `<p class="muted">Evidence quality: ${esc(f.evidenceNote)}</p>` : ''}
    ${(f.investigation || []).length ? `<p><b>Investigate:</b> ${esc(f.investigation.join(' '))}</p>` : ''}
    <p class="muted">Priority factors: ${esc(priorityReason(f))}${f.roundId ? ` · Round ${esc(f.roundId)}` : ''}${Number.isFinite(f.startMs) ? ` · +${f.startMs.toFixed(0)} ms` : ''}</p>
  </li>`).join('');
      const coverageRows = Object.entries(coverage).map(([name, value]) => `<li><b>${esc(name)}:</b> ${value.available ? 'Available' : 'Not captured'} — ${esc(value.note)}</li>`).join('');
    const diagnostics = run.metadata?.diagnostics;
    const diagnosticsRows = diagnostics ? `<ul class="defs"><li><b>Events in file:</b> ${esc(run.metadata.eventCount ?? 0)}</li><li><b>Normalized events:</b> ${esc(run.metadata.normalizedEventCount ?? 0)}</li><li><b>Processes:</b> ${esc(run.metadata.processCount ?? 0)} · <b>Threads named:</b> ${esc(run.metadata.threadInfo?.length ?? 0)}</li><li><b>Main thread identified:</b> ${run.metadata.mainThreadDetected ? 'Yes' : 'No'}</li><li><b>Event phases:</b> ${esc((diagnostics.phases || []).map(p => `${p.name} (${p.count})`).join(', ') || 'Not available')}</li><li><b>Top categories:</b> ${esc((diagnostics.categories || []).slice(0, 8).map(c => `${c.name} (${c.count})`).join(', ') || 'Not available')}</li></ul>` : '';
      const metricDefs = `<ul class="defs"><li><b>Long task:</b> a main-thread task longer than ${THRESHOLDS.longTaskMs} ms; it blocks rendering and input.</li><li><b>Main-thread busy time:</b> the share of a one-second window the main thread spent inside trace tasks, with overlapping work counted once. It is derived from task intervals and is not CPU utilization.</li><li><b>Frame time:</b> the gap between two rendered frames; the 60 FPS budget is ${THRESHOLDS.frameBudgetMs.toFixed(1)} ms.</li><li><b>p95 frame time:</b> the frame time that 95% of frames were faster than.</li><li><b>JavaScript heap:</b> memory allocated to JavaScript objects; growth is not proof of a leak.</li><li><b>Correlation vs causation:</b> overlapping events are a lead, not a proven cause.</li></ul>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(run.game)} performance report</title><style>
  *{box-sizing:border-box}body{font:14px/1.55 Arial,sans-serif;background:#0b1220;color:#e7edf7;margin:0;padding:32px}main{max-width:1120px;margin:auto}h1,h2{color:#fff}small,.muted{color:#a6b4c8}.badge{background:#7c4d16;color:#ffe0a3;padding:8px 12px;border-radius:5px;font-weight:bold;display:inline-block}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:20px 0}article,section{background:#111c2e;border:1px solid #263650;border-radius:8px;padding:16px}article strong{display:block;font-size:22px;margin-top:8px}table{width:100%;border-collapse:collapse;table-layout:fixed}td,th{text-align:left;padding:9px;border-bottom:1px solid #293950;overflow-wrap:anywhere;font-size:12px}th{color:#aebdd0}.report-charts{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.mini-chart{background:#0d1727;border:1px solid #263650;border-radius:6px;padding:12px}.mini-chart b,.mini-chart small{display:block}.mini-chart svg{width:100%;height:100px;margin:8px 0}.mini-chart small,.mini-chart p{color:#9eacc0;font-size:11px}ul{list-style:none;padding:0;margin:0}li.finding{border-left:3px solid #3d5680;padding:10px 12px;margin:10px 0;background:#0d1727;border-radius:5px}li.sev-critical{border-left-color:#ff7184}li.sev-warning{border-left-color:#f1b653}.finding-head{display:flex;justify-content:space-between;gap:10px;align-items:baseline}.prio{font-size:11px;color:#9fb0c8}.defs li{padding:4px 0}.page-meta{display:flex;justify-content:space-between;font-size:11px;color:#93a3ba;border-top:1px solid #263650;margin-top:18px;padding-top:8px}@page{size:A4;margin:14mm}@media print{body{background:#fff;color:#172033;padding:0}h1,h2{color:#111}article,section{background:#fff;color:#111;border-color:#bbb;break-inside:avoid}.badge{border:1px solid #a66;color:#542}table{font-size:10px}li.finding{background:#f6f8fb}small,.muted{color:#4a5566}.report-page{page-break-after:always}.report-page:last-child{page-break-after:auto}}</style></head><body><main>
  <div class="report-page">
    ${demo ? '<p class="badge">DEMO DATA — NOT MEASURED</p>' : ''}
    <h1>${esc(run.game)} · Performance report</h1>
    <p class="muted">Run ${esc(run.id)} · Build ${esc(run.buildId)} · ${esc(run.environment)} · ${run.source === 'chrome-trace' ? 'Imported' : 'Started'} ${esc(run.startedAt)} · Source ${esc(run.source)} · Report schema v${esc(snapshot.schemaVersion)}</p>
    <p>Generated ${esc(snapshot.generatedAt)} · ${run.samples.length} normalized samples · ${run.tasks?.length ?? 0} main-thread tasks · ${findings.length} findings</p>
          <section><h2>Executive summary</h2><div class="grid">${metric('Average frame rate', summary.fpsAvg, summary.fpsAvg === undefined ? '' : ' FPS')}${metric('Frame-time p95', summary.frameP95, summary.frameP95 === undefined ? '' : ' ms')}${metric('Long tasks (≥' + THRESHOLDS.longTaskMs + ' ms)', summary.longTaskCount)}${metric('Main-thread busy (avg)', summary.busyAvg, summary.busyAvg === undefined ? '' : '%')}${metric('Heap change', summary.heapDelta === undefined ? undefined : (summary.heapDelta / 1048576).toFixed(1), summary.heapDelta === undefined ? '' : ' MiB')}</div>
    <p class="muted">${summary.sampleCount ? `${summary.sampleCount} samples cover ${Number.isFinite(summary.coverageDurationMs) ? (summary.coverageDurationMs / 1000).toFixed(1) + ' s' : 'the analyzed range'}.` : 'No samples were captured in this run.'} Metrics that were not present in the trace are shown as Not captured rather than zero.</p></section>
    <section><h2>Observed metric trends</h2><div class="report-charts">${inlineChart(run.samples, 'mainThreadBusyPercent', 'Main-thread busy time', '#6b8cff', '%')}${inlineChart(run.samples, 'cpuPercent', 'CPU utilization', '#6b8cff', '%')}${inlineChart(run.samples, 'fps', 'Frame rate', '#47d6b1', 'FPS')}${inlineChart(run.samples, 'jsHeapUsedBytes', 'JavaScript heap', '#ad87ff', 'bytes')}${inlineChart(run.samples, 'reactCommitMs', 'React commit duration', '#f3b855', 'ms')}</div><h3>Metric definitions</h3>${metricDefs}</section>
    <div class="page-meta"><span>${esc(run.game)} · ${esc(run.buildId)}</span><span>Page 1</span></div>
  </div>
  <div class="report-page">
    <section><h2>Findings, highest priority first</h2><ul>${findingRows || '<li>No findings were generated from the available evidence.</li>'}</ul></section>
    <section><h2>Coverage and limitations</h2><ul>${coverageRows}</ul>${(run.metadata?.limitations || []).map(x => `<p class="muted">${esc(x)}</p>`).join('')}</section>
    <div class="page-meta"><span>${esc(run.game)} · ${esc(run.buildId)}</span><span>Page 2</span></div>
  </div>
  <div class="report-page">
    <section><h2>Round analysis</h2><label class="report-filter">Show rounds <select id="round-filter"><option value="all">All rounds</option><option value="findings">Rounds with findings</option></select></label><table><thead><tr><th>Round</th><th>Start</th><th>Avg CPU %</th><th>Avg FPS</th><th>Frame p95 ms</th><th>Heap delta</th><th>Findings</th></tr></thead><tbody>${rows || '<tr><td colspan="7">Round markers not available.</td></tr>'}</tbody></table></section>
          <section><h2>Technical evidence and provenance</h2><p class="muted">Evidence references retain the original trace file, microsecond offset, duration, and process/thread ids where available. Normalized timestamps are milliseconds relative to the first valid trace timestamp.</p>
      <h3>Trace diagnostics</h3>${diagnosticsRows || '<p class="muted">No trace diagnostics were recorded.</p>'}
    <p>Every measurement retains its source. Missing metrics are shown as Not captured. Task duration does not establish CPU utilization. Heap growth is not proof of a memory leak, and temporal correlation does not establish causation.</p>${demo ? '<p><b>DEMO DATA — NOT MEASURED</b></p>' : ''}</section>
    <div class="page-meta"><span>${esc(run.game)} · ${esc(run.buildId)}</span><span>Page 3</span></div>
  </div>
  </main><script>document.getElementById('round-filter')?.addEventListener('change',event=>{document.querySelectorAll('tbody tr[data-finding-count]').forEach(row=>{row.hidden=event.target.value==='findings'&&Number(row.dataset.findingCount)===0})})</script></body></html>`;
}

export function reportCsvFiles(snapshot) {
  const { run, rounds, findings } = snapshot;
  const common = { runId: run.id, source: run.source, dataLabel: run.source === 'demo-fixture' ? 'DEMO DATA — NOT MEASURED' : '', buildId: run.buildId, runStartedAt: run.startedAt, reportGeneratedAt: snapshot.generatedAt, schemaVersion: snapshot.schemaVersion };
  return {
    rounds: toCsv(rounds.map(r => ({ ...common, ...r })), [
      { label: 'run_id', value: 'runId' }, { label: 'source', value: 'source' }, { label: 'data_label', value: 'dataLabel' }, { label: 'build_id', value: 'buildId' }, { label: 'run_reference_timestamp', value: 'runStartedAt' }, { label: 'report_generated_at', value: 'reportGeneratedAt' }, { label: 'schema_version', value: 'schemaVersion' }, { label: 'round_id', value: 'roundId' }, { label: 'start_timestamp_ms', value: 'startMs' }, { label: 'end_timestamp_ms', value: 'endMs' }, { label: 'duration_ms', value: 'durationMs' }, { label: 'avg_cpu_percent', value: 'cpuAvg' }, { label: 'peak_cpu_percent', value: 'cpuPeak' }, { label: 'avg_fps', value: 'fpsAvg' }, { label: 'frame_count', value: 'frameCount' }, { label: 'frame_time_p50_ms', value: 'frameP50' }, { label: 'frame_time_p95_ms', value: 'frameP95' }, { label: 'frame_time_p99_ms', value: 'frameP99' }, { label: 'slow_frames_count', value: 'slowFrames' }, { label: 'heap_before_bytes', value: 'heapBefore' }, { label: 'heap_after_bytes', value: 'heapAfter' }, { label: 'heap_delta_bytes', value: 'heapDelta' }, { label: 'long_task_count', value: 'longTaskCount' }, { label: 'long_task_duration_ms', value: 'longTaskDurationMs' }, { label: 'incomplete', value: 'incomplete' }, { label: 'finding_count', value: 'findingCount' }
    ]),
    samples: toCsv(run.samples.map(s => ({ ...common, ...s })), [
      { label: 'run_id', value: 'runId' }, { label: 'data_label', value: 'dataLabel' }, { label: 'build_id', value: 'buildId' }, { label: 'run_reference_timestamp', value: 'runStartedAt' }, { label: 'report_generated_at', value: 'reportGeneratedAt' }, { label: 'schema_version', value: 'schemaVersion' }, { label: 'timestamp_ms', value: 'timestampMs' }, { label: 'round_id', value: 'roundId' }, { label: 'main_thread_busy_percent', value: 'mainThreadBusyPercent' }, { label: 'cpu_percent', value: 'cpuPercent' }, { label: 'fps', value: 'fps' }, { label: 'frame_duration_ms', value: 'frameDurationMs' }, { label: 'js_heap_used_bytes', value: 'jsHeapUsedBytes' }, { label: 'react_commit_ms', value: 'reactCommitMs' }, { label: 'dispatch_duration_ms', value: 'dispatchDurationMs' }, { label: 'source', value: 'source' }
    ]),
    findings: toCsv(findings.map(f => ({ ...common, ...f, evidence: (f.evidence || []).map(e => `${e.traceFile}:${e.startUs}+${e.durationUs}us`).join('; '), investigation: (f.investigation || []).join(' ') })), [
      { label: 'run_id', value: 'runId' }, { label: 'data_label', value: 'dataLabel' }, { label: 'build_id', value: 'buildId' }, { label: 'run_reference_timestamp', value: 'runStartedAt' }, { label: 'report_generated_at', value: 'reportGeneratedAt' }, { label: 'schema_version', value: 'schemaVersion' }, { label: 'source', value: 'source' }, { label: 'finding_id', value: 'id' }, { label: 'category', value: 'category' }, { label: 'severity', value: 'severity' }, { label: 'priority', value: 'priority' }, { label: 'title', value: 'title' }, { label: 'observed', value: 'observed' }, { label: 'interpretation', value: 'interpretation' }, { label: 'description', value: 'description' }, { label: 'rule', value: 'rule' }, { label: 'threshold', value: 'threshold' }, { label: 'round_id', value: 'roundId' }, { label: 'start_ms', value: 'startMs' }, { label: 'end_ms', value: 'endMs' }, { label: 'value', value: 'value' }, { label: 'unit', value: 'unit' }, { label: 'recurrence', value: 'recurrence' }, { label: 'evidence_quality', value: 'evidenceQuality' }, { label: 'investigation', value: 'investigation' }, { label: 'evidence', value: 'evidence' }
    ]),
    events: toCsv(run.events.map(e => ({ ...common, ...e })), [
      { label: 'run_id', value: 'runId' }, { label: 'source', value: 'source' }, { label: 'data_label', value: 'dataLabel' }, { label: 'build_id', value: 'buildId' }, { label: 'run_reference_timestamp', value: 'runStartedAt' }, { label: 'report_generated_at', value: 'reportGeneratedAt' }, { label: 'schema_version', value: 'schemaVersion' }, { label: 'timestamp_ms', value: 'timestampMs' }, { label: 'round_id', value: 'roundId' }, { label: 'event_type', value: 'type' }, { label: 'name', value: 'name' }
    ])
  };
}
export function createSnapshot(run) {
  if (!run.analysis) return buildReportSnapshot(run);
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    run: { ...run, findings: run.analysis.findings },
    summary: run.analysis.summary,
    rounds: run.analysis.rounds,
    findings: run.analysis.findings,
    coverage: run.analysis.summary.coverage
  };
}
export function reportFileBase(run) { return dateFile(run, 'report'); }
