import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const host = process.env.HOST || '0.0.0.0';
const port = process.env.PORT || 4173;
const openRouterSpeechUrl = process.env.OPENROUTER_SPEECH_URL || 'https://openrouter.ai/api/v1/audio/speech';
const openRouterVideoUrl = process.env.OPENROUTER_VIDEO_URL || 'https://openrouter.ai/api/v1/videos';
const openRouterImageUrl = process.env.OPENROUTER_IMAGE_URL || 'https://openrouter.ai/api/v1/images';
const openRouterChatUrl = process.env.OPENROUTER_CHAT_URL || 'https://openrouter.ai/api/v1/chat/completions';
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
const maxCinematicClips = 6;
const maxCinematicClipBytes = 24 * 1024 * 1024;
const maxCinematicClipTotalBytes = 36 * 1024 * 1024;
const maxWardrobePromptCharacters = 4000;

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

function normalizeImageSample(value, label = 'Outfit reference') {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') {
    throw Object.assign(new Error(`${label} must be an image data URL.`), { status: 400 });
  }
  const sample = value.trim();
  if (!sample) return '';
  if (/^https?:\/\/[^\s]+$/i.test(sample)) {
    if (sample.length > 2048) {
      throw Object.assign(new Error(`${label} URL is too long.`), { status: 400 });
    }
    return sample;
  }
  const match = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$/i.exec(sample);
  if (!match) {
    throw Object.assign(new Error(`${label} must be an image data URL.`), { status: 400 });
  }
  const bytes = Buffer.byteLength(match[1].replace(/\s/g, ''), 'base64');
  if (!bytes) {
    throw Object.assign(new Error(`${label} is empty.`), { status: 400 });
  }
  if (bytes > maxImageReferenceBytes) {
    throw Object.assign(new Error(`${label} is too large (${Math.floor(maxImageReferenceBytes / 1024 / 1024)} MB limit).`), { status: 413 });
  }
  return sample;
}

function cinematicClipName(value, index) {
  const name = typeof value === 'string' ? value.trim().replace(/[\r\n\t]+/g, ' ') : '';
  return (name || `clip-${index + 1}.mp4`).slice(0, 200);
}

function normalizeCinematicClips(value) {
  if (!Array.isArray(value) || !value.length) {
    throw Object.assign(new Error('At least one reference video clip is required.'), { status: 400 });
  }
  if (value.length > maxCinematicClips) {
    throw Object.assign(new Error(`At most ${maxCinematicClips} reference clips are supported.`), { status: 400 });
  }
  let total = 0;
  const clips = value.map((clip, index) => {
    const data = typeof clip?.data === 'string' ? clip.data.trim() : '';
    if (!data) throw Object.assign(new Error(`Reference clip ${index + 1} is empty.`), { status: 400 });
    const match = /^data:video\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$/i.exec(data);
    if (!match) {
      throw Object.assign(new Error(`Reference clip ${index + 1} must be a video data URL.`), { status: 400 });
    }
    const bytes = Buffer.byteLength(match[1].replace(/\s/g, ''), 'base64');
    if (!bytes) throw Object.assign(new Error(`Reference clip ${index + 1} is empty.`), { status: 400 });
    if (bytes > maxCinematicClipBytes) {
      throw Object.assign(new Error(`Reference clip ${index + 1} is too large (24 MB limit).`), { status: 413 });
    }
    total += bytes;
    const type = (typeof clip.type === 'string' && /^video\/[a-z0-9.+-]+$/i.test(clip.type.trim()))
      ? clip.type.trim()
      : data.slice(5, data.indexOf(';'));
    return { name: cinematicClipName(clip.name, index), type, bytes, data };
  });
  if (total > maxCinematicClipTotalBytes) {
    throw Object.assign(new Error('Reference clips total more than the 36 MB cinematic limit.'), { status: 413 });
  }
  return clips;
}

function cinematicMessageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('');
  }
  return '';
}

function cleanCinematicScript(value) {
  return String(value || '')
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/```/g, '')
    .replace(/\r/g, '')
    .replace(/^\s*(voiceover|voice-over|script|narration)\s*:\s*/i, '')
    .trim()
    .slice(0, maxSpeechCharacters);
}

function cinematicRequestKey(req) {
  const authorization = req.headers.authorization || '';
  const requestKey = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  return process.env.OPENROUTER_API_KEY || requestKey;
}

function cinematicHeaders(apiKey, req) {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'HTTP-Referer': req.headers.origin || `http://${req.headers.host || 'localhost'}`,
    'X-Title': 'OURCHAT'
  };
}

async function cinematicScript({ apiKey, req, model, prompt, duration, resolution, aspectRatio, clips, referenceFrame }) {
  const system = [
    'You are a senior real estate copywriter and voiceover director.',
    'Write one continuous, broadcast-ready voiceover script for a cinematic real estate film.',
    'Rules: plain text only; no scene headings, shot lists, timestamps, markdown, or speaker labels.',
    'Use 2-4 short paragraphs, a warm, confident, premium tone, and vivid but grounded language.',
    'Describe the feeling of the property, natural light, architecture, and lifestyle.',
    'When a reference frame is provided, ground the visual details in what it actually shows.',
    'End with a clear, elegant call to action.',
    `Pace the read for roughly ${Math.round(Number(duration) * 2.2)} words over ${duration} seconds.`,
    'Output only the finished script.'
  ].join(' ');
  const clipNames = clips.map((clip) => clip.name).join(', ');
  const user = [
    `Cinematic brief: ${prompt}`,
    `Reference clips: ${clipNames}`,
    referenceFrame ? 'A still frame from the first reference clip is attached.' : '',
    `Runtime: ${duration} seconds at ${resolution}, ${aspectRatio}.`,
    'Write the voiceover script now.'
  ].filter(Boolean).join('\n');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  let upstream;
  let raw = '';
  try {
    upstream = await fetch(openRouterChatUrl, {
      method: 'POST',
      headers: cinematicHeaders(apiKey, req),
      body: JSON.stringify({
        model,
        temperature: 0.7,
        max_tokens: 900,
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: referenceFrame
              ? [
                  { type: 'text', text: user },
                  { type: 'image_url', image_url: { url: referenceFrame } }
                ]
              : user
          }
        ]
      }),
      signal: controller.signal
    });
    raw = await upstream.text();
  } catch (error) {
    const message = error.name === 'AbortError'
      ? 'The voiceover script request timed out.'
      : `Could not reach OpenRouter (${error.message || 'network error'}).`;
    throw Object.assign(new Error(message), { status: 502 });
  } finally {
    clearTimeout(timeout);
  }

  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {}
  if (!upstream.ok) {
    const message = parsed?.error?.message || parsed?.message || raw.slice(0, 1000) || `OpenRouter returned ${upstream.status}.`;
    throw Object.assign(new Error(message), { status: upstream.status || 502 });
  }
  const script = cleanCinematicScript(cinematicMessageText(parsed?.choices?.[0]?.message));
  if (!script) throw Object.assign(new Error('The script model returned no voiceover text.'), { status: 502 });
  return script;
}

async function cinematicSpeech({ apiKey, req, model, text, voice, instructions, speed, audioSample, transcript }) {
  const body = { model, input: text, response_format: 'mp3' };
  if (voice) body.voice = voice;
  if (instructions) body.instructions = instructions;
  if (speed) body.speed = speed;
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
      headers: cinematicHeaders(apiKey, req),
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    const message = error.name === 'AbortError'
      ? 'The voiceover request timed out.'
      : `Could not reach OpenRouter (${error.message || 'network error'}).`;
    throw Object.assign(new Error(message), { status: 502 });
  } finally {
    clearTimeout(timeout);
  }

  const contentType = upstream.headers.get('content-type') || '';
  if (!upstream.ok || contentType.includes('application/json')) {
    const raw = await upstream.text().catch(() => '');
    let message = raw.slice(0, 1000);
    try {
      const parsed = JSON.parse(raw);
      message = parsed?.error?.message || parsed?.message || message;
    } catch {}
    throw Object.assign(new Error(message || `OpenRouter returned ${upstream.status}.`), {
      status: upstream.ok ? 502 : upstream.status
    });
  }
  const audio = Buffer.from(await upstream.arrayBuffer());
  if (!audio.length) throw Object.assign(new Error('OpenRouter returned an empty voiceover file.'), { status: 502 });
  return { audio, contentType: contentType || 'audio/mpeg' };
}

function cinematicWardrobePrompt(prompt, direction) {
  const detail = String(direction || '').trim();
  const brief = String(prompt || '').trim();
  return [
    'Edit the first reference image into a photorealistic cinematic still for a premium real estate film.',
    'Keep the exact scene, camera angle, architecture, lighting, color grade, and composition of the first reference image.',
    'Keep the person in the first reference image: preserve their identity, face, hair, pose, body shape, and expression exactly.',
    'Replace only their clothing with the outfit shown in the second reference image. Match the fabric, color, fit, and styling precisely, with natural folds, shadows, and reflections.',
    'Do not add or remove people, furniture, text, captions, logos, or watermarks. Do not restyle the room.',
    detail ? `Wardrobe direction: ${detail}` : '',
    brief ? `Scene context: ${brief}` : '',
    'Output a single high-quality still.'
  ].filter(Boolean).join('\n').slice(0, maxWardrobePromptCharacters);
}

async function cinematicWardrobe({ apiKey, req, model, prompt, frame, outfit, aspectRatio }) {
  const body = {
    model,
    prompt,
    n: 1,
    aspect_ratio: aspectRatio,
    input_references: [
      { type: 'image_url', image_url: { url: frame } },
      { type: 'image_url', image_url: { url: outfit } }
    ]
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  let upstream;
  let raw = '';
  try {
    upstream = await fetch(openRouterImageUrl, {
      method: 'POST',
      headers: cinematicHeaders(apiKey, req),
      body: JSON.stringify(body),
      signal: controller.signal
    });
    raw = await upstream.text();
  } catch (error) {
    const message = error.name === 'AbortError'
      ? 'The wardrobe swap timed out.'
      : `Could not reach OpenRouter (${error.message || 'network error'}).`;
    throw Object.assign(new Error(message), { status: 502 });
  } finally {
    clearTimeout(timeout);
  }

  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {}
  if (!upstream.ok) {
    const message = parsed?.error?.message || parsed?.message || raw.slice(0, 1000) || `OpenRouter returned ${upstream.status}.`;
    throw Object.assign(new Error(message), { status: upstream.status || 502 });
  }
  const image = Array.isArray(parsed?.data) ? parsed.data[0] : null;
  const base64 = typeof image?.b64_json === 'string' ? image.b64_json : '';
  if (!base64) {
    throw Object.assign(new Error('The image model returned no wardrobe still.'), { status: 502 });
  }
  const mediaType = typeof image.media_type === 'string' && /^image\/[a-z0-9.+-]+$/i.test(image.media_type)
    ? image.media_type
    : 'image/png';
  const cost = Number(parsed?.usage?.cost);
  return {
    dataUrl: `data:${mediaType};base64,${base64}`,
    mediaType,
    cost: Number.isFinite(cost) && cost >= 0 ? cost : null,
    usage: parsed?.usage && typeof parsed.usage === 'object' ? parsed.usage : null,
    bytes: Buffer.byteLength(base64, 'base64')
  };
}

async function cinematicVideoJob({ apiKey, req, body }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  let upstream;
  let raw = '';
  try {
    upstream = await fetch(openRouterVideoUrl, {
      method: 'POST',
      headers: cinematicHeaders(apiKey, req),
      body: JSON.stringify(body),
      signal: controller.signal
    });
    raw = await upstream.text();
  } catch (error) {
    const message = error.name === 'AbortError'
      ? 'The B-roll video request timed out.'
      : `Could not reach OpenRouter (${error.message || 'network error'}).`;
    throw new Error(message);
  } finally {
    clearTimeout(timeout);
  }

  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {}
  if (!upstream.ok) {
    throw new Error(parsed?.error?.message || parsed?.message || raw.slice(0, 1000) || `OpenRouter returned ${upstream.status}.`);
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.id) {
    throw new Error('OpenRouter returned an invalid B-roll job response.');
  }
  return parsed;
}

async function handleCinematic(req, res) {
  const apiKey = cinematicRequestKey(req);
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

  const scriptModel = typeof payload.script_model === 'string' ? payload.script_model.trim() : '';
  const speechRequested = typeof payload.speech_model === 'string' ? payload.speech_model.trim() : '';
  const videoModel = typeof payload.video_model === 'string' ? payload.video_model.trim() : '';
  if (!scriptModel || scriptModel.length > 200) {
    sendJson(res, 400, { error: { message: 'A script model is required.' } });
    return;
  }
  if (!speechRequested || speechRequested.length > 200) {
    sendJson(res, 400, { error: { message: 'A speech model is required.' } });
    return;
  }
  if (!videoModel || videoModel.length > 200) {
    sendJson(res, 400, { error: { message: 'A video model is required.' } });
    return;
  }
  const speechModel = speechModelAliases.get(speechRequested) || speechRequested;

  const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
  if (!prompt) {
    sendJson(res, 400, { error: { message: 'A cinematic brief is required.' } });
    return;
  }
  if (prompt.length > maxVideoPromptCharacters) {
    sendJson(res, 413, { error: { message: `The cinematic brief must be ${maxVideoPromptCharacters} characters or fewer.` } });
    return;
  }

  const duration = payload.duration === undefined ? 50 : Number(payload.duration);
  if (!Number.isInteger(duration) || duration < 1 || duration > 600) {
    sendJson(res, 400, { error: { message: 'duration must be an integer from 1 to 600 seconds.' } });
    return;
  }
  const resolution = typeof payload.resolution === 'string' && payload.resolution.trim()
    ? payload.resolution.trim()
    : '1080p';
  if (!/^(?:\d{3,4}p|[24]k)$/i.test(resolution)) {
    sendJson(res, 400, { error: { message: 'resolution must be a value such as 480p, 720p, 1080p, 2k, or 4k.' } });
    return;
  }
  const aspectRatio = typeof payload.aspect_ratio === 'string' && payload.aspect_ratio.trim()
    ? payload.aspect_ratio.trim()
    : '16:9';
  if (!/^\d{1,2}:\d{1,2}$/.test(aspectRatio)) {
    sendJson(res, 400, { error: { message: 'aspect_ratio must look like 16:9, 9:16, or 1:1.' } });
    return;
  }

  let clips;
  try {
    clips = normalizeCinematicClips(payload.clips);
  } catch (error) {
    sendJson(res, error.status || 400, { error: { message: error.message } });
    return;
  }

  let referenceFrame = '';
  if (payload.reference_frame !== undefined && payload.reference_frame !== null && payload.reference_frame !== '') {
    try {
      referenceFrame = normalizeVideoReferences([
        { type: 'image_url', image_url: { url: payload.reference_frame } }
      ])[0].image_url.url;
    } catch (error) {
      sendJson(res, error.status || 400, { error: { message: `reference_frame: ${error.message}` } });
      return;
    }
  }

  const wardrobeModel = typeof payload.wardrobe_model === 'string' ? payload.wardrobe_model.trim() : '';
  if (wardrobeModel.length > 200) {
    sendJson(res, 400, { error: { message: 'wardrobe_model must be 200 characters or fewer.' } });
    return;
  }
  let outfitImage = '';
  try {
    outfitImage = normalizeImageSample(payload.outfit_image);
  } catch (error) {
    sendJson(res, error.status || 400, { error: { message: error.message } });
    return;
  }
  if (outfitImage && !wardrobeModel) {
    sendJson(res, 400, { error: { message: 'Choose an image model to apply the wardrobe reference.' } });
    return;
  }
  if (outfitImage && !referenceFrame) {
    sendJson(res, 400, { error: { message: 'A reference frame is required for a wardrobe swap.' } });
    return;
  }
  const wardrobeDirection = typeof payload.wardrobe_prompt === 'string' ? payload.wardrobe_prompt.trim() : '';
  if (wardrobeDirection.length > maxWardrobePromptCharacters) {
    sendJson(res, 413, { error: { message: `wardrobe_prompt must be ${maxWardrobePromptCharacters} characters or fewer.` } });
    return;
  }
  const lipSync = payload.lip_sync === true;

  let audioSample = '';
  try {
    audioSample = normalizeAudioSample(payload.audio_sample);
    if (!audioSample) throw Object.assign(new Error('An audio sample is required for the voiceover.'), { status: 400 });
  } catch (error) {
    sendJson(res, error.status || 400, { error: { message: error.message } });
    return;
  }

  const transcript = typeof payload.transcript === 'string' ? payload.transcript.trim() : '';
  if (transcript.length > maxTranscriptCharacters) {
    sendJson(res, 413, { error: { message: `transcript must be ${maxTranscriptCharacters} characters or fewer.` } });
    return;
  }
  const voice = typeof payload.voice === 'string' ? payload.voice.trim().slice(0, 200) : '';
  const instructions = typeof payload.instructions === 'string' ? payload.instructions.trim().slice(0, 2000) : '';
  const speedValue = Number(payload.speed);
  const speed = Number.isFinite(speedValue) && speedValue >= 0.5 && speedValue <= 2 ? speedValue : null;

  // Wardrobe is independent of the narration, so dress the frame while the
  // script model is still writing. Both settle objects keep failures local.
  const wardrobePromise = outfitImage
    ? cinematicWardrobe({
        apiKey,
        req,
        model: wardrobeModel,
        prompt: cinematicWardrobePrompt(prompt, wardrobeDirection),
        frame: referenceFrame,
        outfit: outfitImage,
        aspectRatio
      }).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error })
      )
    : Promise.resolve({ ok: true, value: null });

  let script;
  try {
    script = await cinematicScript({ apiKey, req, model: scriptModel, prompt, duration, resolution, aspectRatio: aspectRatio, clips, referenceFrame });
  } catch (error) {
    // The wardrobe request is already in flight; observe it so a late failure
    // cannot become an unhandled rejection after we return.
    wardrobePromise.catch(() => {});
    sendJson(res, error.status || 502, { error: { message: error.message || 'Could not write the voiceover script.' } });
    return;
  }

  const speechPromise = cinematicSpeech({
    apiKey,
    req,
    model: speechModel,
    text: script,
    voice,
    instructions,
    speed,
    audioSample,
    transcript
  }).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error })
  );

  const [speechOutcome, wardrobeOutcome] = await Promise.all([speechPromise, wardrobePromise]);
  if (!speechOutcome.ok) {
    const error = speechOutcome.error || {};
    sendJson(res, error.status || 502, { error: { message: error.message || 'Could not generate the voiceover.' } });
    return;
  }
  const speech = speechOutcome.value;

  let wardrobe = null;
  let wardrobeError = '';
  if (wardrobeOutcome.ok) {
    wardrobe = wardrobeOutcome.value;
  } else {
    wardrobeError = wardrobeOutcome.error?.message || 'Could not apply the wardrobe reference.';
  }

  const videoPrompt = [
    prompt,
    '',
    'Create cinematic real estate B-roll that matches the property described in the brief and the mood of the narration.',
    'Smooth stabilized movement, natural depth of field, architectural detail, premium listing-film quality.',
    wardrobe ? 'The attached still shows the final wardrobe. Keep the person dressed in exactly the same outfit throughout.' : '',
    'Do not render any text, captions, logos, or watermarks.',
    '',
    `Narration context (for mood only): ${script.slice(0, 1500)}`
  ].join('\n').slice(0, maxVideoPromptCharacters);

  const videoRequest = {
    model: videoModel,
    prompt: videoPrompt,
    duration,
    resolution,
    aspect_ratio: aspectRatio,
    generate_audio: false
  };

  const videoFrame = wardrobe?.dataUrl || referenceFrame;
  const usesImageReference = Boolean(videoFrame) && Boolean(wardrobe || wardrobeError || lipSync);

  // Deferring the video lets the client show a review step before any video
  // credits are spent. The client starts the job with /api/videos afterwards.
  const deferVideo = payload.defer_video === true;
  let videoJob = null;
  let videoError = '';
  if (!deferVideo) {
    // Only assemble the reference payload when the job actually starts; the
    // lip-sync audio can be several megabytes of base64.
    const videoReferences = [];
    if (usesImageReference) {
      videoReferences.push({ type: 'image_url', image_url: { url: videoFrame } });
    }
    if (lipSync) {
      videoReferences.push({
        type: 'audio_url',
        audio_url: { url: `data:${speech.contentType};base64,${speech.audio.toString('base64')}` }
      });
    }
    const videoRequestBody = videoReferences.length
      ? { ...videoRequest, input_references: videoReferences }
      : videoRequest;
    try {
      videoJob = await cinematicVideoJob({ apiKey, req, body: videoRequestBody });
    } catch (error) {
      videoError = error.message || 'Could not start the B-roll video.';
    }
  }

  sendJson(res, 200, {
    deferred: deferVideo,
    script,
    script_model: scriptModel,
    speech_model: speechModel,
    video_model: videoModel,
    audio: {
      data: speech.audio.toString('base64'),
      content_type: speech.contentType,
      bytes: speech.audio.length
    },
    analysis: {
      clip_count: clips.length,
      clips: clips.map((clip) => ({ name: clip.name, type: clip.type, bytes: clip.bytes })),
      total_clip_bytes: clips.reduce((sum, clip) => sum + clip.bytes, 0),
      reference_frame: Boolean(referenceFrame),
      wardrobe: wardrobe ? {
        model: wardrobeModel,
        media_type: wardrobe.mediaType,
        bytes: wardrobe.bytes,
        cost_usd: wardrobe.cost,
        usage: wardrobe.usage
      } : null,
      lip_sync: lipSync,
      wardrobe_error: wardrobeError,
      audio_sample: { type: audioSample.slice(5, audioSample.indexOf(';')), bytes: dataUrlBytes(audioSample) || 0 },
      duration,
      resolution,
      aspect_ratio: aspectRatio
    },
    wardrobe: wardrobe ? {
      model: wardrobeModel,
      data_url: wardrobe.dataUrl,
      media_type: wardrobe.mediaType,
      cost_usd: wardrobe.cost,
      usage: wardrobe.usage
    } : null,
    lip_sync: lipSync,
    wardrobe_error: wardrobeError,
    video_request: videoRequest,
    video_job: videoJob,
    video_error: videoError
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
    if (!Number.isInteger(duration) || duration < 1 || duration > 600) {
      sendJson(res, 400, { error: { message: 'duration must be an integer from 1 to 600 seconds.' } });
      return;
    }
    body.duration = duration;
  }
  if (payload.resolution !== undefined) {
    const resolution = typeof payload.resolution === 'string' ? payload.resolution.trim() : '';
    if (!/^(?:\d{3,4}p|[24]k)$/i.test(resolution)) {
      sendJson(res, 400, { error: { message: 'resolution must be a value such as 480p, 720p, 1080p, 2k, or 4k.' } });
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

async function handleWardrobeStill(req, res) {
  const apiKey = cinematicRequestKey(req);
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
    sendJson(res, 400, { error: { message: 'An image model is required.' } });
    return;
  }

  let referenceFrame = '';
  try {
    referenceFrame = normalizeImageSample(payload.reference_frame, 'Reference frame');
  } catch (error) {
    sendJson(res, error.status || 400, { error: { message: error.message } });
    return;
  }
  if (!referenceFrame) {
    sendJson(res, 400, { error: { message: 'A reference frame is required.' } });
    return;
  }

  let outfitImage = '';
  try {
    outfitImage = normalizeImageSample(payload.outfit_image, 'Outfit reference');
  } catch (error) {
    sendJson(res, error.status || 400, { error: { message: error.message } });
    return;
  }
  if (!outfitImage) {
    sendJson(res, 400, { error: { message: 'An outfit reference image is required.' } });
    return;
  }

  const aspectRatio = typeof payload.aspect_ratio === 'string' && payload.aspect_ratio.trim()
    ? payload.aspect_ratio.trim()
    : '16:9';
  if (!/^\d{1,2}:\d{1,2}$/.test(aspectRatio)) {
    sendJson(res, 400, { error: { message: 'aspect_ratio must look like 16:9, 9:16, or 1:1.' } });
    return;
  }

  const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
  if (prompt.length > maxVideoPromptCharacters) {
    sendJson(res, 413, { error: { message: `prompt must be ${maxVideoPromptCharacters} characters or fewer.` } });
    return;
  }
  const direction = typeof payload.wardrobe_prompt === 'string' ? payload.wardrobe_prompt.trim() : '';
  if (direction.length > maxWardrobePromptCharacters) {
    sendJson(res, 413, { error: { message: `wardrobe_prompt must be ${maxWardrobePromptCharacters} characters or fewer.` } });
    return;
  }

  try {
    const wardrobe = await cinematicWardrobe({
      apiKey,
      req,
      model,
      prompt: cinematicWardrobePrompt(prompt, direction),
      frame: referenceFrame,
      outfit: outfitImage,
      aspectRatio
    });
    sendJson(res, 200, {
      model,
      wardrobe: {
        model,
        data_url: wardrobe.dataUrl,
        media_type: wardrobe.mediaType,
        cost_usd: wardrobe.cost,
        usage: wardrobe.usage
      }
    });
  } catch (error) {
    sendJson(res, error.status || 502, { error: { message: error.message || 'Could not apply the wardrobe reference.' } });
  }
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

  if (urlPath === '/api/tts' || urlPath === '/api/videos' || urlPath === '/api/cinematic' || urlPath === '/api/cinematic/wardrobe') {
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
    else if (urlPath === '/api/cinematic/wardrobe') await handleWardrobeStill(req, res);
    else if (urlPath === '/api/cinematic') await handleCinematic(req, res);
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
