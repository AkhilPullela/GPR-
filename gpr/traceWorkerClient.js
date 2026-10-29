const parsedTraceCache = new WeakMap();

function runInWorker(payload, onProgress = () => {}, signal) {
  if (signal?.aborted) return Promise.reject(new DOMException('Import cancelled.', 'AbortError'));
  if (typeof Worker === 'undefined') return Promise.reject(new Error('Web Workers are unavailable in this browser. Use a supported modern browser to import traces.'));
  return new Promise((resolve, reject) => {
    let worker;
    try { worker = new Worker(new URL('./trace.worker.js', import.meta.url), { type: 'module' }); }
    catch (error) { reject(new Error(`Could not start the trace worker: ${error.message || 'browser resource failure'}. Close other tabs or retry with a smaller DevTools recording.`)); return; }
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener('abort', cancel);
      worker.terminate();
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const cancel = () => finish(reject, new DOMException('Trace processing was cancelled. Select the file again to retry.', 'AbortError'));
    signal?.addEventListener('abort', cancel, { once: true });
    worker.onmessage = event => {
      const message = event.data || {};
      if (message.type === 'progress') { onProgress(message.message); return; }
      if (message.type === 'result') finish(resolve, message.run);
      else finish(reject, new Error(message.message || 'Trace parsing failed.'));
    };
    worker.onerror = event => finish(reject, new Error(`Trace processing stopped unexpectedly. The browser may have run out of memory; reduce the DevTools recording time range and retry.${event.message ? ` Details: ${event.message}` : ''}`));
    worker.onmessageerror = () => finish(reject, new Error('The browser could not transfer the parsed trace result. Reduce the DevTools recording time range and retry.'));
    try { worker.postMessage(payload); }
    catch (error) { finish(reject, new Error(`Could not send the selected file to the trace worker: ${error.message || 'browser resource failure'}`)); }
  });
}

export function parseChromeTraceInWorker(file, fileName, onProgress = () => {}, signal) {
  if (signal?.aborted) return Promise.reject(new DOMException('Import cancelled.', 'AbortError'));
  const cached = file && parsedTraceCache.get(file);
  if (cached) { onProgress('Using cached normalized trace data…'); return Promise.resolve(cached); }
  return runInWorker({ type: 'parse', file, fileName }, onProgress, signal).then(run => {
    parsedTraceCache.set(file, run);
    return run;
  });
}

export function importMarkersInWorker(run, file, onProgress = () => {}, signal) {
  return runInWorker({ type: 'markers', run, file, fileName: file.name }, onProgress, signal);
}
