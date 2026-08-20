import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObsUnavailableError } from './obs-controller.js';

const DEFAULT_PUBLIC_DIR = resolve(fileURLToPath(new URL('../public', import.meta.url)));
const MAX_BODY_BYTES = 16 * 1024;
const TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
]);

class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function securityHeaders(response) {
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function json(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.end(body);
}

function bearer(request) {
  const header = request.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice('Bearer '.length).trim()
    : null;
}

function digest(value) {
  return createHash('sha256').update(value).digest();
}

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'BODY_TOO_LARGE', 'リクエスト本文が大きすぎます');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'INVALID_JSON', 'JSONの形式が正しくありません'); }
}

function boolean(value, name) {
  if (typeof value !== 'boolean') throw new HttpError(400, 'INVALID_REQUEST', `${name}は真偽値で指定してください`);
  return value;
}

function string(value, name) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 256) {
    throw new HttpError(400, 'INVALID_REQUEST', `${name}は1〜256文字の文字列で指定してください`);
  }
  return value;
}

function serveStatic(request, response, publicDirectory, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;

  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch { throw new HttpError(400, 'INVALID_PATH', 'URLの形式が正しくありません'); }
  if (decoded.includes('\0')) throw new HttpError(400, 'INVALID_PATH', 'URLの形式が正しくありません');

  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const filePath = resolve(publicDirectory, relative);
  if (filePath !== publicDirectory && !filePath.startsWith(`${publicDirectory}${sep}`)) return false;

  let stats;
  try { stats = statSync(filePath); } catch { return false; }
  if (!stats.isFile()) return false;

  response.statusCode = 200;
  response.setHeader('Content-Type', TYPES.get(extname(filePath)) ?? 'application/octet-stream');
  response.setHeader('Content-Length', stats.size);
  response.setHeader('Cache-Control', extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=3600');
  if (request.method === 'HEAD') response.end();
  else createReadStream(filePath).pipe(response);
  return true;
}

export function createHttpServer({ controller, remoteControlToken, publicDirectory = DEFAULT_PUBLIC_DIR, logger = console }) {
  const expectedToken = digest(remoteControlToken);

  return createServer(async (request, response) => {
    securityHeaders(response);

    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const path = url.pathname;

      if (path === '/api/health') {
        if (request.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'このメソッドは使用できません');
        return json(response, 200, { ok: true, obsConnected: Boolean(controller.connected) });
      }

      if (path.startsWith('/api/')) {
        const token = bearer(request);
        if (!token || !timingSafeEqual(digest(token), expectedToken)) {
          response.setHeader('WWW-Authenticate', 'Bearer');
          throw new HttpError(401, 'UNAUTHORIZED', '操作トークンが正しくありません');
        }

        if (path === '/api/state' && request.method === 'GET') {
          return json(response, 200, await controller.getState());
        }
        if (path === '/api/stream' && request.method === 'POST') {
          const input = await body(request);
          return json(response, 200, { ok: true, result: await controller.setStreaming(boolean(input.active, 'active')) });
        }
        if (path === '/api/scene' && request.method === 'POST') {
          const input = await body(request);
          return json(response, 200, { ok: true, result: await controller.setCurrentScene(string(input.sceneName, 'sceneName')) });
        }
        if (path === '/api/input-mute' && request.method === 'POST') {
          const input = await body(request);
          return json(response, 200, {
            ok: true,
            result: await controller.setInputMute(string(input.inputName, 'inputName'), boolean(input.muted, 'muted')),
          });
        }
        if (path === '/api/obs/reconnect' && request.method === 'POST') {
          await body(request);
          await controller.reconnect();
          return json(response, 200, { ok: true });
        }
        throw new HttpError(404, 'NOT_FOUND', 'APIが見つかりません');
      }

      if (serveStatic(request, response, publicDirectory, path)) return;
      throw new HttpError(404, 'NOT_FOUND', 'ページが見つかりません');
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof HttpError) {
        return json(response, error.statusCode, { error: { code: error.code, message: error.message } });
      }
      if (error instanceof ObsUnavailableError) {
        return json(response, 503, { error: { code: error.code, message: error.message } });
      }
      logger.error?.('[http] request failed', error);
      return json(response, 502, {
        error: {
          code: 'OBS_REQUEST_FAILED',
          message: error instanceof Error ? error.message : 'OBS操作に失敗しました',
        },
      });
    }
  });
}
