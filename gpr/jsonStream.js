/**
 * Incremental JSON reader with bounded memory and precise diagnostics.
 *
 * Design goals:
 * - Never materialize the whole decoded file as one string, and never build a
 *   generic object tree for the whole document.
 * - Expose a pull-based token stream so callers can consume one value at a time
 *   and release it immediately.
 * - Preserve parser state across chunk boundaries for strings, escape
 *   sequences, numbers, nested objects, and arrays.
 * - Distinguish "truncated input" (the document simply ended early) from
 *   "malformed input" (the document is internally inconsistent), so callers can
 *   give actionable errors instead of a bare SyntaxError.
 */

/** Thrown when the stream ends while the JSON document is still incomplete. */
export class TruncatedJsonError extends SyntaxError {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'TruncatedJsonError';
    Object.assign(this, detail);
  }
}

/** Thrown when the bytes are not valid JSON in a way that is not truncation. */
export class MalformedJsonError extends SyntaxError {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'MalformedJsonError';
    Object.assign(this, detail);
  }
}

const WHITESPACE = /[ \t\n\r]/;
const NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

const utf8Decoder = () => new TextDecoder('utf-8', { fatal: false });

/**
 * Reads a byte stream and produces JSON tokens lazily.
 *
 * Usage:
 *   const reader = new JsonTokenReader(byteStream, onBytes);
 *   const value = await reader.readValue();      // one full JSON value
 *   const rest  = await reader.readAllValues();  // for top-level arrays
 */
export class JsonTokenReader {
  constructor(stream, onBytes = () => {}) {
    this.reader = stream.getReader();
    this.onBytes = onBytes;
    this.decoder = utf8Decoder();
    this.buffer = '';
    this.offset = 0;
    this.bytesRead = 0;
    this.finished = false;
    this.lookahead = undefined;
    this.sawInvalidUtf8 = false;
  }

  async release() {
    try { await this.reader.cancel(); } catch { /* stream already closed */ }
    try { this.reader.releaseLock(); } catch { /* already released */ }
  }

  /** Read more bytes until the buffer has unconsumed data or the stream ends. */
  async fill() {
    while (this.offset >= this.buffer.length && !this.finished) {
      if (this.offset) { this.buffer = this.buffer.slice(this.offset); this.offset = 0; }
      let chunk;
      try {
        chunk = await this.reader.read();
      } catch (error) {
        throw new MalformedJsonError(`The trace file could not be read (${error?.name || 'read error'}).`, { cause: error });
      }
      if (chunk.done) {
        this.buffer += this.decoder.decode();
        this.finished = true;
      } else {
        this.bytesRead += chunk.value.byteLength;
        this.buffer += this.decoder.decode(chunk.value, { stream: true });
        this.onBytes(this.bytesRead);
      }
    }
  }

  async peek() { await this.fill(); return this.buffer[this.offset]; }

  skipWhitespace() {
    while (this.offset < this.buffer.length && WHITESPACE.test(this.buffer[this.offset])) this.offset++;
  }

  /** True when only whitespace remains (or nothing) and the stream has ended. */
  async atEnd() {
    while (true) {
      await this.fill();
      this.skipWhitespace();
      if (this.offset < this.buffer.length) return false;
      if (this.finished) return true;
    }
  }

  async readToken() {
    while (true) {
      await this.fill();
      this.skipWhitespace();
      if (this.offset < this.buffer.length) break;
      if (this.finished) return { type: 'eof' };
    }
    const char = this.buffer[this.offset];
    if ('{}[]:,'.includes(char)) { this.offset++; return { type: char }; }
    if (char === '"') return this.readString();
    return this.readPrimitive();
  }

  async readString() {
    const parts = [];
    this.offset++;
    let segmentStart = this.offset;
    let escaped = false;
    while (true) {
      const buf = this.buffer;
      let i = segmentStart;
      let terminated = false;
      while (i < buf.length) {
        const code = buf.charCodeAt(i);
        if (escaped) { escaped = false; i++; continue; }
        if (code === 0x5c) { escaped = true; i++; continue; }
        if (code === 0x22) { terminated = true; break; }
        i++;
      }
      parts.push(buf.slice(segmentStart, terminated ? i : buf.length));
      this.offset = terminated ? i + 1 : buf.length;
      if (terminated) break;
      if (this.finished) throw new TruncatedJsonError('The trace JSON ends inside a string. The export looks incomplete or truncated.', { position: this.bytesRead });
      await this.fill();
      segmentStart = this.offset;
    }
    try {
      return { type: 'string', value: JSON.parse(`"${parts.join('')}"`) };
    } catch {
      throw new MalformedJsonError('The trace JSON contains an invalid escape sequence inside a string.', { position: this.bytesRead });
    }
  }

  async readPrimitive() {
    const parts = [];
    let segmentStart = this.offset;
    while (true) {
      const buf = this.buffer;
      let i = segmentStart;
      while (i < buf.length) {
        const code = buf.charCodeAt(i);
        if (code === 0x2c || code === 0x5d || code === 0x7d || code === 0x3a || code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) break;
        i++;
      }
      if (i >= buf.length) {
        if (this.finished) { parts.push(buf.slice(segmentStart)); this.offset = buf.length; break; }
        parts.push(buf.slice(segmentStart));
        this.offset = buf.length;
        await this.fill();
        segmentStart = this.offset;
        continue;
      }
      parts.push(buf.slice(segmentStart, i));
      this.offset = i;
      break;
    }
    const text = parts.join('');
    if (text === 'true') return { type: 'value', value: true };
    if (text === 'false') return { type: 'value', value: false };
    if (text === 'null') return { type: 'value', value: null };
    if (!text) throw new TruncatedJsonError('The trace JSON ends before a value was written.', { position: this.bytesRead });
    if (!NUMBER_PATTERN.test(text)) throw new MalformedJsonError(`The trace JSON contains an unexpected token: ${text.slice(0, 40)}`, { position: this.bytesRead });
    return { type: 'value', value: Number(text) };
  }

  async next() {
    const current = this.lookahead ?? await this.readToken();
    this.lookahead = undefined;
    return current;
  }

  async expect(type) {
    const token = await this.next();
    if (token.type !== type) {
      if (token.type === 'eof') throw new TruncatedJsonError(`The trace JSON ends where a "${type}" was expected. The export looks incomplete or truncated.`, { position: this.bytesRead });
      throw new MalformedJsonError(`Expected "${type}" in the trace JSON but found "${token.type}".`, { position: this.bytesRead });
    }
    return token;
  }

  /** Read exactly one JSON value. */
  async readValue() {
    return this.readFrom(await this.next());
  }

  /** Stream the elements of an array whose opening "[" has already been consumed. */
  async readArrayElements(onElement) {
    let first = true;
    while (true) {
      let itemToken = this.lookahead ?? await this.next();
      this.lookahead = undefined;
      if (itemToken.type === ']') break;
      if (itemToken.type === 'eof') throw new TruncatedJsonError('The trace JSON ends inside an array. The export looks incomplete or truncated.', { position: this.bytesRead });
      if (!first) {
        if (itemToken.type !== ',') throw new MalformedJsonError(`Expected a comma or a closing bracket in the trace JSON but found "${itemToken.type}".`, { position: this.bytesRead });
        itemToken = await this.next();
        if (itemToken.type === ']') break;
        if (itemToken.type === 'eof') throw new TruncatedJsonError('The trace JSON ends inside an array. The export looks incomplete or truncated.', { position: this.bytesRead });
      }
      first = false;
      onElement(await this.readFrom(itemToken));
    }
  }

  async readFrom(token) {
    if (token.type === 'value' || token.type === 'string') return token.value;
    if (token.type === '{') {
      const result = {};
      while (true) {
        let keyToken = await this.next();
        if (keyToken.type === '}') break;
        if (keyToken.type === 'eof') throw new TruncatedJsonError('The trace JSON ends inside an object. The export looks incomplete or truncated.', { position: this.bytesRead });
        if (keyToken.type !== 'string') throw new MalformedJsonError(`Expected an object property name in the trace JSON but found "${keyToken.type}".`, { position: this.bytesRead });
        await this.expect(':');
        const value = await this.readValue();
        if (keyToken.value === '__proto__') Object.defineProperty(result, keyToken.value, { value, enumerable: true, configurable: true, writable: true });
        else result[keyToken.value] = value;
        keyToken = await this.next();
        if (keyToken.type === '}') break;
        if (keyToken.type === 'eof') throw new TruncatedJsonError('The trace JSON ends inside an object. The export looks incomplete or truncated.', { position: this.bytesRead });
        if (keyToken.type !== ',') throw new MalformedJsonError(`Expected a comma or a closing brace in the trace JSON but found "${keyToken.type}".`, { position: this.bytesRead });
      }
      return result;
    }
    if (token.type === '[') {
      const result = [];
      await this.readArrayElements(value => result.push(value));
      return result;
    }
    if (token.type === 'eof') throw new TruncatedJsonError('The trace JSON is empty or ends before any value. The export looks incomplete or truncated.', { position: this.bytesRead });
    throw new MalformedJsonError(`Expected a JSON value in the trace JSON but found "${token.type}".`, { position: this.bytesRead });
  }

  /**
   * Read the document root while streaming trace events.
   *
   * Recognized shapes:
   * - a top-level array of events;
   * - `{ traceEvents: [...] }`;
   * - `{ trace: { traceEvents: [...] } }` and `{ data: { traceEvents: [...] } }`.
   *
   * The event array is never retained: each element is handed to `onEvent` as
   * soon as it is parsed. Other top-level metadata is returned.
   */
  async readRoot(onEvent) {
    const token = await this.next();
    if (token.type === '[') {
      await this.readArrayElements(onEvent);
      return { kind: 'array', metadata: undefined };
    }
    if (token.type !== '{') {
      if (token.type === 'eof') throw new TruncatedJsonError('The trace JSON is empty. The export looks incomplete or truncated.', { position: this.bytesRead });
      throw new MalformedJsonError('Unsupported trace JSON. Expected an array of trace events or an object containing "traceEvents".', { position: this.bytesRead });
    }
    const metadata = {};
    let foundEvents = false;
    const streamEventsIfArray = async key => {
      const token = await this.next();
      if (token.type === '[') { await this.readArrayElements(onEvent); return true; }
      const value = await this.readFrom(token);
      metadata[key] = value;
      return false;
    };
    while (true) {
      let keyToken = await this.next();
      if (keyToken.type === '}') break;
      if (keyToken.type === 'eof') throw new TruncatedJsonError('The trace JSON ends inside the top-level object. The export looks incomplete or truncated.', { position: this.bytesRead });
      if (keyToken.type !== 'string') throw new MalformedJsonError(`Expected an object property name in the trace JSON but found "${keyToken.type}".`, { position: this.bytesRead });
      await this.expect(':');
      const key = keyToken.value;
      if (key === 'traceEvents' || key === 'events') {
        foundEvents = (await streamEventsIfArray(key)) || foundEvents;
      } else if (key === 'trace' || key === 'data') {
        const nested = await this.next();
        if (nested.type === '{') {
          const nestedMetadata = {};
          while (true) {
            let nestedKey = await this.next();
            if (nestedKey.type === '}') break;
            if (nestedKey.type === 'eof') throw new TruncatedJsonError('The trace JSON ends inside the top-level object. The export looks incomplete or truncated.', { position: this.bytesRead });
            if (nestedKey.type !== 'string') throw new MalformedJsonError(`Expected an object property name in the trace JSON but found "${nestedKey.type}".`, { position: this.bytesRead });
            await this.expect(':');
            if (nestedKey.value === 'traceEvents' || nestedKey.value === 'events') {
              foundEvents = (await streamEventsIfArray(nestedKey.value)) || foundEvents;
            } else {
              nestedMetadata[nestedKey.value] = await this.readValue();
            }
            const after = await this.next();
            if (after.type === '}') break;
            if (after.type === 'eof') throw new TruncatedJsonError('The trace JSON ends inside the top-level object. The export looks incomplete or truncated.', { position: this.bytesRead });
            if (after.type !== ',') throw new MalformedJsonError(`Expected a comma or a closing brace in the trace JSON but found "${after.type}".`, { position: this.bytesRead });
          }
          metadata[key] = nestedMetadata;
        } else {
          metadata[key] = await this.readFrom(nested);
        }
      } else {
        metadata[key] = await this.readValue();
      }
      const after = await this.next();
      if (after.type === '}') break;
      if (after.type === 'eof') throw new TruncatedJsonError('The trace JSON ends inside the top-level object. The export looks incomplete or truncated.', { position: this.bytesRead });
      if (after.type !== ',') throw new MalformedJsonError(`Expected a comma or a closing brace in the trace JSON but found "${after.type}".`, { position: this.bytesRead });
    }
    if (!foundEvents) throw new MalformedJsonError('Unsupported trace JSON. Expected an array of trace events or an object containing "traceEvents".', { position: this.bytesRead });
    return { kind: 'object', metadata };
  }
}
