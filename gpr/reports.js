import { buildReportSnapshot } from './analyze.js';

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
function inlineChart(samples, key, label, color, unit) {
  const allValues = samples.filter(s => Number.isFinite(s[key]));
  if (!allValues.length) return `<div class="mini-chart"><b>${esc(label)}</b><p>Not captured</p></div>`;
  const stride = Math.max(1, Math.ceil(allValues.length / 1000));
  const values = stride > 1 ? allValues.filter((_, index) => index % stride === 0 || index === allValues.length - 1) : allValues;
  const w = 560, h = 100, pad = 8, minX = values[0].timestampMs, maxX = values.at(-1).timestampMs, ys = values.map(s => s[key]), minY = ys.reduce((a, b) => Math.min(a, b), Infinity), maxY = ys.reduce((a, b) => Math.max(a, b), -Infinity), span = maxY - minY || 1;
  const points = values.map(s => `${pad + (s.timestampMs - minX) / (maxX - minX || 1) * (w - pad * 2)},${h - pad - (s[key] - minY) / span * (h - pad * 2)}`).join(' ');
  return `<div class="mini-chart"><b>${esc(label)}</b><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)} trend"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="2"/></svg><small>${esc(minY.toFixed(1))}–${esc(maxY.toFixed(1))} ${esc(unit)}</small></div>`;
}

export function reportHtml(snapshot) {
  const { run, summary, findings, rounds, coverage } = snapshot;
  const demo = run.source === 'demo-fixture';
  const metric = (label, value, unit = '') => `<article><small>${esc(label)}</small><strong>${value === undefined ? 'Not captured' : `${esc(value)}${unit}`}</strong></article>`;
  const rows = rounds.map(r => `<tr data-finding-count="${r.findingCount}"><td>${r.roundId}</td><td>${Number.isFinite(r.startMs) ? `+${r.startMs.toFixed(0)} ms` : '—'}</td><td>${r.cpuAvg ?? 'Not captured'}</td><td>${r.fpsAvg ?? 'Not captured'}</td><td>${r.frameP95 ?? 'Not captured'}</td><td>${r.heapDelta === undefined ? 'Not captured' : `${(r.heapDelta / 1048576).toFixed(1)} MiB`}</td><td>${r.findingCount}</td></tr>`).join('');
  const findingRows = findings.map(f => `<li><b>${esc(f.severity.toUpperCase())} · ${esc(f.title)}</b> — ${esc(f.description)}${f.roundId ? ` (Round ${f.roundId})` : ''}</li>`).join('');
  const coverageRows = Object.entries(coverage).map(([name, value]) => `<li><b>${esc(name)}:</b> ${value.available ? 'Available' : 'Not captured'} — ${esc(value.note)}</li>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(run.game)} performance report</title><style>
  *{box-sizing:border-box}body{font:14px/1.55 Arial,sans-serif;background:#0b1220;color:#e7edf7;margin:0;padding:32px}main{max-width:1120px;margin:auto}h1,h2{color:#fff}small,.muted{color:#a6b4c8}.badge{background:#7c4d16;color:#ffe0a3;padding:8px 12px;border-radius:5px;font-weight:bold}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:20px 0}article,section{background:#111c2e;border:1px solid #263650;border-radius:8px;padding:16px}article strong{display:block;font-size:22px;margin-top:8px}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:9px;border-bottom:1px solid #293950}th{color:#aebdd0}.report-charts{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.mini-chart{background:#0d1727;border:1px solid #263650;border-radius:6px;padding:12px}.mini-chart b,.mini-chart small{display:block}.mini-chart svg{width:100%;height:100px;margin:8px 0}.mini-chart small,.mini-chart p{color:#9eacc0;font-size:11px}@media print{body{background:#fff;color:#172033;padding:12mm}h1,h2{color:#111}article,section{background:#fff;color:#111;border-color:#bbb;break-inside:avoid}.badge{border:1px solid #a66;color:#542}table{font-size:10px}section{margin-top:12px}}</style></head><body><main>${demo ? '<p class="badge">DEMO DATA — NOT MEASURED</p>' : ''}<h1>${esc(run.game)} · Performance report</h1><p class="muted">Run ${esc(run.id)} · Build ${esc(run.buildId)} · ${esc(run.environment)} · ${run.source === 'chrome-trace' ? 'Imported' : 'Started'} ${esc(run.startedAt)} · Source ${esc(run.source)}</p><p>Generated ${esc(snapshot.generatedAt)} · ${run.samples.length} normalized samples · ${findings.length} findings</p><section><h2>Executive summary</h2><div class="grid">${metric('Average CPU', summary.cpuAvg, summary.cpuAvg === undefined ? '' : '%')}${metric('Average frame rate', summary.fpsAvg, summary.fpsAvg === undefined ? '' : ' FPS')}${metric('Frame-time p95', summary.frameP95, summary.frameP95 === undefined ? '' : ' ms')}${metric('Heap change', summary.heapDelta, summary.heapDelta === undefined ? '' : ' bytes')}</div></section><section><h2>Observed metric trends</h2><div class="report-charts">${inlineChart(run.samples, 'cpuPercent', 'CPU utilization', '#6b8cff', '%')}${inlineChart(run.samples, 'fps', 'Frame rate', '#47d6b1', 'FPS')}${inlineChart(run.samples, 'jsHeapUsedBytes', 'JavaScript heap', '#ad87ff', 'bytes')}${inlineChart(run.samples, 'reactCommitMs', 'React commit duration', '#f3b855', 'ms')}</div></section><section><h2>Coverage and limitations</h2><ul>${coverageRows}</ul>${(run.metadata?.limitations || []).map(x => `<p class="muted">${esc(x)}</p>`).join('')}</section><section><h2>Round analysis</h2><label class="report-filter">Show rounds <select id="round-filter"><option value="all">All rounds</option><option value="findings">Rounds with findings</option></select></label><table><thead><tr><th>Round</th><th>Start time (relative)</th><th>Avg CPU %</th><th>Avg FPS</th><th>Frame p95 ms</th><th>Heap delta</th><th>Findings</th></tr></thead><tbody>${rows || '<tr><td colspan="7">Round markers not available.</td></tr>'}</tbody></table></section><section><h2>Key findings</h2><ul>${findingRows || '<li>No findings generated from available evidence.</li>'}</ul></section><section><h2>Data provenance</h2><p>Every measurement retains its source. Missing metrics are shown as Not captured. Task duration does not establish CPU utilization. Heap growth is not proof of a memory leak, and temporal correlation does not establish causation.</p>${demo ? '<p><b>DEMO DATA — NOT MEASURED</b></p>' : ''}</section></main><script>document.getElementById('round-filter')?.addEventListener('change',event=>{document.querySelectorAll('tbody tr[data-finding-count]').forEach(row=>{row.hidden=event.target.value==='findings'&&Number(row.dataset.findingCount)===0})})</script></body></html>`;
}
export function reportCsvFiles(snapshot) {
  const { run, rounds, findings } = snapshot;
  const common = { runId: run.id, source: run.source, dataLabel: run.source === 'demo-fixture' ? 'DEMO DATA — NOT MEASURED' : '', buildId: run.buildId, runStartedAt: run.startedAt, reportGeneratedAt: snapshot.generatedAt, schemaVersion: snapshot.schemaVersion };
  return {
    rounds: toCsv(rounds.map(r => ({ ...common, ...r })), [
      { label: 'run_id', value: 'runId' }, { label: 'source', value: 'source' }, { label: 'data_label', value: 'dataLabel' }, { label: 'build_id', value: 'buildId' }, { label: 'run_reference_timestamp', value: 'runStartedAt' }, { label: 'report_generated_at', value: 'reportGeneratedAt' }, { label: 'schema_version', value: 'schemaVersion' }, { label: 'round_id', value: 'roundId' }, { label: 'start_timestamp_ms', value: 'startMs' }, { label: 'end_timestamp_ms', value: 'endMs' }, { label: 'duration_ms', value: 'durationMs' }, { label: 'avg_cpu_percent', value: 'cpuAvg' }, { label: 'peak_cpu_percent', value: 'cpuPeak' }, { label: 'avg_fps', value: 'fpsAvg' }, { label: 'frame_count', value: 'frameCount' }, { label: 'frame_time_p50_ms', value: 'frameP50' }, { label: 'frame_time_p95_ms', value: 'frameP95' }, { label: 'frame_time_p99_ms', value: 'frameP99' }, { label: 'slow_frames_count', value: 'slowFrames' }, { label: 'heap_before_bytes', value: 'heapBefore' }, { label: 'heap_after_bytes', value: 'heapAfter' }, { label: 'heap_delta_bytes', value: 'heapDelta' }, { label: 'long_task_count', value: 'longTaskCount' }, { label: 'long_task_duration_ms', value: 'longTaskDurationMs' }, { label: 'finding_count', value: 'findingCount' }
    ]),
    samples: toCsv(run.samples.map(s => ({ ...common, ...s })), [
      { label: 'run_id', value: 'runId' }, { label: 'data_label', value: 'dataLabel' }, { label: 'build_id', value: 'buildId' }, { label: 'run_reference_timestamp', value: 'runStartedAt' }, { label: 'report_generated_at', value: 'reportGeneratedAt' }, { label: 'schema_version', value: 'schemaVersion' }, { label: 'timestamp_ms', value: 'timestampMs' }, { label: 'round_id', value: 'roundId' }, { label: 'cpu_percent', value: 'cpuPercent' }, { label: 'fps', value: 'fps' }, { label: 'frame_duration_ms', value: 'frameDurationMs' }, { label: 'js_heap_used_bytes', value: 'jsHeapUsedBytes' }, { label: 'react_commit_ms', value: 'reactCommitMs' }, { label: 'dispatch_duration_ms', value: 'dispatchDurationMs' }, { label: 'source', value: 'source' }
    ]),
    findings: toCsv(findings.map(f => ({ ...common, ...f, evidence: (f.evidence || []).map(e => `${e.traceFile}:${e.startUs}+${e.durationUs}us`).join('; ') })), [
      { label: 'run_id', value: 'runId' }, { label: 'data_label', value: 'dataLabel' }, { label: 'build_id', value: 'buildId' }, { label: 'run_reference_timestamp', value: 'runStartedAt' }, { label: 'report_generated_at', value: 'reportGeneratedAt' }, { label: 'schema_version', value: 'schemaVersion' }, { label: 'source', value: 'source' }, { label: 'finding_id', value: 'id' }, { label: 'category', value: 'category' }, { label: 'severity', value: 'severity' }, { label: 'title', value: 'title' }, { label: 'description', value: 'description' }, { label: 'round_id', value: 'roundId' }, { label: 'start_ms', value: 'startMs' }, { label: 'end_ms', value: 'endMs' }, { label: 'value', value: 'value' }, { label: 'unit', value: 'unit' }, { label: 'evidence', value: 'evidence' }
    ]),
    events: toCsv(run.events.map(e => ({ ...common, ...e })), [
      { label: 'run_id', value: 'runId' }, { label: 'source', value: 'source' }, { label: 'data_label', value: 'dataLabel' }, { label: 'build_id', value: 'buildId' }, { label: 'run_reference_timestamp', value: 'runStartedAt' }, { label: 'report_generated_at', value: 'reportGeneratedAt' }, { label: 'schema_version', value: 'schemaVersion' }, { label: 'timestamp_ms', value: 'timestampMs' }, { label: 'round_id', value: 'roundId' }, { label: 'event_type', value: 'type' }, { label: 'name', value: 'name' }
    ])
  };
}
export function createSnapshot(run) {
  if (!run.analysis) return buildReportSnapshot(run);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    run: { ...run, findings: run.analysis.findings },
    summary: run.analysis.summary,
    rounds: run.analysis.rounds,
    findings: run.analysis.findings,
    coverage: run.analysis.summary.coverage
  };
}
export function reportFileBase(run) { return dateFile(run, 'report'); }
