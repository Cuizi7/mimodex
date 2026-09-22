#!/usr/bin/env node
/**
 * mimodex 适配代理 — Codex Responses API ⇄ MiMo 网关
 *
 * 定位：透明反向代理 + 三个请求体改写。不做任何协议翻译。
 *
 *   ① body.model             别名映射（精确 → glob → 原样透传）
 *   ② body.text.format.type  json_schema → json_object（MiMo 不支持 json_schema，
 *                            而 guardian 审查依赖结构化输出，故降级）
 *   ③ body.reasoning.effort  序数 clamp（max/xhigh → high，minimal → low）
 *
 * ── 上游连接为什么用 node:https 而不是内置 fetch ──────────────────────────
 * 曾经用全局 fetch（undici）。在「长驻进程 + 长流式响应 + 本地代理中转」的组合下，
 * undici 的全局 dispatcher 会塌缩到单条上游连接，之后所有请求都串行排在那一条
 * socket 后面。实测同一份请求的 6 并发总墙钟：
 *
 *     直连 MiMo                1.03s
 *     全新代理进程（同一份代码）  1.03s
 *     劣化后的长驻进程           37.6s   ← 采样期间上游连接数恒为 1
 *
 * 换成显式 https.Agent 后，maxSockets / keepAlive / 超时全部可控，并可在
 * /healthz 与日志里观测连接状态。这是修该故障的核心，不要改回 fetch。
 *
 * 用法：node proxy.mjs              （前台运行，便于调试）
 *       mimodex proxy start         （后台运行）
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────── 配置 ───────────────────────────
const CONFIG_PATH = process.env.MIMO_PROXY_CONFIG || path.join(__dirname, 'config.json');
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
  console.error(`[mimodex-proxy] 无法读取配置 ${CONFIG_PATH}: ${e.message}`);
  process.exit(1);
}

const PORT = Number(cfg.port ?? 8787);
const HOST = cfg.host || '127.0.0.1';
const UPSTREAM = String(cfg.upstream || 'https://token-plan-cn.xiaomimimo.com/v1').replace(/\/+$/, '');
const LOG_PATH = process.env.MIMO_PROXY_LOG || path.join(__dirname, 'proxy.log');
const DEBUG_DUMP = process.env.DEBUG_DUMP === '1';

const MODEL_MAP = cfg.model_map || {};
const EFFORT_MAP = cfg.effort_map || {};
const DEFAULT_MODEL = cfg.default_model || null;

const MAX_SOCKETS = Number(cfg.max_sockets ?? 64);
const MAX_FREE_SOCKETS = Number(cfg.max_free_sockets ?? 16);
const KEEPALIVE_MSECS = Number(cfg.keep_alive_msecs ?? 30000);
const UPSTREAM_TIMEOUT_MS = Number(cfg.upstream_timeout_ms ?? 300000);
const SOCKET_WAIT_WARN_MS = Number(cfg.socket_wait_warn_ms ?? 1000);
const STATS_INTERVAL_MS = Number(cfg.stats_interval_ms ?? 30000);

const UPSTREAM_URL = new URL(UPSTREAM);
const IS_TLS = UPSTREAM_URL.protocol === 'https:';

// ─────────────────── 上游 Agent：显式、有界、可观测 ───────────────────
// maxSockets 足够大 + keepAlive 有限期 + socket 级超时。
// 卡死的 socket 会被超时销毁，不会永久占用池位。
const AgentImpl = IS_TLS ? https.Agent : http.Agent;
const agent = new AgentImpl({
  keepAlive: true,
  keepAliveMsecs: KEEPALIVE_MSECS,
  maxSockets: MAX_SOCKETS,
  maxFreeSockets: MAX_FREE_SOCKETS,
  scheduling: 'lifo',
  timeout: UPSTREAM_TIMEOUT_MS,
});

function agentStatus() {
  const count = (obj) =>
    Object.values(obj || {}).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0);
  const sockets = count(agent.sockets);
  const st = {
    sockets,
    freeSockets: count(agent.freeSockets),
    queuedRequests: count(agent.requests),
    maxSockets: agent.maxSockets,
  };
  st.utilization = st.maxSockets ? Number((sockets / st.maxSockets).toFixed(3)) : null;
  return st;
}

// ─────────────────────────── 指标 ───────────────────────────
const metrics = {
  startedAt: Date.now(),
  total: 0,
  inflight: 0,
  peakInflight: 0,
  warnings: 0,
  lastSocketWaitMs: 0,
  peakSocketWaitMs: 0,
  connects: 0,
  reusedConnections: 0,
  sinceStats: { total: 0, peakInflight: 0, peakSocketWaitMs: 0, connects: 0 },
};

function logLine(obj) {
  try {
    fs.appendFileSync(LOG_PATH, `${JSON.stringify(obj)}\n`);
  } catch {
    /* 日志不可写不应影响转发 */
  }
}

function warn(msg, extra = {}) {
  metrics.warnings += 1;
  const a = agentStatus();
  logLine({ ts: new Date().toISOString(), level: 'warn', msg, ...extra, agent: a });
  console.error(`[mimodex-proxy] WARN ${msg} ${JSON.stringify(extra)} agent=${JSON.stringify(a)}`);
}

// 周期性连接池快照：只有发生过流量才写，避免刷屏。
// 这是「之后还能不能观测到性能问题」的抓手 —— 关注 peakSocketWaitMs 与 queuedRequests。
setInterval(() => {
  const s = metrics.sinceStats;
  if (s.total === 0) return;
  logLine({
    ts: new Date().toISOString(),
    level: 'stats',
    windowMs: STATS_INTERVAL_MS,
    req: s.total,
    peakInflight: s.peakInflight,
    peakSocketWaitMs: s.peakSocketWaitMs,
    newConnects: s.connects,
    totalReq: metrics.total,
    warnings: metrics.warnings,
    agent: agentStatus(),
  });
  metrics.sinceStats = { total: 0, peakInflight: 0, peakSocketWaitMs: 0, connects: 0 };
}, STATS_INTERVAL_MS).unref();

// ─────────────────────── 请求体改写 ───────────────────────
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const GLOBS = Object.entries(cfg.model_map_globs || {}).map(([pat, target]) => [
  new RegExp(`^${pat.split('*').map(escapeRe).join('.*')}$`),
  target,
]);

function mapModel(m) {
  if (!m) return m;
  if (Object.prototype.hasOwnProperty.call(MODEL_MAP, m)) return MODEL_MAP[m];
  for (const [re, target] of GLOBS) if (re.test(m)) return target;
  if (DEFAULT_MODEL) return DEFAULT_MODEL;
  return m;
}

// 上游路径拼装。
// upstream 与 codex 的 base_url 同形（如 https://host/v1），而入站路径也以 /v1/ 开头；
// 用 https.request 时 hostname 与 path 是分开的，所以必须把 base path 显式拼回，
// 同时去掉入站路径里重复的那一层，否则会得到 /v1/v1/responses 或丢掉 /v1。
const UPSTREAM_BASE_PATH = UPSTREAM_URL.pathname.replace(/\/+$/, ''); // '' 或 '/v1'
function upstreamPath(pathname, search = '') {
  let p = pathname;
  if (UPSTREAM_BASE_PATH && p.startsWith(`${UPSTREAM_BASE_PATH}/`)) {
    p = p.slice(UPSTREAM_BASE_PATH.length);
  }
  return `${UPSTREAM_BASE_PATH}${p}${search}`;
}

/** 对 /v1/responses 的请求体做三重改写。 */
function rewrite(raw) {
  const meta = {};
  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return { raw, meta: { parseError: true } };
  }
  if (body === null || typeof body !== 'object') return { raw, meta: { parseError: true } };

  const origModel = body.model;
  const mapped = mapModel(origModel);
  if (mapped !== origModel) body.model = mapped;
  meta.origModel = origModel;
  meta.model = body.model;

  if (body.text && body.text.format && body.text.format.type === 'json_schema') {
    // 仅替换 format，保留 text 下其他键（如 verbosity）
    body.text = { ...body.text, format: { type: 'json_object' } };
    meta.fmtDowngrade = true;
  }

  const effortIn = body.reasoning && body.reasoning.effort;
  if (effortIn) {
    meta.effortIn = effortIn;
    if (EFFORT_MAP[effortIn]) {
      body.reasoning = { ...body.reasoning, effort: EFFORT_MAP[effortIn] };
      meta.effortOut = EFFORT_MAP[effortIn];
    } else {
      meta.effortOut = effortIn;
    }
  }

  meta.stream = !!body.stream;
  const out = Buffer.from(JSON.stringify(body), 'utf8');
  if (DEBUG_DUMP) {
    try {
      fs.appendFileSync(`${LOG_PATH}.bodies`, `${JSON.stringify({ ts: new Date().toISOString(), body })}\n`);
    } catch { /* ignore */ }
  }
  return { raw: out, meta };
}

// 逐跳首部不透传。accept-encoding 也去掉 —— 让上游返回未压缩正文，
// 省掉一整类解压/再压缩处理。
const REQ_STRIP = new Set([
  'host', 'content-length', 'connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
  'accept-encoding',
]);
const RES_STRIP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade']);

/**
 * 发起上游请求。返回 { req, meta, response }。
 * meta.socketWaitMs 是核心指标：从发起请求到拿到 socket 的等待时间。
 * 它变大 = 连接池拥堵 = 请求开始排队，正是本次故障的特征。
 */
function upstreamRequest({ method, path: p, headers, body }) {
  const t0 = Date.now();
  const meta = { socketWaitMs: null, connectMs: null, ttfbMs: null };

  const req = (IS_TLS ? https : http).request({
    protocol: UPSTREAM_URL.protocol,
    hostname: UPSTREAM_URL.hostname,
    port: UPSTREAM_URL.port || (IS_TLS ? 443 : 80),
    path: p,
    method,
    headers,
    agent,
  });

  req.on('socket', (socket) => {
    meta.socketWaitMs = Date.now() - t0;
    metrics.lastSocketWaitMs = meta.socketWaitMs;
    if (meta.socketWaitMs > metrics.peakSocketWaitMs) metrics.peakSocketWaitMs = meta.socketWaitMs;
    if (meta.socketWaitMs > metrics.sinceStats.peakSocketWaitMs) {
      metrics.sinceStats.peakSocketWaitMs = meta.socketWaitMs;
    }
    if (meta.socketWaitMs > SOCKET_WAIT_WARN_MS) {
      warn('socket wait exceeded threshold — 连接池可能拥堵', {
        path: p, socketWaitMs: meta.socketWaitMs, thresholdMs: SOCKET_WAIT_WARN_MS,
      });
    }
    if (socket.connecting) {
      metrics.connects += 1;
      metrics.sinceStats.connects += 1;
      const ev = IS_TLS ? 'secureConnect' : 'connect';
      socket.once(ev, () => { meta.connectMs = Date.now() - t0; });
    } else {
      metrics.reusedConnections += 1;
    }
  });

  const response = new Promise((resolve, reject) => {
    req.on('response', (r) => {
      meta.ttfbMs = Date.now() - t0;
      resolve(r);
    });
    req.on('error', reject);
    req.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      req.destroy(new Error(`upstream idle timeout after ${UPSTREAM_TIMEOUT_MS}ms`));
    });
  });

  req.end(body && body.length ? body : undefined);
  return { req, meta, response };
}

// ─────────────────────────── 服务 ───────────────────────────
const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      upstream: UPSTREAM,
      modelMap: Object.keys(MODEL_MAP).length,
      modelGlobs: GLOBS.length,
      effortMap: EFFORT_MAP,
      agent: agentStatus(),
      metrics: {
        uptimeSec: Math.round((Date.now() - metrics.startedAt) / 1000),
        total: metrics.total,
        inflight: metrics.inflight,
        peakInflight: metrics.peakInflight,
        lastSocketWaitMs: metrics.lastSocketWaitMs,
        peakSocketWaitMs: metrics.peakSocketWaitMs,
        newConnects: metrics.connects,
        reusedConnections: metrics.reusedConnections,
        warnings: metrics.warnings,
      },
    }));
    return;
  }

  if (!url.pathname.startsWith('/v1/')) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('mimodex-proxy: only /v1/* is proxied\n');
    return;
  }

  metrics.total += 1;
  metrics.sinceStats.total += 1;
  metrics.inflight += 1;
  if (metrics.inflight > metrics.peakInflight) metrics.peakInflight = metrics.inflight;
  if (metrics.inflight > metrics.sinceStats.peakInflight) {
    metrics.sinceStats.peakInflight = metrics.inflight;
  }

  let raw = Buffer.alloc(0);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    raw = Buffer.concat(chunks);
  }

  let meta = { path: url.pathname, method: req.method };
  if (req.method === 'POST' && url.pathname === '/v1/responses' && raw.length) {
    const r = rewrite(raw);
    raw = r.raw;
    meta = { ...meta, ...r.meta };
  }

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!REQ_STRIP.has(k.toLowerCase())) headers[k] = v;
  }
  if (raw.length) headers['content-length'] = String(raw.length);

  const { req: upReq, meta: upMeta, response } = upstreamRequest({
    method: req.method,
    path: upstreamPath(url.pathname, url.search),
    headers,
    body: raw,
  });

  // 客户端断开 → 销毁上游请求（socket 一并销毁，不回流到池里）
  res.on('close', () => {
    if (!res.writableEnded) upReq.destroy();
  });

  try {
    const upstreamRes = await response;

    const outHeaders = {};
    for (const [k, v] of Object.entries(upstreamRes.headers)) {
      if (!RES_STRIP.has(k.toLowerCase())) outHeaders[k] = v;
    }
    res.writeHead(upstreamRes.statusCode || 502, outHeaders);
    await pipeline(upstreamRes, res).catch(() => {});

    logLine({
      ts: new Date().toISOString(), ...meta,
      status: upstreamRes.statusCode,
      ms: Date.now() - t0,
      sockWaitMs: upMeta.socketWaitMs,
      connectMs: upMeta.connectMs,
      ttfbMs: upMeta.ttfbMs,
      inflight: metrics.inflight,
      agent: agentStatus(),
    });
  } catch (e) {
    logLine({
      ts: new Date().toISOString(), ...meta, status: 502,
      error: String((e && e.message) || e), ms: Date.now() - t0,
      sockWaitMs: upMeta.socketWaitMs, connectMs: upMeta.connectMs,
      inflight: metrics.inflight, agent: agentStatus(),
    });
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
    }
    if (!res.writableEnded) {
      res.end(JSON.stringify({
        error: { message: String((e && e.message) || e), type: 'mimodex_proxy_error' },
      }));
    }
  } finally {
    metrics.inflight -= 1;
  }
});

// 入站连接的空闲超时：避免半开连接堆积。requestTimeout=0 让流式长请求不被超时打断。
server.keepAliveTimeout = Number(cfg.server_keep_alive_timeout_ms ?? 65000);
server.headersTimeout = Number(cfg.server_headers_timeout_ms ?? 70000);
server.requestTimeout = 0;

server.listen(PORT, HOST, () => {
  console.error(`[mimodex-proxy] listening http://${HOST}:${PORT}  ->  ${UPSTREAM}`);
  console.error(`[mimodex-proxy] model_map=${Object.keys(MODEL_MAP).length} globs=${GLOBS.length} effort_map=${JSON.stringify(EFFORT_MAP)}`);
  console.error(`[mimodex-proxy] agent maxSockets=${MAX_SOCKETS} maxFreeSockets=${MAX_FREE_SOCKETS} keepAliveMsecs=${KEEPALIVE_MSECS} timeout=${UPSTREAM_TIMEOUT_MS}ms`);
  console.error(`[mimodex-proxy] log=${LOG_PATH} (stats every ${STATS_INTERVAL_MS}ms)`);
  logLine({
    ts: new Date().toISOString(), level: 'start',
    upstream: UPSTREAM, maxSockets: MAX_SOCKETS, keepAliveMsecs: KEEPALIVE_MSECS,
    upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS, statsIntervalMs: STATS_INTERVAL_MS,
  });
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    logLine({ ts: new Date().toISOString(), level: 'stop', total: metrics.total, agent: agentStatus() });
    agent.destroy();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
