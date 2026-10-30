const DB_KEY = "aria.db.v1";
const SETTINGS_KEY = "aria.settings.v1";
const MODELS_KEY = "aria.models.v1";
const MODEL_TTL = 6 * 60 * 60 * 1000;

export const DEFAULT_SETTINGS = {
  apiKey: "",
  defaultModel: "openai/gpt-4o-mini",
  systemPrompt: "",
  temperature: 1,
  maxTokens: null,
  streaming: true,
  showReasoning: true,
  sendOnEnter: true,
  theme: "system",
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizeSettings(input) {
  const settings = { ...DEFAULT_SETTINGS, ...(input && typeof input === "object" ? input : {}) };
  settings.apiKey = typeof settings.apiKey === "string" ? settings.apiKey.trim() : "";
  settings.defaultModel = typeof settings.defaultModel === "string" ? settings.defaultModel : DEFAULT_SETTINGS.defaultModel;
  settings.systemPrompt = typeof settings.systemPrompt === "string" ? settings.systemPrompt : "";
  const temp = Number(settings.temperature);
  settings.temperature = Number.isFinite(temp) ? Math.min(2, Math.max(0, temp)) : 1;
  const max = Number(settings.maxTokens);
  settings.maxTokens = Number.isFinite(max) && max > 0 ? Math.floor(max) : null;
  settings.streaming = settings.streaming !== false;
  settings.showReasoning = settings.showReasoning !== false;
  settings.sendOnEnter = settings.sendOnEnter !== false;
  settings.theme = ["light", "dark", "system"].includes(settings.theme) ? settings.theme : "system";
  return settings;
}

function sanitizeMessage(message) {
  if (!message || typeof message !== "object") return null;
  return {
    id: typeof message.id === "string" ? message.id : uid(),
    role: message.role === "assistant" ? "assistant" : "user",
    content: typeof message.content === "string" ? message.content : "",
    reasoning: typeof message.reasoning === "string" ? message.reasoning : "",
    images: Array.isArray(message.images) ? message.images.filter((src) => typeof src === "string").slice(0, 6) : [],
    model: typeof message.model === "string" ? message.model : "",
    at: Number(message.at) || Date.now(),
    error: typeof message.error === "string" ? message.error : "",
    stopped: Boolean(message.stopped),
    feedback: message.feedback === 1 || message.feedback === -1 ? message.feedback : 0,
    usage: message.usage && typeof message.usage === "object" ? message.usage : null,
  };
}

function sanitizeDb(input) {
  const db = { conversations: [] };
  if (Array.isArray(input?.conversations)) {
    db.conversations = input.conversations
      .filter((conversation) => conversation && typeof conversation.id === "string")
      .map((conversation) => ({
        id: conversation.id,
        title: typeof conversation.title === "string" ? conversation.title : "New chat",
        createdAt: Number(conversation.createdAt) || Date.now(),
        updatedAt: Number(conversation.updatedAt) || Number(conversation.createdAt) || Date.now(),
        model: typeof conversation.model === "string" ? conversation.model : "",
        messages: Array.isArray(conversation.messages)
          ? conversation.messages.map(sanitizeMessage).filter(Boolean)
          : [],
      }));
  }
  return db;
}

function loadDb() {
  return sanitizeDb(read(DB_KEY, { conversations: [] }));
}

function saveDb(db) {
  return write(DB_KEY, db);
}

export const db = loadDb();

export function conversations() {
  return [...db.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getConversation(id) {
  return db.conversations.find((conversation) => conversation.id === id) || null;
}

export function createConversation({ model = "" } = {}) {
  const now = Date.now();
  const conversation = {
    id: uid(),
    title: "New chat",
    createdAt: now,
    updatedAt: now,
    model,
    messages: [],
  };
  db.conversations.push(conversation);
  saveDb(db);
  return conversation;
}

export function updateConversation(id, patch) {
  const conversation = getConversation(id);
  if (!conversation) return null;
  Object.assign(conversation, patch, { updatedAt: Date.now() });
  saveDb(db);
  return conversation;
}

export function renameConversation(id, title) {
  return updateConversation(id, { title: String(title || "").trim() || "Untitled chat" });
}

export function removeConversation(id) {
  const index = db.conversations.findIndex((conversation) => conversation.id === id);
  if (index === -1) return false;
  db.conversations.splice(index, 1);
  saveDb(db);
  return true;
}

export function clearConversations() {
  db.conversations = [];
  saveDb(db);
}

export function addMessage(conversationId, message) {
  const conversation = getConversation(conversationId);
  if (!conversation) return null;
  const entry = sanitizeMessage({ ...message, id: message?.id || uid() });
  conversation.messages.push(entry);
  conversation.updatedAt = Date.now();
  saveDb(db);
  return entry;
}

export function updateMessage(conversationId, messageId, patch) {
  const conversation = getConversation(conversationId);
  if (!conversation) return null;
  const message = conversation.messages.find((item) => item.id === messageId);
  if (!message) return null;
  Object.assign(message, patch);
  conversation.updatedAt = Date.now();
  saveDb(db);
  return message;
}

export function removeMessagesFrom(conversationId, messageId) {
  const conversation = getConversation(conversationId);
  if (!conversation) return null;
  const index = conversation.messages.findIndex((message) => message.id === messageId);
  if (index === -1) return null;
  const removed = conversation.messages.splice(index);
  conversation.updatedAt = Date.now();
  saveDb(db);
  return removed;
}

export function setTitleFromMessage(conversationId, text) {
  const conversation = getConversation(conversationId);
  if (!conversation) return;
  if (conversation.title && conversation.title !== "New chat") return;
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return;
  const title = clean.length > 58 ? `${clean.slice(0, 57).trimEnd()}…` : clean;
  conversation.title = title;
  saveDb(db);
}

export function saveAll() {
  return saveDb(db);
}

export function settings() {
  return sanitizeSettings(read(SETTINGS_KEY, DEFAULT_SETTINGS));
}

export function saveSettings(patch) {
  const next = sanitizeSettings({ ...settings(), ...patch });
  write(SETTINGS_KEY, next);
  return next;
}

export function resetSettings() {
  try {
    localStorage.removeItem(SETTINGS_KEY);
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_SETTINGS };
}

export function cachedModels() {
  const cache = read(MODELS_KEY, null);
  if (!cache || !Array.isArray(cache.models) || !cache.at) return null;
  return { ...cache, stale: Date.now() - cache.at > MODEL_TTL };
}

export function saveModels(models) {
  write(MODELS_KEY, { at: Date.now(), models });
}

export function clearModels() {
  try {
    localStorage.removeItem(MODELS_KEY);
  } catch {
    /* ignore */
  }
}

export function clearAll() {
  try {
    localStorage.removeItem(DB_KEY);
    localStorage.removeItem(SETTINGS_KEY);
    localStorage.removeItem(MODELS_KEY);
  } catch {
    /* ignore */
  }
  db.conversations = [];
}

export function exportConversation(conversation) {
  const lines = [`# ${conversation.title}`, ""];
  for (const message of conversation.messages) {
    lines.push(message.role === "user" ? "## You" : `## ${message.model || "Assistant"}`);
    lines.push("");
    if (message.content) lines.push(message.content);
    if (message.images?.length) lines.push("", `_${message.images.length} attached image(s)_`);
    lines.push("");
  }
  return lines.join("\n").trim() + "\n";
}
