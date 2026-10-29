/** Optional, bounded development instrumentation helpers. They do not attach automatically. */
export function createBoundedRecorder({ enabled = false, maxEntries = 5000, sampleRate = 1, onOverhead } = {}) {
  const entries = [];
  let recorded = 0, dropped = 0, overheadMs = 0;
  return {
    record(entry) {
      if (!enabled || Math.random() > sampleRate) return;
      const started = performance.now();
      if (entries.length >= maxEntries) { entries.shift(); dropped++; }
      entries.push({ ...entry, recordedAtMs: performance.now() });
      overheadMs += performance.now() - started;
      recorded++;
      onOverhead?.(overheadMs, recorded);
    },
    snapshot() { return { entries: entries.slice(), recorded, dropped, estimatedRecorderOverheadMs: overheadMs }; },
    clear() { entries.length = 0; recorded = 0; dropped = 0; overheadMs = 0; },
    get enabled() { return enabled; }
  };
}

/** Suitable as the onRender callback passed to React Profiler. Avoids component-level claims. */
export function createReactProfilerCallback(recorder, getContext = () => ({})) {
  return (id, phase, actualDuration, baseDuration, startTime, commitTime) => recorder.record({ kind: 'react-commit', subtreeId: id, phase, actualDurationMs: actualDuration, baseDurationMs: baseDuration, startTimeMs: startTime, commitTimeMs: commitTime, ...getContext() });
}

/** Redux-compatible middleware; records action type and timing, never state or payload. */
export function createReduxTimingMiddleware(recorder, { enabled = false, now = () => performance.now() } = {}) {
  if (!enabled || !recorder?.enabled) return () => next => action => next(action);
  return store => next => action => {
    const start = now();
    try { return next(action); }
    finally { recorder.record({ kind: 'redux-dispatch', actionType: typeof action?.type === 'string' ? action.type : 'unknown', durationMs: now() - start }); }
  };
}

export function createNoopInstrumentation() {
  return { record() {}, snapshot: () => ({ entries: [], recorded: 0, dropped: 0, estimatedRecorderOverheadMs: 0 }), clear() {}, enabled: false };
}
