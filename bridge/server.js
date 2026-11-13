'use strict';

/**
 * dsh bridge — thin HTTP shim around `dsh --profile headless --json`.
 *
 * Runs inside the Codespace on 127.0.0.1:8788. Never exposed directly: every
 * request must carry the shared token injected by the Worker.
 *
 * Wire format for runs: newline-delimited JSON (NDJSON). Events added by this
 * process are `bridge`, `ping`, `stderr` and `exit`; everything else comes from
 * dsh's own `--json` projection.
 */

const http = require('http');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = Number(process.env.BRIDGE_PORT || 8788);
const TOKEN = process.env.BRIDGE_TOKEN || '';
const WORKSPACE = process.env.DSH_WORKSPACE || '/workspaces/scratch';
const DSH_HOME = process.env.DSH_HOME || path.join(process.env.HOME || '/home/node', '.dsh');
const DSH_BIN = process.env.DSH_BIN || 'dsh';
const MAX_CONCURRENT = Number(process.env.BRIDGE_MAX_RUNS || 2);
const MAX_BODY = 25 * 1024 * 1024;
const MAX_STDERR = 8 * 1024;
const HEARTBEAT_MS = 10000;
const RUN_TIMEOUT_MS = Number(process.env.BRIDGE_RUN_TIMEOUT_MS || 45 * 60 * 1000);
const MODEL_PATCH = path.join(DSH_HOME, 'per-run-model.patch.yml');

const PERMISSIONS = {
  'read-only': true,
  'workspace-write': true,
  'danger-full-access': true,
};

let running = 0;
const activeSessions = Object.create(null);
let dshVersion = null;

function log() {
  console.log(new Date().toISOString(), Array.prototype.slice.call(arguments).join(' '));
}

function ensureDirs() {
  try {
    fs.mkdirSync(WORKSPACE, { recursive: true });
    fs.mkdirSync(path.join(WORKSPACE, '.uploads'), { recursive: true });
  } catch (err) {
    log('mkdir failed:', err.message);
  }
}

/* ---------- model catalog ---------- */

function modelCatalog() {
  const pick = (p, out) => {
    try {
      const text = fs.readFileSync(p, 'utf8');
      const lines = text.split('\n');
      let inModels = false;
      for (const line of lines) {
        if (/^\s*models:\s*$/.test(line)) {
          inModels = true;
          continue;
        }
        if (inModels) {
          const m = line.match(/^\s*-\s*id:\s*([A-Za-z0-9._-]+)\s*$/);
          if (m) out.push(m[1]);
          else if (/^\s*-\s+id:/.test(line) === false && /^[^\s]/.test(line)) inModels = false;
        }
      }
    } catch (err) {
      /* missing file */
    }
  };
  const out = [];
  pick(path.join(DSH_HOME, 'cordis.patch.yml'), out);
  pick(path.join(DSH_HOME, 'profiles', 'headless', 'cordis.patch.yml'), out);
  return Array.from(new Set(out));
}

/* ---------- session history ---------- */

function sessionDirs() {
  const root = path.join(DSH_HOME, 'sessions');
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    return [];
  }
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const group = path.join(root, entry.name);
    let subs = [];
    try {
      subs = fs.readdirSync(group, { withFileTypes: true });
    } catch (err) {
      continue;
    }
    for (const sub of subs) {
      if (!sub.isDirectory()) continue;
      const full = path.join(group, sub.name);
      const logPath = sessionLogPath(full);
      if (!logPath) continue;
      let stat;
      try {
        stat = fs.statSync(logPath);
      } catch (err) {
        continue;
      }
      dirs.push({ id: sub.name, dir: full, logPath, mtime: stat.mtimeMs });
    }
  }
  return dirs;
}

function sessionLogPath(dir) {
  const candidates = ['session.v4.jsonl.zstd', 'session.v4.jsonl', 'session.jsonl'];
  for (const name of candidates) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function readSessionLog(logPath) {
  const raw = fs.readFileSync(logPath);
  const isZstd = logPath.endsWith('.zstd');
  const text = isZstd ? zlib.zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8');
  return text.split('\n').filter(Boolean);
}

function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

function summarizeSession(entry) {
  const out = { id: entry.id, title: '', updatedAt: entry.mtime, model: '', cwd: '', preset: '', messages: [] };
  let lines;
  try {
    lines = readSessionLog(entry.logPath);
  } catch (err) {
    return out;
  }
  for (const line of lines) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch (err) {
      continue;
    }
    const data = ev.data || {};
    if (ev.type === 'session') {
      out.cwd = ev.cwd || data.cwd || '';
      out.preset = ev.agentPreset || '';
    } else if (ev.type === 'session/title' && data.title) {
      out.title = String(data.title);
    } else if (ev.type === 'user/message') {
      const kind = data.source && data.source.kind;
      if (kind && kind !== 'user') continue;
      const text = textOf(data.content);
      if (text) out.messages.push({ role: 'user', text });
    } else if (ev.type === 'assistant/message') {
      const msg = data.message || {};
      const text = textOf(msg.content);
      if (msg.source && msg.source.model) out.model = msg.source.model;
      if (text) out.messages.push({ role: 'assistant', text });
    }
  }
  if (!out.title) {
    const firstUser = out.messages.find((m) => m.role === 'user');
    out.title = firstUser ? firstUser.text.slice(0, 40) : out.id;
  }
  return out;
}

function handleSessions(req, res) {
  const limit = 50;
  const items = sessionDirs()
    .filter((entry) => {
      try {
        const first = readSessionLog(entry.logPath)[0];
        const ev = JSON.parse(first);
        return !ev.data || !ev.data.cwd || ev.data.cwd === WORKSPACE;
      } catch (err) {
        return true;
      }
    })
    .sort((a, b) => b.mtime - a.mtime)
    .map((entry) => {
      const s = summarizeSession(entry);
      return {
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        model: s.model,
        preset: s.preset,
        count: s.messages.length,
      };
    })
    .filter((s) => s.count > 0 && !s.preset)
    .slice(0, limit);
  sendJson(res, 200, { sessions: items });
}

function handleSession(req, res, query) {
  const id = String(query.get('id') || '');
  if (!id) return sendJson(res, 400, { error: 'missing id' });
  const entry = sessionDirs().find((e) => e.id === id);
  if (!entry) return sendJson(res, 404, { error: 'not found' });
  const s = summarizeSession(entry);
  sendJson(res, 200, {
    id: s.id,
    title: s.title,
    model: s.model,
    preset: s.preset,
    writable: !s.preset,
    messages: s.messages,
  });
}

/* ---------- files ---------- */

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.csv': 'text/csv; charset=utf-8',
};

function safeResolve(p) {
  const abs = path.resolve(WORKSPACE, p);
  if (abs !== WORKSPACE && !abs.startsWith(WORKSPACE + path.sep)) return null;
  return abs;
}

function handleFile(req, res, query) {
  const rel = String(query.get('path') || '');
  const abs = safeResolve(rel);
  if (!abs) return sendJson(res, 400, { error: 'bad path' });
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch (err) {
    return sendJson(res, 404, { error: 'not found' });
  }
  if (!stat.isFile()) return sendJson(res, 404, { error: 'not a file' });
  const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    'cache-control': 'private, max-age=60',
  });
  fs.createReadStream(abs).pipe(res);
}

function handleUpload(req, res, query) {
  const name = path.basename(String(query.get('name') || 'upload.bin')).replace(/[^\w.\-]/g, '_');
  const target = path.join(WORKSPACE, '.uploads', Date.now() + '-' + name);
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) {
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    try {
      fs.writeFileSync(target, Buffer.concat(chunks));
      sendJson(res, 200, { path: target, name, size });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  });
}


function sessionPreset(id) {
  const entry = sessionDirs().find((e) => e.id === id);
  if (!entry) return '';
  try {
    const ev = JSON.parse(readSessionLog(entry.logPath)[0]);
    return ev.agentPreset || '';
  } catch (err) {
    return '';
  }
}

function sendNdjsonError(res, message) {
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.write(JSON.stringify({ type: 'error', message }) + '\n');
  res.write(JSON.stringify({ type: 'exit', code: 1 }) + '\n');
  res.end();
}

/* ---------- runs ---------- */

function writeModelPatch(model) {
  const yml =
    '- id: agent-default-model\n' +
    '  config:\n' +
    '    provider: deepseek-official\n' +
    '    model: ' + model + '\n';
  fs.writeFileSync(MODEL_PATCH, yml);
  return MODEL_PATCH;
}

function dshArgs(opts) {
  const args = ['--profile', 'headless'];
  if (opts.model) args.push('--patch', writeModelPatch(opts.model));
  args.push('--json');
  if (opts.permission) args.push('--permission-mode', opts.permission, '--approval-policy', 'never');
  if (opts.sessionId) args.push('--session-id', String(opts.sessionId));
  args.push('-');
  return args;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorized(req) {
  if (!TOKEN) return false;
  return timingSafeEqual(String(req.headers['x-token'] || ''), TOKEN);
}

function probeVersion() {
  execFile(DSH_BIN, ['--version'], { timeout: 20000 }, function (err, stdout) {
    if (err) {
      log('dsh probe failed:', err.message);
      return;
    }
    dshVersion = String(stdout).trim();
    log('dsh version:', dshVersion);
  });
}

function handleHealth(req, res) {
  sendJson(res, 200, {
    ok: true,
    dsh: dshVersion,
    workspace: WORKSPACE,
    credential: Boolean(process.env.DEEPSEEK_API_KEY),
    running: running,
    models: modelCatalog(),
    sessions: Object.keys(activeSessions),
  });
}

function handleRun(req, res) {
  readBody(req, MAX_BODY)
    .then(function (raw) {
      let payload;
      try {
        payload = JSON.parse(raw || '{}');
      } catch (err) {
        sendJson(res, 400, { error: 'bad json' });
        return;
      }

      const prompt = payload.prompt == null ? '' : String(payload.prompt);
      if (!prompt.trim()) {
        sendJson(res, 400, { error: 'empty prompt' });
        return;
      }

      const sessionId = payload.session_id ? String(payload.session_id) : '';
      const model = payload.model ? String(payload.model) : '';
      let permission = payload.permission ? String(payload.permission) : '';
      if (permission && !PERMISSIONS[permission]) permission = '';

      if (sessionId && activeSessions[sessionId]) {
        sendJson(res, 409, { error: 'session busy', session_id: sessionId });
        return;
      }
      if (running >= MAX_CONCURRENT) {
        sendJson(res, 429, { error: 'busy', running: running });
        return;
      }

      if (sessionId) {
        const preset = sessionPreset(sessionId);
        if (preset) {
          sendNdjsonError(
            res,
            '这个会话是在桌面版（预设 ' + preset + '）里建的，手机端的 headless 运行器接管不了。请点「新对话」重新开始。',
          );
          return;
        }
      }

      startRun(req, res, { sessionId, prompt, model, permission });
    })
    .catch(function (err) {
      sendJson(res, 413, { error: err.message });
    });
}

function startRun(req, res, opts) {
  const started = Date.now();
  running += 1;
  if (opts.sessionId) activeSessions[opts.sessionId] = started;

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  });

  let closed = false;
  let stderrTail = '';
  let effectiveId = opts.sessionId;

  function emit(obj) {
    if (closed) return;
    try {
      res.write(JSON.stringify(obj) + '\n');
    } catch (err) {
      closed = true;
    }
  }

  emit({
    type: 'bridge',
    phase: 'spawn',
    session_id: opts.sessionId || null,
    cwd: WORKSPACE,
    model: opts.model || null,
    permission: opts.permission || null,
  });

  let args;
  try {
    args = dshArgs(opts);
  } catch (err) {
    emit({ type: 'error', message: 'patch failed: ' + err.message });
    emit({ type: 'exit', code: 1 });
    running -= 1;
    res.end();
    return;
  }

  const child = spawn(DSH_BIN, args, {
    cwd: WORKSPACE,
    env: Object.assign({}, process.env, {
      DSH_WORKSPACE: WORKSPACE,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const heartbeat = setInterval(function () {
    emit({ type: 'ping', t: Date.now() });
  }, HEARTBEAT_MS);

  const killer = setTimeout(function () {
    emit({ type: 'bridge', phase: 'timeout' });
    try {
      child.kill('SIGKILL');
    } catch (err) {
      /* ignore */
    }
  }, RUN_TIMEOUT_MS);

  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', function (chunk) {
    pending += chunk;
    let idx;
    while ((idx = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, idx).trim();
      pending = pending.slice(idx + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        if (event && event.type === 'session' && event.sessionId) {
          effectiveId = String(event.sessionId);
          activeSessions[effectiveId] = started;
        }
        emit(event);
      } catch (err) {
        emit({ type: 'raw', line: line.slice(0, 4096) });
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', function (chunk) {
    stderrTail = (stderrTail + chunk).slice(-MAX_STDERR);
  });

  child.on('error', function (err) {
    emit({ type: 'error', message: 'spawn failed: ' + err.message });
  });

  child.on('close', function (code, signal) {
    if (pending.trim()) {
      try {
        emit(JSON.parse(pending.trim()));
      } catch (err) {
        emit({ type: 'raw', line: pending.trim().slice(0, 4096) });
      }
    }
    if (code !== 0 && stderrTail) {
      emit({ type: 'stderr', text: stderrTail });
    }
    emit({ type: 'exit', code: code, signal: signal, ms: Date.now() - started });

    clearInterval(heartbeat);
    clearTimeout(killer);
    running = Math.max(0, running - 1);
    if (effectiveId) delete activeSessions[effectiveId];
    closed = true;
    try {
      res.end();
    } catch (err) {
      /* ignore */
    }
    log('run done code=' + code + ' ms=' + (Date.now() - started));
  });

  req.on('aborted', function () {
    closed = true;
    try {
      child.kill('SIGKILL');
    } catch (err) {
      /* ignore */
    }
  });

  try {
    child.stdin.end(opts.prompt, 'utf8');
  } catch (err) {
    emit({ type: 'error', message: 'stdin failed: ' + err.message });
  }
}

/* ---------- router ---------- */

function route(req, res, query) {
  const url = req.url.split('?')[0];

  if (!authorized(req)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  if (url === '/health') return handleHealth(req, res);
  if (url === '/models') return sendJson(res, 200, { models: modelCatalog() });
  if (url === '/sessions') return handleSessions(req, res);
  if (url === '/session') return handleSession(req, res, query);
  if (url === '/file') return handleFile(req, res, query);
  if (url === '/upload' && req.method === 'POST') return handleUpload(req, res, query);
  if (url === '/run' && req.method === 'POST') return handleRun(req, res);

  sendJson(res, 404, { error: 'not found' });
}

ensureDirs();
probeVersion();

const server = http.createServer(function (req, res) {
  const query = new URL(req.url, 'http://127.0.0.1').searchParams;
  try {
    route(req, res, query);
  } catch (err) {
    log('route error:', err && err.stack ? err.stack : String(err));
    try {
      sendJson(res, 500, { error: 'internal' });
    } catch (ignored) {
      /* ignore */
    }
  }
});

server.headersTimeout = 0;
server.requestTimeout = 0;
server.keepAliveTimeout = 65000;

server.listen(PORT, '127.0.0.1', function () {
  log('bridge listening on 127.0.0.1:' + PORT + ' workspace=' + WORKSPACE);
});
