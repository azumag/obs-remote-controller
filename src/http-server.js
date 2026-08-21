import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObsUnavailableError } from './obs-controller.js';
import { OverlayController } from './overlay-controller.js';

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
const OVERLAY_POSITIONS = new Set(['top', 'center', 'bottom']);
const OVERLAY_ANIMATIONS = new Set(['fade', 'none']);

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
  const content = JSON.stringify(value);
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Length', Buffer.byteLength(content));
  response.end(content);
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

function overlayPatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'INVALID_REQUEST', 'オーバーレイ設定はJSONオブジェクトで指定してください');
  }

  const patch = {};
  if ('visible' in input) patch.visible = boolean(input.visible, 'visible');
  if ('text' in input) {
    if (typeof input.text !== 'string' || input.text.length > 500) {
      throw new HttpError(400, 'INVALID_REQUEST', 'textは500文字以内の文字列で指定してください');
    }
    patch.text = input.text;
  }
  if ('position' in input) {
    if (!OVERLAY_POSITIONS.has(input.position)) {
      throw new HttpError(400, 'INVALID_REQUEST', 'positionはtop、center、bottomのいずれかで指定してください');
    }
    patch.position = input.position;
  }
  if ('fontSize' in input) {
    if (!Number.isInteger(input.fontSize) || input.fontSize < 18 || input.fontSize > 180) {
      throw new HttpError(400, 'INVALID_REQUEST', 'fontSizeは18〜180の整数で指定してください');
    }
    patch.fontSize = input.fontSize;
  }
  if ('color' in input) {
    if (typeof input.color !== 'string' || !/^#[0-9a-f]{6}$/iu.test(input.color)) {
      throw new HttpError(400, 'INVALID_REQUEST', 'colorは#RRGGBB形式で指定してください');
    }
    patch.color = input.color.toLowerCase();
  }
  if ('background' in input) patch.background = boolean(input.background, 'background');
  if ('animation' in input) {
    if (!OVERLAY_ANIMATIONS.has(input.animation)) {
      throw new HttpError(400, 'INVALID_REQUEST', 'animationはfadeまたはnoneで指定してください');
    }
    patch.animation = input.animation;
  }
  if ('durationMs' in input) {
    if (!Number.isInteger(input.durationMs) || input.durationMs < 0 || input.durationMs > 600_000) {
      throw new HttpError(400, 'INVALID_REQUEST', 'durationMsは0〜600000の整数で指定してください');
    }
    patch.durationMs = input.durationMs;
  }

  if (Object.keys(patch).length === 0) {
    throw new HttpError(400, 'INVALID_REQUEST', '変更するオーバーレイ設定を指定してください');
  }
  return patch;
}

function serveStatic(request, response, publicDirectory, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;

  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch { throw new HttpError(400, 'INVALID_PATH', 'URLの形式が正しくありません'); }
  if (decoded.includes('\0')) throw new HttpError(400, 'INVALID_PATH', 'URLの形式が正しくありません');

  let relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  if (relative.endsWith('/')) relative += 'index.html';
  const filePath = resolve(publicDirectory, relative);
  if (filePath !== publicDirectory && !filePath.startsWith(`${publicDirectory}${sep}`)) return false;

  let stats;
  try { stats = statSync(filePath); } catch { return false; }
  if (!stats.isFile()) return false;

  const noCache = extname(filePath) === '.html' || relative.startsWith('overlay/');
  response.statusCode = 200;
  response.setHeader('Content-Type', TYPES.get(extname(filePath)) ?? 'application/octet-stream');
  response.setHeader('Content-Length', stats.size);
  response.setHeader('Cache-Control', noCache ? 'no-cache' : 'public, max-age=3600');
  if (request.method === 'HEAD') response.end();
  else createReadStream(filePath).pipe(response);
  return true;
}

function serveOverlayEvents(request, response, overlayController) {
  if (request.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'このメソッドは使用できません');
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.flushHeaders?.();

  const sendState = (state) => {
    if (!response.destroyed && !response.writableEnded) {
      response.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
    }
  };
  const close = () => {
    cleanup();
    if (!response.writableEnded) response.end();
  };
  const keepAlive = setInterval(() => {
    if (!response.destroyed && !response.writableEnded) response.write(': keepalive\n\n');
  }, 15_000);
  keepAlive.unref?.();

  const cleanup = () => {
    clearInterval(keepAlive);
    overlayController.off('state', sendState);
    overlayController.off('close', close);
  };
  overlayController.on('state', sendState);
  overlayController.on('close', close);
  request.on('close', cleanup);

  response.write('retry: 2000\n\n');
  sendState(overlayController.getState());
}

export function createHttpServer({
  controller,
  remoteControlToken,
  overlayController = new OverlayController(),
  publicDirectory = DEFAULT_PUBLIC_DIR,
  logger = console,
}) {
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

      if (path === '/overlay/events') {
        return serveOverlayEvents(request, response, overlayController);
      }

      if (path.startsWith('/api/')) {
        const token = bearer(request);
        if (!token || !timingSafeEqual(digest(token), expectedToken)) {
          response.setHeader('WWW-Authenticate', 'Bearer');
          throw new HttpError(401, 'UNAUTHORIZED', '操作トークンが正しくありません');
        }

        if (path === '/api/state' && request.method === 'GET') {
          return json(response, 200, {
            ...(await controller.getState()),
            overlay: overlayController.getState(),
          });
        }
        if (path === '/api/overlay' && request.method === 'GET') {
          return json(response, 200, overlayController.getState());
        }
        if (path === '/api/overlay' && request.method === 'PUT') {
          const input = await body(request);
          return json(response, 200, { ok: true, result: overlayController.update(overlayPatch(input)) });
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
