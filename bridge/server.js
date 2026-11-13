'use strict';

/**
 * dsh bridge — thin HTTP shim around `dsh --profile headless --json`.
 *
 * Runs inside the Codespace on 127.0.0.1:8788. Never exposed directly: every
 * request must carry the shared token injected by the Worker.
 *
 * Wire format: newline-delimited JSON (NDJSON). The Worker proxies it to the
 * phone unchanged. Events we add ourselves are tagged `type` values that dsh
 * does not emit: bridge, ping, stderr, exit.
 */

const http = require('http');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.BRIDGE_PORT || 8788);
const TOKEN = process.env.BRIDGE_TOKEN || '';
const WORKSPACE = process.env.DSH_WORKSPACE || '/workspaces/scratch';
const DSH_BIN = process.env.DSH_BIN || 'dsh';
const MAX_CONCURRENT = Number(process.env.BRIDGE_MAX_RUNS || 2);
const MAX_BODY = 256 * 1024;
const MAX_STDERR = 8 * 1024;
const HEARTBEAT_MS = 10000;
const RUN_TIMEOUT_MS = Number(process.env.BRIDGE_RUN_TIMEOUT_MS || 45 * 60 * 1000);

let running = 0;
const activeSessions = Object.create(null);
let dshVersion = null;

function log() {
  const args = Array.prototype.slice.call(arguments);
  console.log(new Date().toISOString(), args.join(' '));
}

function ensureWorkspace() {
  try {
    fs.mkdirSync(WORKSPACE, { recursive: true });
  } catch (err) {
    log('workspace mkdir failed:', err.message);
  }
}

function dshArgs(sessionId) {
  const args = ['--profile', 'headless', '--json'];
  if (sessionId) args.push('--session-id', String(sessionId));
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
  const hasKey = Boolean(process.env.DEEPSEEK_API_KEY);
  sendJson(res, 200, {
    ok: true,
    dsh: dshVersion,
    workspace: WORKSPACE,
    credential: hasKey,
    running: running,
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
      if (sessionId && activeSessions[sessionId]) {
        sendJson(res, 409, { error: 'session busy', session_id: sessionId });
        return;
      }
      if (running >= MAX_CONCURRENT) {
        sendJson(res, 429, { error: 'busy', running: running });
        return;
      }

      startRun(req, res, sessionId, prompt);
    })
    .catch(function (err) {
      sendJson(res, 413, { error: err.message });
    });
}

function startRun(req, res, sessionId, prompt) {
  const started = Date.now();
  running += 1;
  if (sessionId) activeSessions[sessionId] = started;

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  });

  let closed = false;
  let stderrTail = '';

  function emit(obj) {
    if (closed) return;
    try {
      res.write(JSON.stringify(obj) + '\n');
    } catch (err) {
      closed = true;
    }
  }

  emit({ type: 'bridge', phase: 'spawn', session_id: sessionId || null, cwd: WORKSPACE });

  const child = spawn(DSH_BIN, dshArgs(sessionId), {
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
          activeSessions[String(event.sessionId)] = started;
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
    if (sessionId) delete activeSessions[sessionId];
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
    child.stdin.end(prompt, 'utf8');
  } catch (err) {
    emit({ type: 'error', message: 'stdin failed: ' + err.message });
  }
}

function route(req, res) {
  const url = req.url.split('?')[0];

  if (url === '/health') {
    if (!authorized(req)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    handleHealth(req, res);
    return;
  }

  if (!authorized(req)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  if (url === '/run' && req.method === 'POST') {
    handleRun(req, res);
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

ensureWorkspace();
probeVersion();

const server = http.createServer(function (req, res) {
  try {
    route(req, res);
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
