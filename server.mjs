import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const host = process.env.HOST || '0.0.0.0';
const port = process.env.PORT || 4173;
const openRouterSpeechUrl = 'https://openrouter.ai/api/v1/audio/speech';
const openRouterVideoUrl = process.env.OPENROUTER_VIDEO_URL || 'https://openrouter.ai/api/v1/videos';
const defaultSpeechModel = 'mistralai/voxtral-mini-tts-3-0';
const speechModelAliases = new Map([
  ['mistralai/voxtral-tts', defaultSpeechModel],
  ['voxtral-tts', defaultSpeechModel],
]);
const maxBodyBytes = 80 * 1024 * 1024;
const maxAudioBytes = 12 * 1024 * 1024;
const maxImageReferenceBytes = 10 * 1024 * 1024;
const maxVideoReferenceBytes = 24 * 1024 * 1024;
const maxSpeechCharacters = 32000;
const maxTranscriptCharacters = 10000;
const maxVideoPromptCharacters = 32000;

const mime = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
}));

function resolveSafe(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const segments = decoded.split('/').filter(Boolean);
  if (segments.includes('..')) return null;
  if (segments.some((s) => s.startsWith('.') || s === 'server.mjs' || s === 'package.json' || s === 'package-lock.json')) {
    return null;
  }
  const normalized = path.posix.normalize(decoded);
  const absolute = path.join(root, normalized);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return absolute;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > maxBodyBytes) {
        tooLarge = true;
        reject(Object.assign(new Error('Request body is too large (80 MB limit).'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function normalizeAudioSample(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const sample = value.trim();
  const dataUrl = sample.startsWith('data:') ? sample : `data:audio/wav;base64,${sample}`;
  const match = /^data:audio\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!match) throw Object.assign(new Error('audioSample must be an audio data URL or base64 audio.'), { status: 400 });
  const bytes = Buffer.byteLength(match[1].replace(/\s/g, ''), 'base64');
  if (!bytes) throw Object.assign(new Error('audioSample is empty.'), { status: 400 });
  if (bytes > maxAudioBytes) throw Object.assign(new Error('Audio sample is too large (12 MB limit).'), { status: 413 });
  return dataUrl;
}

function dataUrlBytes(value) {
  const comma = value.indexOf(',');
  if (!value.startsWith('data:') || comma === -1) return null;
  const payload = value.slice(comma + 1).replace(/\s/g, '');
  if (!payload) return 0;
  return Buffer.byteLength(payload, 'base64');
}

function normalizeVideoReferences(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw Object.assign(new Error('input_references must be an array.'), { status: 400 });
  }
  if (value.length > 8) {
    throw Object.assign(new Error('At most 8 input references are supported.'), { status: 400 });
  }
  const limits = {
    image_url: { prefix: 'data:image/', bytes: maxImageReferenceBytes, label: 'Image' },
    video_url: { prefix: 'data:video/', bytes: maxVideoReferenceBytes, label: 'Video' },
    audio_url: { prefix: 'data:audio/', bytes: maxAudioBytes, label: 'Audio' },
  };
  return value.map((reference) => {
    const type = reference && typeof reference.type === 'string' ? reference.type : '';
    const rule = limits[type];
    if (!rule) {
      throw Object.assign(new Error('input_references entries must be image_url, video_url, or audio_url.'), { status: 400 });
    }
    const url = reference?.[type]?.url;
    if (typeof url !== 'string' || !url.trim()) {
      throw Object.assign(new Error(`${rule.label} reference URL is required.`), { status: 400 });
    }
    const normalized = url.trim();
    if (!normalized.startsWith(rule.prefix)) {
      throw Object.assign(new Error(`${rule.label} references must use a ${rule.prefix.slice(5, -1)} data URL.`), { status: 400 });
    }
    const bytes = dataUrlBytes(normalized);
    if (bytes === null || !bytes) {
      throw Object.assign(new Error(`${rule.label} reference is not valid base64 data.`), { status: 400 });
    }
    if (bytes > rule.bytes) {
      throw Object.assign(new Error(`${rule.label} reference is too large (${Math.floor(rule.bytes / 1024 / 1024)} MB limit).`), { status: 413 });
    }
    return { type, [type]: { url: normalized } };
  });
}

async function handleVideo(req, res) {
  const authorization = req.headers.authorization || '';
  const requestKey = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const apiKey = process.env.OPENROUTER_API_KEY || requestKey;
  if (!apiKey) {
    sendJson(res, 401, { error: { message: 'OpenRouter API key is required.' } });
    return;
  }

  let payload;
  try {
    payload = await readJson(req);
  } catch (error) {
    sendJson(res, error.status || 400, { error: { message: error.message || 'Invalid request.' } });
    return;
  }

  const model = typeof payload.model === 'string' ? payload.model.trim() : '';
  if (!model || model.length > 200) {
    sendJson(res, 400, { error: { message: 'model is required.' } });
    return;
  }
  const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
  if (!prompt) {
    sendJson(res, 400, { error: { message: 'prompt is required.' } });
    return;
  }
  if (prompt.length > maxVideoPromptCharacters) {
    sendJson(res, 413, { error: { message: `prompt must be ${maxVideoPromptCharacters} characters or fewer.` } });
    return;
  }

  const body = { model, prompt };
  if (payload.duration !== undefined) {
    const duration = Number(payload.duration);
    if (!Number.isInteger(duration) || duration < 1 || duration > 60) {
      sendJson(res, 400, { error: { message: 'duration must be an integer from 1 to 60 seconds.' } });
      return;
    }
    body.duration = duration;
  }
  if (payload.resolution !== undefined) {
    const resolution = typeof payload.resolution === 'string' ? payload.resolution.trim() : '';
    if (!/^(?:\d{3,4}p|4K)$/i.test(resolution)) {
      sendJson(res, 400, { error: { message: 'resolution must be a value such as 480p, 720p, 1080p, or 4K.' } });
      return;
    }
    body.resolution = resolution;
  }
  if (payload.aspect_ratio !== undefined) {
    const aspectRatio = typeof payload.aspect_ratio === 'string' ? payload.aspect_ratio.trim() : '';
    if (!/^\d{1,2}:\d{1,2}$/.test(aspectRatio)) {
      sendJson(res, 400, { error: { message: 'aspect_ratio must look like 16:9, 9:16, or 1:1.' } });
      return;
    }
    body.aspect_ratio = aspectRatio;
  }
  if (payload.generate_audio !== undefined) {
    body.generate_audio = payload.generate_audio === true;
  }
  try {
    const references = normalizeVideoReferences(payload.input_references);
    if (references.length) body.input_references = references;
  } catch (error) {
    sendJson(res, error.status || 400, { error: { message: error.message } });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  let upstream;
  let raw = '';
  try {
    upstream = await fetch(openRouterVideoUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': req.headers.origin || `http://${req.headers.host || 'localhost'}`,
        'X-Title': 'OURCHAT'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    raw = await upstream.text();
  } catch (error) {
    const message = error.name === 'AbortError'
      ? 'OpenRouter video request timed out.'
      : `Could not reach OpenRouter (${error.message || 'network error'}).`;
    sendJson(res, 502, { error: { message } });
    return;
  } finally {
    clearTimeout(timeout);
  }

  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {}
  if (!upstream.ok) {
    const message = parsed?.error?.message || parsed?.message || raw.slice(0, 1000) || `OpenRouter returned ${upstream.status}.`;
    sendJson(res, upstream.status, { error: { message } });
    return;
  }
  if (!parsed || typeof parsed !== 'object') {
    sendJson(res, 502, { error: { message: 'OpenRouter returned an invalid video response.' } });
    return;
  }
  sendJson(res, upstream.status, parsed);
}

async function handleSpeech(req, res) {
  const authorization = req.headers.authorization || '';
  const requestKey = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const apiKey = process.env.OPENROUTER_API_KEY || requestKey;
  if (!apiKey) {
    sendJson(res, 401, { error: { message: 'OpenRouter API key is required.' } });
    return;
  }

  let payload;
  try {
    payload = await readJson(req);
  } catch (error) {
    sendJson(res, error.status || 400, { error: { message: error.message || 'Invalid request.' } });
    return;
  }

  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) {
    sendJson(res, 400, { error: { message: 'text is required.' } });
    return;
  }
  if (text.length > maxSpeechCharacters) {
    sendJson(res, 413, { error: { message: `text must be ${maxSpeechCharacters} characters or fewer.` } });
    return;
  }

  let audioSample = '';
  try {
    audioSample = normalizeAudioSample(payload.audioSample);
  } catch (error) {
    sendJson(res, error.status || 400, { error: { message: error.message } });
    return;
  }

  const transcript = typeof payload.transcript === 'string' ? payload.transcript.trim() : '';
  if (transcript.length > maxTranscriptCharacters) {
    sendJson(res, 413, { error: { message: `transcript must be ${maxTranscriptCharacters} characters or fewer.` } });
    return;
  }

  const requestedModel = typeof payload.model === 'string' && payload.model.trim()
    ? payload.model.trim()
    : defaultSpeechModel;
  const model = speechModelAliases.get(requestedModel) || requestedModel;
  const responseFormat = typeof payload.response_format === 'string' && payload.response_format.trim()
    ? payload.response_format.trim()
    : 'mp3';

  const body = { model, input: text, response_format: responseFormat };
  if (typeof payload.voice === 'string' && payload.voice.trim()) body.voice = payload.voice.trim();
  if (typeof payload.instructions === 'string' && payload.instructions.trim()) body.instructions = payload.instructions.trim();
  const speed = Number(payload.speed);
  if (Number.isFinite(speed) && speed >= 0.5 && speed <= 2) body.speed = speed;
  if (audioSample) {
    body.input_references = [{ type: 'input_audio', input_audio: { data: audioSample } }];
    if (transcript) body.input_references.push({ type: 'text', text: transcript });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  let upstream;
  try {
    upstream = await fetch(openRouterSpeechUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': req.headers.origin || `http://${req.headers.host || 'localhost'}`,
        'X-Title': 'OURCHAT'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timeout);
    const message = error.name === 'AbortError'
      ? 'OpenRouter speech request timed out.'
      : `Could not reach OpenRouter (${error.message || 'network error'}).`;
    sendJson(res, 502, { error: { message } });
    return;
  }
  clearTimeout(timeout);

  if (!upstream.ok) {
    const raw = await upstream.text().catch(() => '');
    let message = raw.slice(0, 1000);
    try {
      const parsed = JSON.parse(raw);
      message = parsed?.error?.message || parsed?.message || message;
    } catch {}
    sendJson(res, upstream.status, { error: { message: message || `OpenRouter returned ${upstream.status}.` } });
    return;
  }

  const contentType = upstream.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const raw = await upstream.text().catch(() => '');
    let message = 'OpenRouter returned no audio.';
    try {
      const parsed = JSON.parse(raw);
      message = parsed?.error?.message || parsed?.message || message;
    } catch {}
    sendJson(res, 502, { error: { message } });
    return;
  }

  const audio = Buffer.from(await upstream.arrayBuffer());
  if (!audio.length) {
    sendJson(res, 502, { error: { message: 'OpenRouter returned an empty audio file.' } });
    return;
  }

  res.writeHead(200, {
    'Content-Type': contentType || 'audio/mpeg',
    'Content-Length': audio.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(audio);
}

async function sendFile(res, filePath, status = 200) {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error('not a file');
  const type = mime.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': info.size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || '/').split('?')[0].split('#')[0] || '/';

  if (urlPath === '/api/tts' || urlPath === '/api/videos') {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { Allow: 'POST, OPTIONS' });
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST, OPTIONS', 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }
    if (urlPath === '/api/videos') await handleVideo(req, res);
    else await handleSpeech(req, res);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }

  const target = resolveSafe(urlPath);

  if (!target) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  try {
    const info = await stat(target);
    if (info.isDirectory()) {
      await sendFile(res, path.join(target, 'index.html'));
      return;
    }
    await sendFile(res, target);
  } catch {
    if (path.extname(urlPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    try {
      await sendFile(res, path.join(root, 'index.html'));
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    }
  }
});

server.listen(port, host, () => {
  console.log(`OURCHAT running at http://${host}:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
