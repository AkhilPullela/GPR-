/** Shared, UI-independent domain helpers for the Game Performance Reporter. */
export const SOURCE = Object.freeze({ TRACE: 'chrome-trace', RUNTIME: 'runtime-instrumentation', DEMO: 'demo-fixture' });
export const EVENT_TYPES = Object.freeze(['roundStart', 'roundEnd', 'bonusStart', 'bonusEnd', 'winAnimationStart', 'winAnimationEnd']);

export const SEVERITY_RANK = Object.freeze({ critical: 0, warning: 1, info: 2 });

/**
 * Explicit, overridable thresholds used to classify findings. Every value is a
 * documented default rather than a hidden magic number, so a team can adjust
 * the rules for its own frame budget without touching the analysis code.
 */
export const THRESHOLDS = Object.freeze({
  longTaskMs: 50,
  longTaskCriticalMs: 100,
  frameBudgetMs: 1000 / 60,
  frameCriticalMs: 2 * (1000 / 60),
  cpuSpikePercent: 85,
  cpuCriticalPercent: 95,
  reactCommitMs: 1000 / 60,
  reactCriticalMs: 50,
  heapGrowthBytes: 32 * 1024 * 1024,
  targetFps: 60,
  // Ranking weights: higher means the factor pushes a finding up the list.
  priority: Object.freeze({ severity: Object.freeze({ critical: 1000, warning: 300, info: 40 }), recurrence: 12, duration: 1.5, evidence: 60 })
});

export function validateRun(run) {
  if (!run || typeof run !== 'object') throw new Error('Run data must be an object.');
  if (typeof run.id !== 'string' || !Array.isArray(run.samples) || !Array.isArray(run.events) || !Array.isArray(run.findings)) {
    throw new Error('Run data is missing required fields (id, samples, events, findings).');
  }
  if (!run.game || typeof run.game !== 'string') throw new Error('Run data must identify its game.');
  for (const [i, sample] of run.samples.entries()) {
    if (!Number.isFinite(sample.timestampMs)) throw new Error(`Sample ${i + 1} has an invalid timestampMs.`);
    if (![SOURCE.TRACE, SOURCE.RUNTIME, SOURCE.DEMO].includes(sample.source)) throw new Error(`Sample ${i + 1} has an unsupported source.`);
  }
  for (const event of run.events) {
    if (!Number.isFinite(event.timestampMs) || !EVENT_TYPES.includes(event.type)) throw new Error('A game marker has an invalid timestamp or event type.');
  }
  return run;
}

/**
 * Status of one dashboard metric. `captured` and `partial` are the only two
 * states that may render a measurement; the rest must render an explanation
 * instead of a zero.
 */
export const METRIC_STATUS = Object.freeze({
  CAPTURED: 'captured',
  PARTIAL: 'partial',
  NOT_CAPTURED: 'not-captured',
  UNSUPPORTED: 'unsupported',
  FAILED: 'processing-failed'
});

export const METRIC_STATUS_LABEL = Object.freeze({
  captured: 'Captured',
  partial: 'Partial',
  'not-captured': 'Not captured',
  unsupported: 'Unsupported',
  'processing-failed': 'Processing failed'
});

/** Metrics that render as a real measurement. */
export const AVAILABLE_STATUSES = Object.freeze([METRIC_STATUS.CAPTURED, METRIC_STATUS.PARTIAL]);

/**
 * Metric availability diagnostics.
 *
 * Every dashboard metric reports a status, the reason for that status, whether
 * it could be recovered from the current trace, and what recording setting or
 * instrumentation would capture it next time. Nothing here fabricates a value:
 * an absent measurement is `not-captured` or `unsupported`, never zero.
 */
export function metricAvailability(run) {
  const samples = run.samples || [];
  const tasks = run.tasks || [];
  const events = run.events || [];
  const diagnostics = run.metadata?.diagnostics || {};
  const count = key => samples.reduce((total, sample) => total + (Number.isFinite(sample[key]) ? 1 : 0), 0);
  const hasRounds = events.some(event => event.type === 'roundStart' || event.type === 'roundEnd');

  const busyCount = count('mainThreadBusyPercent');
  const heapCount = count('jsHeapUsedBytes');
  const frameCount = count('frameDurationMs') + count('fps');
  const cpuCount = count('cpuPercent');
  const reactCount = count('reactCommitMs') + count('dispatchDurationMs');

  const entry = (status, reason, howToCapture, sampleCount, extra = {}) => ({
    status,
    label: METRIC_STATUS_LABEL[status],
    available: AVAILABLE_STATUSES.includes(status),
    reason,
    note: reason,
    howToCapture,
    sampleCount,
    ...extra
  });

  const mainThread = run.metadata?.mainThreadDetected;
  const busy = busyCount > 0
    ? entry(METRIC_STATUS.CAPTURED, `Main-thread busy time measured in ${busyCount} window(s). This is not CPU utilization.`, 'Already captured. Busy time needs main-thread task events with thread metadata.', busyCount, { distinctFromCpu: true })
    : tasks.length > 0
      ? entry(METRIC_STATUS.PARTIAL, 'Main-thread tasks were found but no usable busy-time windows could be derived.', 'Export a longer trace so busy-time windows can be computed.', 0)
      : entry(METRIC_STATUS.NOT_CAPTURED, mainThread === false ? 'Renderer main-thread metadata (CrRendererMain) was not identified, so main-thread work cannot be isolated.' : 'No main-thread task events were present in this trace.', 'Record with the Performance panel so main-thread tasks are included, and keep thread_name metadata in the export.', 0);

  const cpu = cpuCount > 0
    ? entry(METRIC_STATUS.CAPTURED, 'Explicit utilization samples were present in this trace.', 'Already captured.', cpuCount)
    : entry(METRIC_STATUS.UNSUPPORTED, 'Chrome DevTools traces do not record CPU utilization. Task duration is not CPU percent, so no value is shown.', 'Use an operating-system or device profiler for utilization. Main-thread busy time is reported separately as a trace-derived proxy.', 0);

  const frames = frameCount > 0
    ? entry(frameCount >= 2 ? METRIC_STATUS.CAPTURED : METRIC_STATUS.PARTIAL, frameCount >= 2 ? 'Frame timing derived from recognized frame events.' : 'Only one frame sample was found, so no frame interval can be computed.', 'Record with the Performance panel so frame markers (FireAnimationFrame/DrawFrame) are included.', frameCount)
    : entry(METRIC_STATUS.NOT_CAPTURED, 'No recognized frame timing events were found.', 'Record a trace that includes rendering frames, and keep DrawFrame/FireAnimationFrame events in the export.', 0);

  const unparsableHeapCount = diagnostics.unparsableHeapCount || 0;
  const memory = heapCount > 0
    ? entry(heapCount >= 2 ? METRIC_STATUS.CAPTURED : METRIC_STATUS.PARTIAL, heapCount >= 2 ? 'JavaScript heap samples available. Growth alone is not proof of a leak.' : 'A single heap sample was found, so no trend can be computed.', 'Record with the Memory checkbox enabled so UpdateCounters events are captured.', heapCount)
    : unparsableHeapCount > 0
      ? entry(METRIC_STATUS.FAILED, `Found ${unparsableHeapCount} memory-shaped event(s), but none carried a recognized heap byte field. The trace may use an unsupported counter layout.`, 'Re-capture with the Memory checkbox enabled, or export from a Chrome version that writes jsHeapSizeUsed.', 0)
      : entry(METRIC_STATUS.NOT_CAPTURED, 'No supported JavaScript heap counter samples were found.', 'Enable the Memory checkbox in the Performance panel and re-capture so UpdateCounters (jsHeapSizeUsed) events are recorded.', 0);

  const react = reactCount > 0
    ? entry(METRIC_STATUS.CAPTURED, 'Instrumented React/Redux samples were present.', 'Already captured.', reactCount)
    : entry(METRIC_STATUS.NOT_CAPTURED, 'Browser traces do not contain React component or Redux dispatch timings.', 'Enable the optional QA-only React Profiler / Redux instrumentation adapter for a development run, then re-capture and re-import.', 0);

  const rounds = hasRounds
    ? entry(METRIC_STATUS.CAPTURED, 'Round intervals correlated from explicit game markers.', 'Already captured.', events.length)
    : entry(METRIC_STATUS.NOT_CAPTURED, 'Round boundaries require explicit, clock-aligned game markers; they are never inferred from trace timing.', 'Import a marker sidecar aligned to the trace clock on the Traces page.', 0);

  const taskEntry = tasks.length > 0
    ? entry(METRIC_STATUS.CAPTURED, 'Main-thread task durations extracted. Task time is not CPU utilization.', 'Already captured.', tasks.length)
    : entry(METRIC_STATUS.NOT_CAPTURED, mainThread === false ? 'Main-thread metadata was not identified, so task coverage may be incomplete.' : 'No main-thread task durations were detected.', 'Record with the Performance panel and keep thread_name metadata in the export.', 0);

  return {
    mainThreadBusy: busy,
    cpuPercent: cpu,
    frames,
    memory,
    reactRedux: react,
    rounds,
    tasks: taskEntry,
    ...(diagnostics.processingFailed ? { __failed: diagnostics.processingFailed } : {})
  };
}

/** Backwards-compatible compact coverage map derived from the availability data. */
export function metricCoverage(run) {
  const availability = run.metadata?.availability || metricAvailability(run);
  return Object.fromEntries(Object.entries(availability)
    .filter(([key]) => !key.startsWith('__'))
    .map(([key, info]) => [key, { available: info.available, note: info.reason, status: info.status }]));
}

export function displayValue(value, digits = 1) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : 'Not captured';
}
