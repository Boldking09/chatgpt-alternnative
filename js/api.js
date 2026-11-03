const BASE = "https://openrouter.ai/api/v1";
const MODELS_URL = `${BASE}/models`;
const CHAT_URL = `${BASE}/chat/completions`;
const VIDEO_MODELS_URL = `${BASE}/videos/models`;
const VIDEO_URL = `${BASE}/videos`;
const SPEECH_URL = "/api/tts";
const SPEECH_MODELS_URL = `${MODELS_URL}?output_modalities=speech`;
const VIDEO_TERMINAL = new Set(["completed", "failed", "cancelled", "expired"]);

function headers(apiKey) {
  const result = {
    "Content-Type": "application/json",
    "HTTP-Referer": location.origin,
    "X-Title": "OURCHAT",
  };
  if (apiKey) result.Authorization = `Bearer ${apiKey}`;
  return result;
}

async function errorMessage(response) {
  let detail = "";
  try {
    const payload = await response.json();
    detail = payload?.error?.message || payload?.message || payload?.error || "";
    if (detail && typeof detail === "object") detail = JSON.stringify(detail);
  } catch {
    try {
      detail = (await response.text()).slice(0, 400);
    } catch {
      detail = "";
    }
  }
  const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  return detail ? `${status} — ${detail}` : status;
}

function modelPricing(model) {
  const prompt = Number.parseFloat(model.pricing?.prompt);
  const completion = Number.parseFloat(model.pricing?.completion);
  return {
    promptPrice: Number.isFinite(prompt) ? prompt : null,
    completionPrice: Number.isFinite(completion) ? completion : null,
  };
}

function modelVoices(model) {
  return Array.isArray(model.supported_voices)
    ? model.supported_voices.filter((voice) => typeof voice === "string" && voice)
    : [];
}

export function normalizeModels(payload) {
  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  return list
    .filter((model) => model && typeof model.id === "string")
    .map((model) => {
      const outputs = Array.isArray(model.architecture?.output_modalities)
        ? model.architecture.output_modalities
        : [];
      const speech = outputs.includes("speech");
      return {
        id: model.id,
        name: typeof model.name === "string" && model.name ? model.name : model.id,
        description: typeof model.description === "string" ? model.description : "",
        context: Number(model.context_length) || Number(model.top_provider?.context_length) || 0,
        maxOutput: Number(model.top_provider?.max_completion_tokens) || 0,
        ...modelPricing(model),
        vision: Array.isArray(model.architecture?.input_modalities)
          ? model.architecture.input_modalities.includes("image")
          : false,
        reasoning: Array.isArray(model.supported_parameters)
          ? model.supported_parameters.includes("reasoning")
          : false,
        voices: speech ? modelVoices(model) : [],
        cloning: speech && /voice clon|zero-shot/i.test(String(model.description || "")),
        created: Number(model.created) || 0,
        kind: speech ? "speech" : "chat",
      };
    });
}

export function normalizeSpeechModels(payload) {
  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  return list
    .filter((model) => model && typeof model.id === "string")
    .map((model) => {
      const outputs = Array.isArray(model.architecture?.output_modalities)
        ? model.architecture.output_modalities
        : [];
      if (!outputs.includes("speech") && !/->speech$/.test(String(model.architecture?.modality || ""))) return null;
      return {
        id: model.id,
        name: typeof model.name === "string" && model.name ? model.name : model.id,
        description: typeof model.description === "string" ? model.description : "",
        context: Number(model.context_length) || Number(model.top_provider?.context_length) || 0,
        maxOutput: Number(model.top_provider?.max_completion_tokens) || 0,
        ...modelPricing(model),
        vision: false,
        reasoning: false,
        voices: modelVoices(model),
        cloning: /voice clon|zero-shot/i.test(String(model.description || "")),
        created: Number(model.created) || 0,
        kind: "speech",
      };
    })
    .filter(Boolean);
}

function skuNumber(value) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function skuDollars(key, value) {
  const number = skuNumber(value);
  if (number === null) return null;
  return key.includes("cents_per") ? number / 100 : number;
}

function resolutionHeight(resolution) {
  const label = String(resolution || "").toLowerCase();
  const heights = { "480p": 480, "720p": 720, "768p": 768, "1080p": 1080, "1k": 1024, "2k": 1440, "4k": 2160 };
  return heights[label] || 0;
}

function ratioValue(ratio) {
  const match = String(ratio || "").match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) return 0;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return height > 0 ? width / height : 0;
}

function videoSize(model, resolution, aspectRatio) {
  const targetHeight = resolutionHeight(resolution);
  const targetRatio = ratioValue(aspectRatio);
  const sizes = Array.isArray(model.sizes) ? model.sizes : [];
  let best = null;
  for (const size of sizes) {
    const match = String(size).match(/^(\d+)x(\d+)$/);
    if (!match) continue;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!width || !height) continue;
    const heightPenalty = targetHeight ? Math.abs(height - targetHeight) / targetHeight : 0;
    const ratioPenalty = targetRatio ? Math.abs(width / height - targetRatio) / targetRatio : 0;
    const score = heightPenalty * 4 + ratioPenalty;
    if (!best || score < best.score) best = { width, height, score };
  }
  if (best) return best;
  const height = targetHeight || 720;
  return { width: Math.max(1, Math.round(height * (targetRatio || 16 / 9))), height };
}

function selectedRateKey(keys, resolution, audio) {
  const label = String(resolution || "").toLowerCase();
  const suffix = label ? `_${label}` : "";
  const candidates = [];
  if (audio) {
    candidates.push(`duration_seconds_with_audio${suffix}`, `duration_seconds${suffix}`, "duration_seconds_with_audio", "duration_seconds");
  } else {
    candidates.push(
      `duration_seconds_without_audio${suffix}`,
      `duration_seconds${suffix}`,
      "duration_seconds_without_audio",
      "duration_seconds"
    );
  }
  candidates.push(
    `cents_per_video_output_second${suffix}`,
    `cents_per_second_output${suffix}`,
    "cents_per_video_output_second",
    "cents_per_second_output"
  );
  for (const key of candidates) {
    if (Object.prototype.hasOwnProperty.call(keys, key)) {
      const value = skuDollars(key, keys[key]);
      if (value !== null) return value;
    }
  }
  return null;
}

function perSecondRate(model, { resolution, generateAudio } = {}) {
  const keys = model.pricingSkus || {};
  const selected = selectedRateKey(keys, resolution, Boolean(generateAudio));
  if (selected !== null) return selected;
  const rates = Object.entries(keys)
    .filter(([key]) => /(?:duration_seconds|per_second|per_video_output_second)/i.test(key))
    .filter(([key]) => !/(?:reference|minimum|megapixel|input_image|image_input)/i.test(key))
    .map(([key, value]) => skuDollars(key, value))
    .filter((value) => value !== null);
  return rates.length ? Math.min(...rates) : null;
}

function tokenRate(model, { resolution, generateAudio } = {}) {
  const keys = model.pricingSkus || {};
  const label = String(resolution || "").toLowerCase();
  const byResolution = label === "1080p" ? "video_tokens_1080p" : label === "4k" ? "video_tokens_4k" : "";
  const candidates = [
    ...(byResolution ? [byResolution] : []),
    ...(generateAudio === false ? ["video_tokens_without_audio"] : []),
    "video_tokens",
  ];
  for (const key of candidates) {
    if (Object.prototype.hasOwnProperty.call(keys, key)) {
      const value = skuDollars(key, keys[key]);
      if (value !== null) return value;
    }
  }
  return null;
}

export function estimateVideoCost(model, { duration, resolution, aspectRatio, generateAudio } = {}) {
  if (!model || model.kind !== "video") return null;
  const seconds = Number(duration) || Number(model.durations?.[0]) || 0;
  if (!seconds) return null;
  const rate = perSecondRate(model, { resolution, generateAudio });
  if (rate !== null) return rate * seconds;
  const tokens = tokenRate(model, { resolution, generateAudio });
  if (tokens !== null) {
    const size = videoSize(model, resolution, aspectRatio);
    return (size.width * size.height * seconds * 24 / 1024) * tokens;
  }
  return null;
}

function rateLabel(value) {
  if (value >= 1) return value.toFixed(2);
  if (value >= 0.1) return value.toFixed(3).replace(/0$/, "");
  if (value >= 0.01) return value.toFixed(3);
  return value.toFixed(4);
}

export function formatVideoPrice(model) {
  if (!model || model.kind !== "video") return "";
  const rate = perSecondRate(model, {
    resolution: model.resolutions?.[0] || "",
    generateAudio: Boolean(model.generateAudio),
  });
  if (rate !== null) return `from $${rateLabel(rate)}/s`;
  const tokens = tokenRate(model, { resolution: model.resolutions?.[0] || "", generateAudio: false });
  if (tokens !== null) {
    const sizes = (model.sizes || [])
      .map((size) => String(size).match(/^(\d+)x(\d+)$/))
      .filter(Boolean)
      .map((match) => Number(match[1]) * Number(match[2]));
    const area = sizes.length ? Math.min(...sizes) : 640 * 480;
    const ratePerSecond = area * 24 / 1024 * tokens;
    return `from ~$${rateLabel(ratePerSecond)}/s`;
  }
  return "Video pricing";
}

export function formatVideoCost(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return "";
  if (amount === 0) return "$0.00";
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(amount < 1 ? 3 : 2)}`;
}

export function normalizeVideoModels(payload) {
  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  return list
    .filter((model) => model && typeof model.id === "string")
    .map((model) => {
      const durations = Array.isArray(model.supported_durations)
        ? model.supported_durations.map(Number).filter((value) => Number.isFinite(value) && value > 0)
        : [];
      const resolutions = Array.isArray(model.supported_resolutions)
        ? model.supported_resolutions.filter((value) => typeof value === "string" && value)
        : [];
      const aspectRatios = Array.isArray(model.supported_aspect_ratios)
        ? model.supported_aspect_ratios.filter((value) => typeof value === "string" && value)
        : [];
      const sizes = Array.isArray(model.supported_sizes)
        ? model.supported_sizes.filter((value) => typeof value === "string" && value)
        : [];
      const pricingSkus = model.pricing_skus && typeof model.pricing_skus === "object"
        ? Object.fromEntries(Object.entries(model.pricing_skus).filter(([, value]) => skuNumber(value) !== null))
        : {};
      return {
        id: model.id,
        name: typeof model.name === "string" && model.name ? model.name : model.id,
        description: typeof model.description === "string" ? model.description : "",
        canonicalSlug: typeof model.canonical_slug === "string" ? model.canonical_slug : model.id,
        created: Number(model.created) || 0,
        kind: "video",
        durations,
        resolutions,
        aspectRatios,
        sizes,
        generateAudio: model.generate_audio === true,
        supportsSeed: model.seed === true,
        frameImages: Array.isArray(model.supported_frame_images) ? model.supported_frame_images : [],
        pricingSkus,
        context: 0,
        maxOutput: 0,
        promptPrice: null,
        completionPrice: null,
        vision: false,
        reasoning: false,
      };
    })
    .filter((model) => model.durations.length > 0);
}

export async function fetchVideoModels(apiKey = "") {
  let response;
  try {
    response = await fetch(VIDEO_MODELS_URL, { headers: headers(apiKey) });
  } catch (error) {
    throw new Error(`Could not reach OpenRouter video models (${error.message || "network error"}).`);
  }
  if (!response.ok) throw new Error(`Video model catalog: ${await errorMessage(response)}`);
  return normalizeVideoModels(await response.json());
}

export async function fetchSpeechModels(apiKey = "") {
  let response;
  try {
    response = await fetch(SPEECH_MODELS_URL, { headers: headers(apiKey) });
  } catch (error) {
    throw new Error(`Could not reach OpenRouter speech models (${error.message || "network error"}).`);
  }
  if (!response.ok) throw new Error(`Speech model catalog: ${await errorMessage(response)}`);
  return normalizeSpeechModels(await response.json());
}

export async function fetchModels(apiKey = "") {
  let response;
  try {
    response = await fetch(MODELS_URL, { headers: headers(apiKey) });
  } catch (error) {
    throw new Error(`Could not reach OpenRouter (${error.message || "network error"}).`);
  }
  if (!response.ok) throw new Error(`Model catalog: ${await errorMessage(response)}`);
  const payload = await response.json();
  const models = normalizeModels(payload);
  if (!models.length) throw new Error("OpenRouter returned an empty model list.");
  return models;
}

function toApiMessages(messages, systemPrompt) {
  const result = [];
  const system = String(systemPrompt || "").trim();
  if (system) result.push({ role: "system", content: system });

  for (const message of messages) {
    if (!message || !message.content && !message.images?.length) continue;
    if (message.role === "assistant") {
      if (message.content) result.push({ role: "assistant", content: message.content });
      continue;
    }
    if (message.images?.length) {
      const parts = [];
      if (message.content) parts.push({ type: "text", text: message.content });
      for (const image of message.images) parts.push({ type: "image_url", image_url: { url: image } });
      result.push({ role: "user", content: parts });
    } else {
      result.push({ role: "user", content: message.content });
    }
  }
  return result;
}

export function buildBody({ model, messages, systemPrompt, temperature, maxTokens, stream }) {
  const body = {
    model,
    messages: toApiMessages(messages, systemPrompt),
    stream: Boolean(stream),
  };
  if (Number.isFinite(temperature)) body.temperature = temperature;
  if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = Math.floor(maxTokens);
  if (stream) body.usage = { include: true };
  return body;
}

function applyDelta(data, state, onDelta, onReasoning) {
  if (data?.error) {
    throw new Error(data.error.message || "The model returned an error.");
  }
  const choice = data?.choices?.[0];
  const delta = choice?.delta || {};
  const content = typeof delta.content === "string" ? delta.content : "";
  const reasoning =
    (typeof delta.reasoning === "string" && delta.reasoning) ||
    (typeof delta.reasoning_content === "string" && delta.reasoning_content) ||
    (Array.isArray(delta.reasoning_details)
      ? delta.reasoning_details.map((item) => item?.text || item?.summary || "").join("")
      : "");
  if (reasoning) {
    state.reasoning += reasoning;
    onReasoning?.(reasoning, state.reasoning);
  }
  if (content) {
    state.content += content;
    onDelta?.(content, state.content);
  }
  if (data?.usage) state.usage = data.usage;
  return state;
}

export async function streamCompletion({ apiKey, model, messages, systemPrompt, temperature, maxTokens, signal, onDelta, onReasoning }) {
  const body = buildBody({ model, messages, systemPrompt, temperature, maxTokens, stream: true });
  let response;
  try {
    response = await fetch(CHAT_URL, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new Error(`Network error — ${error.message || "could not reach OpenRouter"}.`);
  }

  if (!response.ok) throw new Error(await errorMessage(response));
  if (!response.body) throw new Error("Streaming is not available in this browser.");

  const state = { content: "", reasoning: "", usage: null };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;

  const handleLine = (line) => {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed || trimmed.startsWith(":")) return;
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload) return;
    if (payload === "[DONE]") {
      finished = true;
      return;
    }
    let data;
    try {
      data = JSON.parse(payload);
    } catch {
      return;
    }
    applyDelta(data, state, onDelta, onReasoning);
  };

  try {
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (finished) break;
      }
    }
    if (!finished && buffer.trim()) handleLine(buffer);
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* stream already closed */
    }
  }

  return state;
}

export async function completeChat({ apiKey, model, messages, systemPrompt, temperature, maxTokens, signal }) {
  const body = buildBody({ model, messages, systemPrompt, temperature, maxTokens, stream: false });
  let response;
  try {
    response = await fetch(CHAT_URL, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new Error(`Network error — ${error.message || "could not reach OpenRouter"}.`);
  }
  if (!response.ok) throw new Error(await errorMessage(response));
  const payload = await response.json();
  if (payload?.error) throw new Error(payload.error.message || "The model returned an error.");
  const message = payload?.choices?.[0]?.message || {};
  return {
    content: typeof message.content === "string" ? message.content : "",
    reasoning: typeof message.reasoning === "string" ? message.reasoning : "",
    usage: payload?.usage || null,
  };
}

export function formatContext(value) {
  const tokens = Number(value) || 0;
  if (!tokens) return "";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M ctx`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K ctx`;
  return `${tokens} ctx`;
}

export function estimateSpeechCost(model, text) {
  if (!model || model.kind !== "speech" || model.promptPrice === null) return null;
  const tokens = Math.max(1, Math.ceil(String(text || "").length / 4));
  return model.promptPrice * tokens;
}

export function formatPrice(model) {
  if (model?.kind === "video") return formatVideoPrice(model);
  const prompt = model.promptPrice;
  if (prompt === null) return "";
  if (prompt === 0) return "Free";
  const perMillion = prompt * 1_000_000;
  if (perMillion < 0.01) return `$${perMillion.toFixed(3)}/M`;
  if (perMillion < 1) return `$${perMillion.toFixed(2)}/M`;
  return `$${perMillion.toFixed(perMillion < 10 ? 2 : 0)}/M`;
}

export function providerOf(model) {
  const prefix = String(model?.id || "").split("/")[0] || "";
  return prefix
    .split(/[-_]/)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

export function videoJobUrls(job) {
  const values = [
    ...(Array.isArray(job?.unsigned_urls) ? job.unsigned_urls : []),
    ...(Array.isArray(job?.urls) ? job.urls : []),
  ];
  return [...new Set(values.filter((value) => typeof value === "string" && value))];
}

function safeVideoJobUrl(pollingUrl, id) {
  const polling = String(pollingUrl || "");
  if (polling.startsWith("https://openrouter.ai/api/v1/videos/")) return polling;
  if (polling.startsWith("/api/v1/videos/")) return `https://openrouter.ai${polling}`;
  if (id) return `${VIDEO_URL}/${encodeURIComponent(id)}`;
  return "";
}

export async function createVideoGeneration({ apiKey, model, prompt, duration, resolution, aspectRatio, generateAudio, inputReferences, signal }) {
  const body = { model, prompt };
  if (duration) body.duration = Number(duration);
  if (resolution) body.resolution = resolution;
  if (aspectRatio) body.aspect_ratio = aspectRatio;
  if (generateAudio) body.generate_audio = true;
  if (Array.isArray(inputReferences) && inputReferences.length) body.input_references = inputReferences;

  let response;
  try {
    response = await fetch(VIDEO_URL, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new Error(`Network error — ${error.message || "could not reach OpenRouter"}.`);
  }
  if (!response.ok) throw new Error(await errorMessage(response));
  const payload = await response.json();
  if (payload?.error) throw new Error(payload.error.message || "OpenRouter rejected the video request.");
  if (!payload?.id) throw new Error("OpenRouter did not return a video job id.");
  return payload;
}

export async function fetchVideoJob({ apiKey, id, pollingUrl, signal }) {
  const url = safeVideoJobUrl(pollingUrl, id);
  if (!url) throw new Error("Video job has no polling URL.");
  let response;
  try {
    response = await fetch(url, { headers: headers(apiKey), signal });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new Error(`Network error — ${error.message || "could not reach OpenRouter"}.`);
  }
  if (!response.ok) throw new Error(await errorMessage(response));
  const payload = await response.json();
  if (payload?.error && !VIDEO_TERMINAL.has(payload?.status)) {
    throw new Error(payload.error.message || "OpenRouter returned a video error.");
  }
  return payload;
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

export async function waitForVideoGeneration({ apiKey, job, intervalMs = 4000, timeoutMs = 20 * 60 * 1000, signal, onUpdate }) {
  let current = job;
  const started = Date.now();
  while (!VIDEO_TERMINAL.has(current?.status)) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for the video. The job may still be running on OpenRouter.");
    }
    await abortableDelay(intervalMs, signal);
    current = await fetchVideoJob({
      apiKey,
      id: current?.id || job?.id,
      pollingUrl: current?.polling_url || job?.polling_url,
      signal,
    });
    onUpdate?.(current);
  }
  return current;
}

export function isVideoTerminal(status) {
  return VIDEO_TERMINAL.has(status);
}

export function videoContentUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.hostname !== "openrouter.ai") return "";
    if (!url.pathname.startsWith("/api/v1/videos/")) return "";
    return url.toString();
  } catch {
    return "";
  }
}

export async function fetchVideoContent({ apiKey, url, signal }) {
  const safe = videoContentUrl(url);
  if (!safe) throw new Error("The video content URL was not an OpenRouter endpoint.");
  let response;
  try {
    response = await fetch(safe, { headers: headers(apiKey), signal });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new Error(`Network error — ${error.message || "could not download the video"}.`);
  }
  if (!response.ok) throw new Error(await errorMessage(response));
  const blob = await response.blob();
  if (!blob.size) throw new Error("OpenRouter returned an empty video file.");
  return blob;
}

export function videoAudioReference(dataUrl) {
  const value = String(dataUrl || "");
  if (!value.startsWith("data:audio/")) return null;
  return { type: "audio_url", audio_url: { url: value } };
}

export function speechAudioReference(dataUrl, transcript = "") {
  const value = String(dataUrl || "");
  if (!value.startsWith("data:audio/")) return null;
  const parts = [{ type: "input_audio", input_audio: { data: value } }];
  const text = String(transcript || "").trim();
  if (text) parts.push({ type: "text", text: text.slice(0, 10000) });
  return parts;
}

export async function createSpeech({
  apiKey,
  model,
  input,
  voice,
  instructions,
  speed,
  responseFormat = "mp3",
  references = [],
  signal,
}) {
  const body = { text: input, model, response_format: responseFormat };
  if (voice) body.voice = voice;
  const delivery = String(instructions || "").trim();
  if (delivery) body.instructions = delivery;
  const rate = Number(speed);
  if (Number.isFinite(rate) && rate > 0 && rate !== 1) body.speed = rate;
  if (Array.isArray(references) && references.length) {
    const sample = references.find((part) => part?.type === "input_audio" && part.input_audio?.data);
    if (sample) body.audioSample = sample.input_audio.data;
    const transcript = references
      .filter((part) => part?.type === "text" && part.text)
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (transcript) body.transcript = transcript;
  }

  let response;
  try {
    response = await fetch(SPEECH_URL, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new Error(`Network error — ${error.message || "could not reach OpenRouter"}.`);
  }
  if (!response.ok) throw new Error(await errorMessage(response));

  const type = response.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    throw new Error(payload?.error?.message || payload?.message || "OpenRouter returned no audio.");
  }

  const blob = await response.blob();
  if (!blob.size) throw new Error("OpenRouter returned an empty audio file.");
  return { blob, type: type || "audio/mpeg" };
}
