/**
 * Reading the blob Cursor keeps a tool call in.
 *
 * Cursor used to store a tool call's arguments and answer as JSON on the bubble
 * (`params` and `result`). This build stores neither: there is no result at all,
 * and everything real — the command line, everything it printed, how long it
 * took, what it exited with — is a protocol-buffers blob in `toolCallBinary`.
 * Auto was reading the fields that no longer exist, which is why a command
 * reached a phone with no output and stuck at "loading".
 *
 * There is no schema to compile against, and protobuf does not need one to be
 * walked: every field announces its number and length. So this reads by field
 * number along paths found by looking at real calls, and each path is written
 * down below with what was seen at it. Field numbers are Cursor's and can move
 * in an update, so nothing here is required to be present: a call that cannot
 * be read gives up its command or its output rather than throwing.
 */

/**
 * Where things live, by field number.
 *
 * Two branches hang off the top: the request Cursor sent (1.1) and the answer
 * it got back (1.2). The answer is one of two shapes — a command that finished
 * (1.2.1) or one that failed (1.2.2) — and they are laid out alike, so both are
 * read the same way and which one was present is the verdict.
 *
 * Read off real calls: a `cursor-agent --version` that printed to both streams,
 * a `cmd /c dir` that exited 1, and an `rg` that found nothing.
 */
const AT = {
  command: [1, 1, 1],
  cwd: [1, 1, 2],
  /** The finished answer, then the failed one. Order matters: it is the verdict. */
  results: [
    [1, 2, 1],
    [1, 2, 2],
  ],
  inResult: {
    /** The command as it was actually run. */
    command: [1],
    exitCode: [3],
    stdout: [5],
    stderr: [6],
    /** Both streams as the card shows them, escape codes and all. */
    combined: [10],
    durationMs: [13],
    durationMsAlso: [12],
  },
};

/** Escape codes and carriage returns say nothing on a phone. */
const plainText = (text) =>
  String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, '')
    .replace(/\r\n?/g, '\n');

/** Is this worth putting on a screen, once the escape codes are gone? */
function readable(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  const text = plainText(buf.toString('utf8'));
  if (text.includes('\uFFFD')) return null;
  // eslint-disable-next-line no-control-regex
  const control = text.replace(/[\n\t]/g, '').match(/[\u0000-\u001f]/g);
  if (control && control.length > text.length / 20) return null;
  return text;
}

/** One varint from `at`, and where it ended. */
function varint(buf, at) {
  let value = 0n;
  let shift = 0n;
  let i = at;
  while (i < buf.length) {
    const byte = buf[i];
    i += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value, i];
    shift += 7n;
    if (shift > 63n) return [null, buf.length + 1];
  }
  return [null, buf.length + 1];
}

/**
 * Every field in a message, or null if these bytes are not one.
 *
 * Returning null rather than throwing matters: this is asked to parse bytes that
 * may well be a string, and "not a message" is an ordinary answer.
 */
export function fields(buf) {
  if (!buf?.length) return null;
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const [tag, next] = varint(buf, i);
    if (tag === null) return null;
    i = next;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (!field) return null;
    if (wire === 0) {
      const [value, after] = varint(buf, i);
      if (value === null) return null;
      i = after;
      out.push({ field, wire, value });
    } else if (wire === 2) {
      const [len, after] = varint(buf, i);
      if (len === null) return null;
      const end = after + Number(len);
      if (end > buf.length) return null;
      out.push({ field, wire, bytes: buf.subarray(after, end) });
      i = end;
    } else if (wire === 5) {
      if (i + 4 > buf.length) return null;
      i += 4;
    } else if (wire === 1) {
      if (i + 8 > buf.length) return null;
      i += 8;
    } else {
      return null;
    }
  }
  return out;
}

/** Every value at a path, in the order they appear. Repeats are normal here. */
function all(buf, path) {
  let level = [buf];
  for (const step of path) {
    const next = [];
    for (const bytes of level) {
      for (const f of fields(bytes) || []) {
        if (f.field === step) next.push(f.wire === 2 ? f.bytes : f.value);
      }
    }
    if (!next.length) return [];
    level = next;
  }
  return level;
}

const oneString = (buf, path) => {
  const found = all(buf, path).find((v) => Buffer.isBuffer(v));
  const text = readable(found);
  return text ? text : null;
};

const oneNumber = (buf, path) => {
  const found = all(buf, path).find((v) => typeof v === 'bigint');
  return found === undefined ? null : Number(found);
};

/**
 * What a command printed.
 *
 * Both streams, in the order a terminal would have shown them, because that is
 * what someone reading it on a phone is picturing. Cursor also keeps the two
 * already joined, which is used when the separate ones cannot be read.
 */
function outputOf(result) {
  const { inResult } = AT;
  const stdout = oneString(result, inResult.stdout);
  const stderr = oneString(result, inResult.stderr);
  const both = [stdout, stderr].filter((s) => s && s.trim());
  if (both.length) return { output: [...new Set(both)].join('\n'), stdout, stderr };

  const combined = oneString(result, inResult.combined);
  return { output: combined || null, stdout, stderr };
}

/**
 * What a tool call ran and what came back.
 *
 * A call still running has an answer branch that is simply not there yet, so
 * everything but the command comes back null — which is the honest report, and
 * what tells a caller to look again later.
 *
 * @param {string} base64  the bubble's `toolCallBinary`
 * @returns {{ command: string|null, cwd: string|null, output: string|null,
 *   stdout: string|null, stderr: string|null, exitCode: number|null,
 *   durationMs: number|null, failed: boolean, finished: boolean }}
 */
export function decodeToolBinary(base64) {
  const empty = {
    command: null,
    cwd: null,
    output: null,
    stdout: null,
    stderr: null,
    exitCode: null,
    durationMs: null,
    failed: false,
    finished: false,
  };
  if (!base64 || typeof base64 !== 'string') return empty;

  let buf;
  try {
    buf = Buffer.from(base64, 'base64');
  } catch {
    return empty;
  }
  if (!fields(buf)) return empty;

  const asked = { command: oneString(buf, AT.command), cwd: oneString(buf, AT.cwd) };

  const [okPath, failedPath] = AT.results;
  const ok = all(buf, okPath).find(Buffer.isBuffer);
  const bad = ok ? null : all(buf, failedPath).find(Buffer.isBuffer);
  const result = ok || bad;
  if (!result) return { ...empty, ...asked };

  const { inResult } = AT;
  const { output, stdout, stderr } = outputOf(result);
  const exitCode = oneNumber(result, inResult.exitCode);

  return {
    ...asked,
    // The command as run is more truthful than the one asked for, when both are
    // there: Cursor wraps some of them.
    command: asked.command || oneString(result, inResult.command),
    output,
    stdout,
    stderr,
    exitCode: exitCode ?? (bad ? null : 0),
    durationMs: oneNumber(result, inResult.durationMs) ?? oneNumber(result, inResult.durationMsAlso),
    failed: Boolean(bad),
    finished: true,
  };
}

/**
 * Every string in the blob with the path it was found at.
 *
 * For working out where Cursor has moved something after an update: the paths
 * above were read off this. Diagnostics only.
 */
export function describeToolBinary(base64, { limit = 400 } = {}) {
  const found = [];
  const walk = (buf, path, depth) => {
    if (depth > 8 || found.length > limit) return;
    const parsed = fields(buf);
    const message = parsed?.length && parsed.every((f) => f.field < 200);
    if (!message) {
      const text = buf.toString('utf8');
      found.push({ path, value: text.includes('\uFFFD') ? `<${buf.length} bytes>` : text });
      return;
    }
    for (const f of parsed) {
      const here = path ? `${path}.${f.field}` : String(f.field);
      if (f.wire === 2) walk(f.bytes, here, depth + 1);
      else found.push({ path: here, value: String(f.value) });
    }
  };
  try {
    walk(Buffer.from(base64, 'base64'), '', 0);
  } catch {
    /* a blob we cannot read tells us nothing, which is the answer */
  }
  return found;
}
