const BASE = "https://openrouter.ai/api/v1";
const MODELS_URL = `${BASE}/models`;
const CHAT_URL = `${BASE}/chat/completions`;

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

export function normalizeModels(payload) {
  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  return list
    .filter((model) => model && typeof model.id === "string")
    .map((model) => {
      const prompt = Number.parseFloat(model.pricing?.prompt);
      const completion = Number.parseFloat(model.pricing?.completion);
      return {
        id: model.id,
        name: typeof model.name === "string" && model.name ? model.name : model.id,
        description: typeof model.description === "string" ? model.description : "",
        context: Number(model.context_length) || Number(model.top_provider?.context_length) || 0,
        maxOutput: Number(model.top_provider?.max_completion_tokens) || 0,
        promptPrice: Number.isFinite(prompt) ? prompt : null,
        completionPrice: Number.isFinite(completion) ? completion : null,
        vision: Array.isArray(model.architecture?.input_modalities)
          ? model.architecture.input_modalities.includes("image")
          : false,
        reasoning: Array.isArray(model.supported_parameters)
          ? model.supported_parameters.includes("reasoning")
          : false,
        created: Number(model.created) || 0,
      };
    });
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

export function formatPrice(model) {
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
