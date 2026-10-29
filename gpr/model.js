/** Shared, UI-independent domain helpers for the Game Performance Reporter. */
export const SOURCE = Object.freeze({ TRACE: 'chrome-trace', RUNTIME: 'runtime-instrumentation', DEMO: 'demo-fixture' });
export const EVENT_TYPES = Object.freeze(['roundStart', 'roundEnd', 'bonusStart', 'bonusEnd', 'winAnimationStart', 'winAnimationEnd']);

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

export function metricCoverage(run) {
  const has = key => run.samples.some(sample => Number.isFinite(sample[key]));
  return {
    cpuPercent: { available: has('cpuPercent'), note: has('cpuPercent') ? 'Explicit utilization measurements' : 'Trace task duration is not CPU utilization.' },
    frames: { available: has('fps') || has('frameDurationMs'), note: has('fps') || has('frameDurationMs') ? 'Frame timing observed where supported' : 'No supported frame timing events found.' },
    memory: { available: has('jsHeapUsedBytes'), note: has('jsHeapUsedBytes') ? 'Heap samples available; growth is not proof of a leak.' : 'No supported JavaScript heap samples found.' },
    reactRedux: { available: run.samples.some(s => Number.isFinite(s.reactCommitMs) || Number.isFinite(s.dispatchDurationMs)), note: 'Requires optional application instrumentation.' },
    rounds: { available: run.events.some(e => e.type === 'roundStart' || e.type === 'roundEnd'), note: run.events.some(e => e.type === 'roundStart') ? 'Correlated from explicit game markers.' : 'Round analysis unavailable without valid markers.' },
    tasks: { available: run.tasks?.length > 0, note: run.tasks?.length ? 'Main-thread task activity; not system CPU utilization.' : 'No main-thread task durations detected.' }
  };
}

export function displayValue(value, digits = 1) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : 'Not captured';
}
