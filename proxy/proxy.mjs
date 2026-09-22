#!/usr/bin/env node
/**
 * mimo-proxy — Codex Responses 适配代理
 *
 * 定位：透明反向代理 + 三个请求体改写。不做任何协议翻译。
 *
 *   ① body.model             别名映射（精确 → glob → 原样透传）
 *   ② body.text.format.type  json_schema → json_object（MiMo 不支持 json_schema，
 *                            而 guardian 审查依赖结构化输出，故降级）
 *   ③ body.reasoning.effort  序数 clamp（max/xhigh → high，minimal → low）
 *
 * 设计约束（均由实测得出，勿随意改动）：
 *   - 请求体可达 57KB+，完整读取，勿设小上限
 *   - codex 发 stream:true 并期望真 SSE：必须逐块透传、不可缓冲
 *   - 失败会被 codex 重试 5 次：本代理必须无副作用
 *   - 上游错误必须原样透传状态码与 body，否则排查无从下手
 *   - 允许 JSON.parse → JSON.stringify（完整保留未知字段）；
 *     禁止白名单式字段重建
 *
 * 用法：node proxy.mjs        （前台运行，便于调试）
 *       mimo-proxy start      （后台运行，见同目录 CLI）
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG_PATH = process.env.MIMO_PROXY_CONFIG || path.join(__dirname, 'config.json');
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
  console.error(`[mimo-proxy] 无法读取配置 ${CONFIG_PATH}: ${e.message}`);
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

// 上游路径归一化。
// config 里的 upstream 与 codex 的 base_url 同形（都以 /v1 结尾），而进来的路径
// 也以 /v1/ 开头，直接拼接会得到 /v1/v1/responses。若 upstream 已带 /v1，
// 就把入站路径上的 /v1 去掉一层；否则原样拼接（兼容 upstream 只写到 origin 的配法）。
const UPSTREAM_HAS_V1 = /\/v1$/i.test(UPSTREAM);
function upstreamUrl(pathname, search = '') {
  let p = pathname;
  if (UPSTREAM_HAS_V1 && /^\/v1(\/|$)/i.test(p)) p = p.replace(/^\/v1/i, '');
  return `${UPSTREAM}${p}${search}`;
}

function logLine(obj) {
  try {
    fs.appendFileSync(LOG_PATH, `${JSON.stringify(obj)}\n`);
  } catch {
    /* 日志不可写不应影响转发 */
  }
}

// 逐跳首部 + 需要剥离的响应首部。
// content-encoding/content-length 必须去掉：undici 已解压响应体，保留会导致内容错乱。
const REQ_STRIP = new Set([
  'host', 'content-length', 'connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
const RES_STRIP = new Set([
  'content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive',
]);

/** 对 /v1/responses 的请求体做三重改写。返回 { body, meta }。 */
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
    }));
    return;
  }

  if (!url.pathname.startsWith('/v1/')) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('mimo-proxy: only /v1/* is proxied\n');
    return;
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

  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });

  try {
    const upstream = await fetch(upstreamUrl(url.pathname, url.search), {
      method: req.method,
      headers,
      body: raw.length ? raw : undefined,
      signal: ac.signal,
    });

    const outHeaders = {};
    upstream.headers.forEach((v, k) => {
      if (!RES_STRIP.has(k.toLowerCase())) outHeaders[k] = v;
    });
    res.writeHead(upstream.status, outHeaders);

    if (upstream.body) {
      await pipeline(Readable.fromWeb(upstream.body), res).catch(() => {});
    } else {
      res.end();
    }
    logLine({ ts: new Date().toISOString(), ...meta, status: upstream.status, ms: Date.now() - t0 });
  } catch (e) {
    const aborted = ac.signal.aborted;
    const status = aborted ? 499 : 502;
    logLine({
      ts: new Date().toISOString(), ...meta, status,
      error: String((e && e.message) || e), ms: Date.now() - t0,
    });
    if (!res.headersSent) {
      res.writeHead(status, { 'content-type': 'application/json' });
    }
    if (!res.writableEnded) {
      res.end(JSON.stringify({
        error: {
          message: aborted ? 'client closed request' : String((e && e.message) || e),
          type: 'mimo_proxy_error',
        },
      }));
    }
  }
});

server.listen(PORT, HOST, () => {
  console.error(`[mimo-proxy] listening http://${HOST}:${PORT}  ->  ${UPSTREAM}`);
  console.error(`[mimo-proxy] model_map=${Object.keys(MODEL_MAP).length} globs=${GLOBS.length} effort_map=${JSON.stringify(EFFORT_MAP)}`);
  console.error(`[mimo-proxy] log=${LOG_PATH}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
