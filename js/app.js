import * as store from "./store.js";
import { renderMarkdown, escapeHtml, plainText, snippet } from "./markdown.js";
import {
  fetchModels,
  streamCompletion,
  completeChat,
  formatContext,
  formatPrice,
  providerOf,
} from "./api.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const dom = {
  app: $("#app"),
  sidebar: $("#sidebar"),
  scrim: $("#scrim"),
  thread: $("#thread"),
  scroll: $("#scroll"),
  input: $("#input"),
  composer: $("#composer"),
  composerWrap: $("#composer-wrap"),
  attachments: $("#attachments"),
  send: $("#send-btn"),
  tokenHint: $("#token-hint"),
  modelPickerName: $("#model-picker-name"),
  modelBadge: $("#model-badge"),
  conversationList: $("#conversation-list"),
  toast: $("#toast"),
  promptLabel: $("#prompt-label"),
  promptBtn: $("#prompt-btn"),
  accountSub: $("#account-sub"),
  settingsDialog: $("#settings-dialog"),
  modelsDialog: $("#models-dialog"),
  modelsList: $("#models-list"),
  modelsState: $("#models-state"),
  searchDialog: $("#search-dialog"),
  searchInput: $("#search-input"),
  searchResults: $("#search-results"),
  fileInput: $("#file-input"),
};

const state = {
  conversationId: null,
  sending: false,
  controller: null,
  models: [],
  modelsLoading: false,
  modelsError: "",
  modelFilter: "",
  modelMode: "chat",
  pendingDefaultModel: null,
  pendingImages: [],
  renamingId: null,
  menu: null,
  searchIndex: 0,
  searchIds: [],
  stick: true,
  listening: false,
};

const mqDark = matchMedia("(prefers-color-scheme: dark)");
const mqSmall = matchMedia("(max-width: 900px)");

/* ---------------- Helpers ---------------- */

function isMobile() {
  return mqSmall.matches;
}

function currentConversation() {
  return state.conversationId ? store.getConversation(state.conversationId) : null;
}

function currentModel() {
  const conversation = currentConversation();
  return (conversation?.model || store.settings().defaultModel || "").trim();
}

function modelName(id) {
  if (!id) return "Choose a model";
  const model = state.models.find((item) => item.id === id);
  return model ? model.name : id;
}

function shortModel(id) {
  const full = modelName(id);
  const parts = full.split(":");
  return (parts.length > 1 ? parts.slice(1).join(":").trim() : full) || id;
}

function toast(message) {
  dom.toast.textContent = message;
  dom.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    dom.toast.hidden = true;
  }, 2400);
}

function friendlyError(error) {
  const message = typeof error === "string" ? error : error?.message || "Something went wrong.";
  if (/\b401\b/.test(message)) return "OpenRouter rejected your API key (401). Update it in Settings.";
  if (/\b402\b/.test(message)) return "OpenRouter reports insufficient credits (402). Add credits at openrouter.ai.";
  if (/\b429\b/.test(message)) return "Rate limited by OpenRouter (429). Wait a moment, then try again.";
  if (/network error/i.test(message)) return message;
  if (/model/i.test(message) && /(not found|invalid|available)/i.test(message)) {
    return `${message} Try choosing another model.`;
  }
  return message;
}

async function copyText(text) {
  const value = String(text ?? "");
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const helper = document.createElement("textarea");
    helper.value = value;
    helper.setAttribute("readonly", "");
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.append(helper);
    helper.select();
    try {
      document.execCommand("copy");
    } catch {
      /* ignore */
    }
    helper.remove();
  }
}

function flashCopy(button) {
  const label = button.querySelector("span");
  const original = label ? label.textContent : "";
  button.classList.add("on");
  if (label) label.textContent = "Copied";
  setTimeout(() => {
    button.classList.remove("on");
    if (label) label.textContent = original;
  }, 1400);
}

function slugify(text) {
  return String(text || "chat")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "chat";
}

function download(text, filename, type = "text/markdown") {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ---------------- Theme ---------------- */

function resolvedTheme() {
  const preference = store.settings().theme;
  if (preference === "dark" || preference === "light") return preference;
  return mqDark.matches ? "dark" : "light";
}

function applyTheme() {
  const theme = resolvedTheme();
  document.documentElement.dataset.theme = theme;
  const use = $("#theme-btn use");
  if (use) use.setAttribute("href", theme === "dark" ? "#i-sun" : "#i-moon");
  const button = $("#theme-btn");
  if (button) button.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
}

/* ---------------- Chrome ---------------- */

function updatePromptLabel() {
  const has = store.settings().systemPrompt.trim().length > 0;
  dom.promptLabel.textContent = has ? "Instructions set" : "Set instructions";
  dom.promptBtn.classList.toggle("set", has);
}

function updateAccount() {
  const hasKey = store.settings().apiKey.length > 0;
  dom.accountSub.textContent = hasKey ? "API key saved" : "Add your API key";
}

function updateTopbar() {
  const id = currentModel();
  dom.modelPickerName.textContent = modelName(id);
  dom.modelPickerName.title = id;
  const model = state.models.find((item) => item.id === id);
  dom.modelBadge.hidden = !model?.vision;
}

function updateChrome() {
  updateTopbar();
  updatePromptLabel();
  updateAccount();
}

function updateTokenHint() {
  const chars = dom.input.value.length;
  const images = state.pendingImages.length;
  const tokens = Math.ceil(chars / 4) + images * 780;
  dom.tokenHint.textContent = tokens >= 160 ? `~${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tokens` : "";
}

function updateComposerState() {
  const hasContent = dom.input.value.trim().length > 0 || state.pendingImages.length > 0;
  dom.composer.classList.toggle("streaming", state.sending);

  if (state.sending) {
    dom.send.disabled = false;
    dom.send.setAttribute("aria-label", "Stop generating");
    dom.send.title = "Stop generating";
  } else {
    dom.send.disabled = !hasContent;
    dom.send.setAttribute("aria-label", "Send message");
    dom.send.title = "Send message";
  }
  updateTokenHint();
}

function autoGrow() {
  dom.input.style.height = "auto";
  dom.input.style.height = `${Math.min(dom.input.scrollHeight || 36, 220)}px`;
}

/* ---------------- Sidebar ---------------- */

function startOfDay(timestamp) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function groupConversations(items) {
  const today = startOfDay(Date.now());
  const yesterday = startOfDay(today - 24 * 60 * 60 * 1000);
  const week = startOfDay(today - 6 * 24 * 60 * 60 * 1000);
  const groups = [
    { label: "Today", items: [] },
    { label: "Yesterday", items: [] },
    { label: "Previous 7 days", items: [] },
    { label: "Older", items: [] },
  ];
  for (const conversation of items) {
    const stamp = startOfDay(conversation.updatedAt);
    if (stamp >= today) groups[0].items.push(conversation);
    else if (stamp >= yesterday) groups[1].items.push(conversation);
    else if (stamp >= week) groups[2].items.push(conversation);
    else groups[3].items.push(conversation);
  }
  return groups.filter((group) => group.items.length);
}

function conversationRow(conversation) {
  if (state.renamingId === conversation.id) {
    return `<div class="conv-row active"><input class="conv-rename" data-rename="${conversation.id}" value="${escapeHtml(conversation.title)}" aria-label="Chat name"></div>`;
  }
  const active = conversation.id === state.conversationId ? " active" : "";
  return `<div class="conv-row${active}">
    <a class="conv-link" href="#/c/${conversation.id}" title="${escapeHtml(conversation.title)}">${escapeHtml(conversation.title)}</a>
    <button type="button" class="conv-more" data-menu="${conversation.id}" aria-label="Chat options">
      <svg class="icon"><use href="#i-more"/></svg>
    </button>
  </div>`;
}

function renderSidebar() {
  const items = store.conversations();
  if (!items.length) {
    dom.conversationList.innerHTML = `<div class="conv-empty">Your chats will appear here.</div>`;
    return;
  }
  const groups = groupConversations(items);
  dom.conversationList.innerHTML = groups
    .map(
      (group) => `<div class="conv-group-label">${group.label}</div>${group.items
        .map(conversationRow)
        .join("")}`
    )
    .join("");

  if (state.renamingId) {
    const input = dom.conversationList.querySelector(`[data-rename="${state.renamingId}"]`);
    if (input) {
      input.focus();
      input.select();
    }
  }
}

function commitRename(id, value) {
  if (state.renamingId !== id) return;
  state.renamingId = null;
  const clean = String(value || "").trim();
  if (clean) store.renameConversation(id, clean);
  renderSidebar();
}

function toggleSidebar() {
  if (isMobile()) {
    const open = !dom.app.classList.contains("sidebar-open");
    dom.app.classList.toggle("sidebar-open", open);
    dom.scrim.hidden = !open;
  } else {
    dom.app.classList.toggle("sidebar-collapsed");
  }
}

function closeMobileSidebar() {
  if (!isMobile()) return;
  dom.app.classList.remove("sidebar-open");
  dom.scrim.hidden = true;
}

/* ---------------- Context menu ---------------- */

function closeMenu() {
  if (!state.menu) return;
  state.menu.remove();
  state.menu = null;
}

function openMenu(id, anchor) {
  closeMenu();
  const conversation = store.getConversation(id);
  if (!conversation) return;

  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.innerHTML = `
    <button type="button" class="ctx-item" data-menu-action="rename" data-id="${id}">
      <svg class="icon"><use href="#i-edit"/></svg><span>Rename</span>
    </button>
    <button type="button" class="ctx-item" data-menu-action="export" data-id="${id}">
      <svg class="icon"><use href="#i-download"/></svg><span>Export</span>
    </button>
    <button type="button" class="ctx-item danger" data-menu-action="delete" data-id="${id}">
      <svg class="icon"><use href="#i-trash"/></svg><span>Delete</span>
    </button>`;
  document.body.append(menu);

  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  let left = Math.min(rect.left, window.innerWidth - width - 10);
  let top = rect.bottom + 5;
  if (top + height > window.innerHeight - 10) top = rect.top - height - 5;
  menu.style.left = `${Math.max(10, left)}px`;
  menu.style.top = `${Math.max(10, top)}px`;
  state.menu = menu;
}

function handleMenuAction(action, id) {
  closeMenu();
  const conversation = store.getConversation(id);
  if (!conversation) return;

  if (action === "rename") {
    state.renamingId = id;
    renderSidebar();
    return;
  }
  if (action === "export") {
    download(store.exportConversation(conversation), `${slugify(conversation.title)}.md`);
    toast("Transcript exported");
    return;
  }
  if (action === "delete") {
    if (!confirm(`Delete “${conversation.title}”? This cannot be undone.`)) return;
    store.removeConversation(id);
    if (state.conversationId === id) {
      navigate("#/new");
    } else {
      renderSidebar();
    }
    toast("Chat deleted");
  }
}

/* ---------------- Models ---------------- */

function renderModels() {
  const query = state.modelFilter.trim().toLowerCase();
  const selected = state.modelMode === "default"
    ? state.pendingDefaultModel || store.settings().defaultModel
    : currentModel();

  if (state.modelsLoading && !state.models.length) {
    dom.modelsList.innerHTML = `<div class="models-empty">Loading the OpenRouter catalog…</div>`;
    dom.modelsState.textContent = "";
    return;
  }

  if (!state.models.length) {
    dom.modelsList.innerHTML = `<div class="models-empty">${escapeHtml(
      state.modelsError || "No models available."
    )}</div>`;
    dom.modelsState.textContent = "0 models";
    return;
  }

  const filtered = state.models
    .filter((model) => {
      if (!query) return true;
      return (
        model.id.toLowerCase().includes(query) ||
        model.name.toLowerCase().includes(query) ||
        providerOf(model).toLowerCase().includes(query) ||
        model.description.toLowerCase().includes(query)
      );
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  dom.modelsState.textContent = query
    ? `${filtered.length} of ${state.models.length} models`
    : `${state.models.length} models`;

  if (!filtered.length) {
    dom.modelsList.innerHTML = `<div class="models-empty">No models match “${escapeHtml(state.modelFilter)}”.</div>`;
    return;
  }

  const groups = new Map();
  for (const model of filtered) {
    const provider = providerOf(model);
    if (!groups.has(provider)) groups.set(provider, []);
    groups.get(provider).push(model);
  }

  const html = [];
  for (const [provider, models] of groups) {
    html.push(`<div class="models-section">${escapeHtml(provider)}</div>`);
    for (const model of models) {
      const tags = [
        model.vision ? `<span class="tag">Vision</span>` : "",
        model.reasoning ? `<span class="tag">Reasoning</span>` : "",
      ].join("");
      const meta = [formatContext(model.context), formatPrice(model)].filter(Boolean).join(" · ");
      html.push(`<button type="button" class="model-row${model.id === selected ? " selected" : ""}" data-model-id="${escapeHtml(model.id)}">
        <span class="model-info">
          <span class="model-name">${escapeHtml(model.name)}</span>
          <span class="model-id">${escapeHtml(model.id)}</span>
        </span>
        <span class="model-meta">
          <span class="model-price">${escapeHtml(meta)}</span>
          <span class="model-tags">${tags}</span>
        </span>
        <span class="model-check"><svg class="icon"><use href="#i-check"/></svg></span>
      </button>`);
    }
  }
  dom.modelsList.innerHTML = html.join("");
}

async function loadModels(force = false) {
  if (state.modelsLoading) return;
  const cache = store.cachedModels();
  if (!force && !state.models.length && cache && !cache.stale) {
    state.models = cache.models;
    renderModels();
    updateTopbar();
    return;
  }
  state.modelsLoading = true;
  state.modelsError = "";
  renderModels();
  if (force) dom.modelsState.textContent = "Refreshing…";
  try {
    const models = await fetchModels(store.settings().apiKey);
    state.models = models;
    store.saveModels(models);
    state.modelsError = "";
  } catch (error) {
    state.modelsError = error.message || "Could not load models.";
  } finally {
    state.modelsLoading = false;
    renderModels();
    updateTopbar();
  }
}

function openModels(mode = "chat") {
  state.modelMode = mode;
  if (mode === "default") {
    state.pendingDefaultModel = state.pendingDefaultModel || store.settings().defaultModel;
  }
  state.modelFilter = "";
  $("#models-search").value = "";
  renderModels();
  if (!dom.modelsDialog.open) dom.modelsDialog.showModal();
  $("#models-search").focus();
  if (!state.models.length || store.cachedModels()?.stale) loadModels();
}

function selectModel(id) {
  if (state.modelMode === "default") {
    state.pendingDefaultModel = id;
    $("#default-model-name").textContent = modelName(id);
    dom.modelsDialog.close();
    return;
  }

  store.saveSettings({ defaultModel: id });
  const conversation = currentConversation();
  if (conversation) store.updateConversation(conversation.id, { model: id });
  state.pendingDefaultModel = id;
  dom.modelsDialog.close();
  updateChrome();
  toast(`Model set to ${shortModel(id)}`);
}

/* ---------------- Messages ---------------- */

function assistantMessageHtml(message, context) {
  const reasoning = store.settings().showReasoning && message.reasoning
    ? `<details class="reasoning"${context.streaming ? " open" : ""}>
        <summary><svg class="icon"><use href="#i-chevron-right"/></svg><span>Reasoning</span></summary>
        <div class="reasoning-body">${escapeHtml(message.reasoning)}</div>
      </details>`
    : "";

  let body = "";
  if (message.content) {
    body = `<div class="msg-body">${renderMarkdown(message.content)}</div>`;
  } else if (context.streaming) {
    body = `<div class="msg-body"><div class="typing"><i></i><i></i><i></i></div></div>`;
  } else if (!message.error) {
    body = `<div class="msg-body"><p class="muted-line">No response.</p></div>`;
  }

  const error = message.error
    ? `<div class="msg-error"><svg class="icon"><use href="#i-x"/></svg><span>${escapeHtml(message.error)}</span></div>`
    : "";

  const metaBits = [];
  if (message.model) metaBits.push(escapeHtml(shortModel(message.model)));
  if (Number(message.usage?.total_tokens) > 0) {
    metaBits.push(`${Number(message.usage.total_tokens).toLocaleString()} tokens`);
  }
  if (Number(message.usage?.cost) > 0) metaBits.push(`$${Number(message.usage.cost).toFixed(4)}`);
  if (message.stopped) metaBits.push("stopped");
  const meta = metaBits.length ? `<div class="msg-meta">${metaBits.join(" · ")}</div>` : "";

  const actions = context.streaming
    ? ""
    : `<div class="msg-actions">
        <button type="button" class="icon-btn" data-action="copy" title="Copy" aria-label="Copy response">
          <svg class="icon"><use href="#i-copy"/></svg>
        </button>
        <span class="divider"></span>
        <button type="button" class="icon-btn${message.feedback === 1 ? " on" : ""}" data-action="up" title="Good response" aria-label="Good response" aria-pressed="${message.feedback === 1}">
          <svg class="icon"><use href="#i-thumb-up"/></svg>
        </button>
        <button type="button" class="icon-btn${message.feedback === -1 ? " on" : ""}" data-action="down" title="Bad response" aria-label="Bad response" aria-pressed="${message.feedback === -1}">
          <svg class="icon"><use href="#i-thumb-down"/></svg>
        </button>
        ${context.lastAssistant ? `<button type="button" class="icon-btn" data-action="regen" title="Regenerate" aria-label="Regenerate response">
          <svg class="icon"><use href="#i-refresh"/></svg>
        </button>` : ""}
      </div>`;

  return `<div class="message assistant" data-id="${message.id}">
    <div class="assistant-avatar"><svg class="icon"><use href="#i-spark"/></svg></div>
    <div class="msg-main">
      ${reasoning}
      ${body}
      ${error}
      ${meta}
      ${actions}
    </div>
  </div>`;
}

function userMessageHtml(message, context) {
  const images = message.images?.length
    ? `<div class="user-images">${message.images
        .map((src, index) => `<img src="${src}" alt="Attachment ${index + 1}">`)
        .join("")}</div>`
    : "";
  const bubble = message.content
    ? `<div class="user-bubble">${escapeHtml(message.content)}</div>`
    : "";
  const actions = context.streaming
    ? ""
    : `<div class="user-actions">
        <button type="button" class="icon-btn" data-action="copy" title="Copy" aria-label="Copy message">
          <svg class="icon"><use href="#i-copy"/></svg>
        </button>
      </div>`;
  return `<div class="message user" data-id="${message.id}">
    <div class="user-stack">
      ${images}${bubble}${actions}
    </div>
  </div>`;
}

function messageHtml(message, context) {
  return message.role === "user" ? userMessageHtml(message, context) : assistantMessageHtml(message, context);
}

function renderThread() {
  const conversation = currentConversation();
  if (!conversation || !conversation.messages.length) {
    renderEmpty();
    return;
  }

  const lastIndex = conversation.messages.length - 1;
  const lastAssistant = [...conversation.messages].reverse().find((message) => message.role === "assistant");

  dom.thread.innerHTML = conversation.messages
    .map((message, index) =>
      messageHtml(message, {
        streaming: state.sending && index === lastIndex && message.role === "assistant",
        lastAssistant: message.id === lastAssistant?.id,
        sending: state.sending,
      })
    )
    .join("");
}

const SUGGESTIONS = [
  {
    icon: "i-spark",
    title: "Explain a tricky idea",
    text: "Make a hard concept click",
    prompt: "Explain how transformers work, using a simple analogy and one concrete example.",
  },
  {
    icon: "i-edit",
    title: "Write or edit something",
    text: "Draft, rewrite, or polish",
    prompt: "Write a short, warm email rescheduling a meeting because of a scheduling conflict.",
  },
  {
    icon: "i-star",
    title: "Plan a trip",
    text: "Build an itinerary",
    prompt: "Plan a relaxed 3-day weekend in Kyoto, with local food recommendations and a realistic daily pace.",
  },
  {
    icon: "i-code",
    title: "Debug some code",
    text: "Find and fix a bug",
    prompt: "Help me debug a JavaScript function that is supposed to sum an array but returns undefined. What should I check first?",
  },
];

function renderEmpty() {
  const hasKey = store.settings().apiKey.length > 0;
  const connect = hasKey
    ? ""
    : `<div class="connect-card">
        <span class="connect-card-icon"><svg class="icon"><use href="#i-key"/></svg></span>
        <span class="connect-card-text">
          <span class="connect-card-title">Connect OpenRouter</span>
          <span class="connect-card-sub">Add an API key to chat with any model.</span>
        </span>
        <button type="button" class="btn primary" data-open-settings>Connect</button>
      </div>`;

  dom.thread.innerHTML = `<div class="empty-state">
    <div class="empty-mark"><svg class="icon"><use href="#i-spark"/></svg></div>
    <h1 class="empty-title">What can I help with?</h1>
    <p class="empty-sub">${
      hasKey
        ? "Ask anything — draft, debug, plan, or think out loud."
        : "A private, OpenRouter-powered chat. Your key stays in this browser."
    }</p>
    ${connect}
    <div class="suggestions">
      ${SUGGESTIONS.map(
        (item) => `<button type="button" class="suggestion" data-prompt="${escapeHtml(item.prompt)}">
          <svg class="icon"><use href="#${item.icon}"/></svg>
          <span>
            <span class="suggestion-title">${item.title}</span>
            <span class="suggestion-text">${item.text}</span>
          </span>
        </button>`
      ).join("")}
    </div>
  </div>`;
}

function renderMain() {
  const conversation = currentConversation();
  if (!conversation || !conversation.messages.length) renderEmpty();
  else renderThread();
  updateChrome();
  updateComposerState();
  const canFocus = !isMobile() && document.activeElement === document.body;
  if (!conversation && canFocus) setTimeout(() => dom.input.focus(), 30);
  state.stick = true;
  requestAnimationFrame(() => scrollBottom());
}

function scrollBottom(smooth = false) {
  dom.scroll.scrollTo({ top: dom.scroll.scrollHeight, behavior: smooth ? "smooth" : "auto" });
}

/* ---------------- Routing ---------------- */

function parseRoute() {
  const hash = location.hash || "#/new";
  const match = hash.match(/^#\/c\/([^/?#]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function route() {
  if (state.sending) stopStreaming();
  const id = parseRoute();
  if (id && store.getConversation(id)) {
    state.conversationId = id;
  } else {
    state.conversationId = null;
    if (location.hash !== "#/new") history.replaceState(null, "", "#/new");
  }

  state.renamingId = null;
  state.pendingImages = [];
  dom.input.value = "";
  renderAttachments();
  autoGrow();
  closeMenu();
  closeMobileSidebar();
  renderSidebar();
  renderMain();
}

function navigate(hash) {
  if (location.hash === hash) {
    route();
    return;
  }
  location.hash = hash;
}

/* ---------------- Sending ---------------- */

function clearComposer() {
  dom.input.value = "";
  state.pendingImages = [];
  renderAttachments();
  autoGrow();
  updateComposerState();
}

async function send() {
  if (state.sending) {
    stopStreaming();
    return;
  }

  const text = dom.input.value.trim();
  const images = state.pendingImages.slice();
  if (!text && !images.length) return;

  const settings = store.settings();
  if (!settings.apiKey) {
    openSettings({ focus: "api-key" });
    toast("Add your OpenRouter API key to start chatting.");
    return;
  }

  let conversation = currentConversation();
  if (!conversation) {
    conversation = store.createConversation({ model: settings.defaultModel });
    state.conversationId = conversation.id;
    window.history.replaceState(null, "", `#/c/${conversation.id}`);
  }

  const model = conversation.model || settings.defaultModel;
  if (!model) {
    openModels("chat");
    toast("Choose a model first.");
    return;
  }

  store.addMessage(conversation.id, { role: "user", content: text, images, at: Date.now() });
  store.setTitleFromMessage(conversation.id, text || "Image chat");
  const assistant = store.addMessage(conversation.id, {
    role: "assistant",
    content: "",
    model,
    at: Date.now(),
  });

  clearComposer();
  state.stick = true;
  renderThread();
  renderSidebar();
  scrollBottom();

  const history = conversation.messages.filter((message) => message.id !== assistant.id);
  await runCompletion(conversation.id, assistant.id, history, model);
}

function stopStreaming() {
  state.controller?.abort();
}

async function runCompletion(conversationId, assistantId, history, model) {
  const controller = new AbortController();
  state.controller = controller;
  state.sending = true;
  updateComposerState();

  let content = "";
  let reasoning = "";
  let usage = null;
  let stopped = false;
  let failed = false;
  let frame = 0;

  const findMessage = () => dom.thread.querySelector(`.message[data-id="${assistantId}"]`);
  const bodyElement = findMessage()?.querySelector(".msg-body") || null;
  let reasoningBody = null;

  const paint = () => {
    frame = 0;
    if (state.conversationId !== conversationId || !bodyElement) return;
    bodyElement.innerHTML = renderMarkdown(content);
    if (state.stick) scrollBottom();
  };

  const onDelta = (_chunk, full) => {
    content = full;
    if (!frame) frame = requestAnimationFrame(paint);
  };

  const onReasoning = (_chunk, full) => {
    reasoning = full;
    if (!store.settings().showReasoning) return;
    const element = findMessage();
    if (!element) return;
    if (!reasoningBody) {
      const details = document.createElement("details");
      details.className = "reasoning";
      details.open = true;
      details.innerHTML = `<summary><svg class="icon"><use href="#i-chevron-right"/></svg><span>Reasoning</span></summary><div class="reasoning-body"></div>`;
      element.querySelector(".msg-main").prepend(details);
      reasoningBody = details.querySelector(".reasoning-body");
    }
    reasoningBody.textContent = full;
    if (state.stick) scrollBottom();
  };

  const persist = () => store.updateMessage(conversationId, assistantId, { content, reasoning, usage });
  const timer = setInterval(persist, 600);

  try {
    const settings = store.settings();
    const common = {
      apiKey: settings.apiKey,
      model,
      messages: history,
      systemPrompt: settings.systemPrompt,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      signal: controller.signal,
    };

    let result;
    if (settings.streaming) {
      result = await streamCompletion({ ...common, onDelta, onReasoning });
    } else {
      result = await completeChat(common);
    }

    content = result?.content ?? content;
    reasoning = result?.reasoning ?? reasoning;
    usage = result?.usage ?? usage;
    store.updateMessage(conversationId, assistantId, {
      content,
      reasoning,
      usage,
      stopped: false,
      error: "",
    });
  } catch (error) {
    if (error.name === "AbortError") {
      stopped = true;
      store.updateMessage(conversationId, assistantId, {
        content,
        reasoning,
        usage,
        stopped: true,
        error: "",
      });
    } else {
      failed = true;
      store.updateMessage(conversationId, assistantId, {
        content,
        reasoning,
        usage,
        stopped: false,
        error: friendlyError(error),
      });
    }
  } finally {
    clearInterval(timer);
    if (state.controller === controller) {
      state.controller = null;
      state.sending = false;
    }
    renderSidebar();
    if (state.conversationId === conversationId) {
      renderThread();
      updateComposerState();
      if (state.stick) scrollBottom();
      if (failed) {
        const errorElement = findMessage()?.querySelector(".msg-error");
        errorElement?.scrollIntoView({ block: "nearest" });
      }
    }
  }
}

function regenerate(assistantId) {
  if (state.sending) return;
  const conversation = currentConversation();
  if (!conversation) return;

  store.removeMessagesFrom(conversation.id, assistantId);
  const history = conversation.messages.slice();
  if (!history.length) {
    renderThread();
    return;
  }

  const model = conversation.model || store.settings().defaultModel;
  const assistant = store.addMessage(conversation.id, {
    role: "assistant",
    content: "",
    model,
    at: Date.now(),
  });

  state.stick = true;
  renderThread();
  renderSidebar();
  scrollBottom();
  runCompletion(conversation.id, assistant.id, history, model);
}

/* ---------------- Images ---------------- */

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That image could not be read."));
    };
    image.src = url;
  });
}

async function prepareImage(file) {
  if (file.size > 14 * 1024 * 1024) throw new Error("Images must be smaller than 14 MB.");
  const image = await loadImage(file);
  const scale = Math.min(1, 1024 / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", 0.82);
}

async function addFiles(files) {
  const images = [...files].filter((file) => file.type.startsWith("image/"));
  if (!images.length) return;

  const room = 4 - state.pendingImages.length;
  if (room <= 0) {
    toast("You can attach up to 4 images per message.");
    return;
  }
  if (images.length > room) toast(`Only ${room} more image${room === 1 ? "" : "s"} can be added.`);

  for (const file of images.slice(0, room)) {
    try {
      state.pendingImages.push(await prepareImage(file));
      renderAttachments();
      updateComposerState();
    } catch (error) {
      toast(error.message || "Could not add that image.");
    }
  }
}

function renderAttachments() {
  const has = state.pendingImages.length > 0;
  dom.attachments.hidden = !has;
  dom.attachments.innerHTML = has
    ? state.pendingImages
        .map(
          (src, index) => `<div class="attachment">
            <img src="${src}" alt="Attachment ${index + 1}">
            <button type="button" data-remove-image="${index}" aria-label="Remove image">
              <svg class="icon"><use href="#i-x"/></svg>
            </button>
          </div>`
        )
        .join("")
    : "";
}

/* ---------------- Settings ---------------- */

function fillSettingsForm() {
  const settings = store.settings();
  $("#api-key").value = settings.apiKey;
  $("#api-key").type = "password";
  $("#system-prompt").value = settings.systemPrompt;
  $("#temperature").value = String(settings.temperature);
  $("#temperature-value").textContent = settings.temperature.toFixed(1);
  $("#max-tokens").value = settings.maxTokens ?? "";
  $("#theme-select").value = settings.theme;
  $("#streaming").checked = settings.streaming;
  $("#show-reasoning").checked = settings.showReasoning;
  $("#send-on-enter").checked = settings.sendOnEnter;
  state.pendingDefaultModel = settings.defaultModel;
  $("#default-model-name").textContent = modelName(settings.defaultModel);
  $("#save-state").textContent = "";
}

function openSettings({ focus } = {}) {
  fillSettingsForm();
  if (!dom.settingsDialog.open) dom.settingsDialog.showModal();
  if (focus) {
    const target = document.getElementById(focus);
    if (target) setTimeout(() => target.focus(), 40);
  }
}

function saveSettingsFromForm() {
  const previousKey = store.settings().apiKey;
  const maxRaw = $("#max-tokens").value.trim();
  const maxParsed = maxRaw ? Number(maxRaw) : NaN;
  const next = store.saveSettings({
    apiKey: $("#api-key").value,
    systemPrompt: $("#system-prompt").value,
    temperature: Number($("#temperature").value),
    maxTokens: Number.isFinite(maxParsed) && maxParsed > 0 ? maxParsed : null,
    theme: $("#theme-select").value,
    streaming: $("#streaming").checked,
    showReasoning: $("#show-reasoning").checked,
    sendOnEnter: $("#send-on-enter").checked,
    defaultModel: state.pendingDefaultModel || store.settings().defaultModel,
  });

  const conversation = currentConversation();
  if (conversation && !conversation.messages.length) {
    store.updateConversation(conversation.id, { model: next.defaultModel });
  }

  applyTheme();
  updateChrome();
  dom.settingsDialog.close();
  renderMain();
  if (previousKey !== next.apiKey) loadModels(true);
  toast("Settings saved");
}

/* ---------------- Search ---------------- */

function searchSnippet(conversation, query) {
  if (query) {
    for (const message of [...conversation.messages].reverse()) {
      const text = plainText(message.content);
      const index = text.toLowerCase().indexOf(query);
      if (index !== -1) {
        const start = Math.max(0, index - 34);
        const end = Math.min(text.length, index + query.length + 52);
        return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
      }
    }
  }
  const last = [...conversation.messages].reverse().find((message) => message.content);
  return last ? snippet(last.content, 88) : "Empty chat";
}

function renderSearch() {
  const query = dom.searchInput.value.trim();
  const lower = query.toLowerCase();
  const all = store.conversations();
  const filtered = query
    ? all.filter(
        (conversation) =>
          conversation.title.toLowerCase().includes(lower) ||
          conversation.messages.some((message) => plainText(message.content).toLowerCase().includes(lower))
      )
    : all;

  const items = filtered.slice(0, 40);
  state.searchIds = items.map((conversation) => conversation.id);
  if (state.searchIndex >= items.length) state.searchIndex = 0;

  if (!items.length) {
    dom.searchResults.innerHTML = `<div class="search-empty">No chats found.</div>`;
    return;
  }

  dom.searchResults.innerHTML = items
    .map(
      (conversation, index) => `<button type="button" class="search-item${index === state.searchIndex ? " active" : ""}" data-search-id="${conversation.id}">
        <span class="search-item-title">${escapeHtml(conversation.title)}</span>
        <span class="search-item-snippet">${escapeHtml(searchSnippet(conversation, lower))}</span>
      </button>`
    )
    .join("");
}

function openSearch() {
  closeMenu();
  dom.searchInput.value = "";
  state.searchIndex = 0;
  renderSearch();
  if (!dom.searchDialog.open) dom.searchDialog.showModal();
  setTimeout(() => dom.searchInput.focus(), 30);
}

function openSearchResult(id) {
  dom.searchDialog.close();
  navigate(`#/c/${id}`);
}

/* ---------------- Events ---------------- */

function bindEvents() {
  $("#sidebar-open").addEventListener("click", toggleSidebar);
  $("#sidebar-close").addEventListener("click", toggleSidebar);
  dom.scrim.addEventListener("click", closeMobileSidebar);

  $("#new-chat").addEventListener("click", () => {
    navigate("#/new");
    setTimeout(() => dom.input.focus(), 40);
  });
  $("#search-chats").addEventListener("click", openSearch);
  $("#settings-row").addEventListener("click", () => openSettings());
  $("#account-row").addEventListener("click", () => openSettings());
  $("#avatar-btn").addEventListener("click", () => openSettings());
  $("#prompt-btn").addEventListener("click", () => openSettings({ focus: "system-prompt" }));

  $("#theme-btn").addEventListener("click", () => {
    const next = resolvedTheme() === "dark" ? "light" : "dark";
    store.saveSettings({ theme: next });
    applyTheme();
    if (dom.settingsDialog.open) $("#theme-select").value = next;
  });

  dom.modelPickerName.closest("button")?.addEventListener("click", () => openModels("chat"));

  $("#share-btn").addEventListener("click", async () => {
    const conversation = currentConversation();
    if (!conversation || !conversation.messages.length) {
      toast("Nothing to copy yet.");
      return;
    }
    await copyText(store.exportConversation(conversation));
    toast("Transcript copied");
  });

  dom.conversationList.addEventListener("click", (event) => {
    const more = event.target.closest("[data-menu]");
    if (more) {
      event.preventDefault();
      event.stopPropagation();
      openMenu(more.dataset.menu, more);
    }
  });

  dom.conversationList.addEventListener("keydown", (event) => {
    const input = event.target.closest("[data-rename]");
    if (!input) return;
    if (event.key === "Enter") {
      event.preventDefault();
      commitRename(input.dataset.rename, input.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      state.renamingId = null;
      renderSidebar();
    }
  });

  dom.conversationList.addEventListener("focusout", (event) => {
    const input = event.target.closest("[data-rename]");
    if (!input) return;
    if (state.renamingId === input.dataset.rename) commitRename(input.dataset.rename, input.value);
  });

  document.addEventListener("click", (event) => {
    if (!state.menu) return;
    if (state.menu.contains(event.target)) return;
    if (event.target.closest("[data-menu]")) return;
    closeMenu();
  });

  document.addEventListener("click", (event) => {
    const action = event.target.closest("[data-menu-action]");
    if (!action) return;
    handleMenuAction(action.dataset.menuAction, action.dataset.id);
  });

  $("#refresh-models").addEventListener("click", () => loadModels(true));
  $("#default-model-btn").addEventListener("click", () => openModels("default"));
  $("#models-search").addEventListener("input", (event) => {
    state.modelFilter = event.target.value;
    state.searchIndex = 0;
    renderModels();
  });
  dom.modelsList.addEventListener("click", (event) => {
    const row = event.target.closest("[data-model-id]");
    if (row) selectModel(row.dataset.modelId);
  });

  $("#save-settings").addEventListener("click", saveSettingsFromForm);
  $("#reveal-key").addEventListener("click", () => {
    const input = $("#api-key");
    input.type = input.type === "password" ? "text" : "password";
  });
  $("#temperature").addEventListener("input", (event) => {
    $("#temperature-value").textContent = Number(event.target.value).toFixed(1);
  });
  $("#clear-all").addEventListener("click", () => {
    if (!confirm("Delete all chats and your saved API key? This cannot be undone.")) return;
    store.clearAll();
    state.modelsError = "";
    state.pendingDefaultModel = null;
    applyTheme();
    dom.settingsDialog.close();
    navigate("#/new");
    fillSettingsForm();
    toast("All local data deleted");
  });

  dom.settingsDialog.addEventListener("close", () => {
    state.pendingDefaultModel = null;
    $("#save-state").textContent = "";
  });

  $$("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  });

  dom.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    send();
  });

  dom.input.addEventListener("input", () => {
    autoGrow();
    updateComposerState();
  });

  dom.input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    const settings = store.settings();
    if (settings.sendOnEnter || event.metaKey || event.ctrlKey) {
      event.preventDefault();
      send();
    }
  });

  dom.input.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith("image/"));
    if (files.length) {
      event.preventDefault();
      addFiles(files);
    }
  });

  $("#attach-btn").addEventListener("click", () => dom.fileInput.click());
  dom.fileInput.addEventListener("change", () => {
    if (dom.fileInput.files?.length) addFiles(dom.fileInput.files);
    dom.fileInput.value = "";
  });

  dom.attachments.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-remove-image]");
    if (!remove) return;
    state.pendingImages.splice(Number(remove.dataset.removeImage), 1);
    renderAttachments();
    updateComposerState();
  });

  const composer = dom.composer;
  composer.addEventListener("dragover", (event) => {
    event.preventDefault();
    composer.classList.add("dragover");
  });
  composer.addEventListener("dragleave", () => composer.classList.remove("dragover"));
  composer.addEventListener("drop", (event) => {
    event.preventDefault();
    composer.classList.remove("dragover");
    if (event.dataTransfer?.files?.length) addFiles(event.dataTransfer.files);
  });

  $("#mic-btn").addEventListener("click", toggleDictation);

  dom.thread.addEventListener("click", async (event) => {
    const codeButton = event.target.closest("[data-copy-code]");
    if (codeButton) {
      const block = codeButton.closest(".code-block");
      await copyText(block?.dataset.code || "");
      flashCopy(codeButton);
      return;
    }

    const settingsButton = event.target.closest("[data-open-settings]");
    if (settingsButton) {
      openSettings({ focus: "api-key" });
      return;
    }

    const suggestion = event.target.closest("[data-prompt]");
    if (suggestion) {
      dom.input.value = suggestion.dataset.prompt;
      autoGrow();
      updateComposerState();
      send();
      return;
    }

    const action = event.target.closest("[data-action]");
    if (!action) return;
    const messageElement = action.closest(".message");
    if (!messageElement) return;
    const message = currentConversation()?.messages.find((item) => item.id === messageElement.dataset.id);
    if (!message) return;

    if (action.dataset.action === "copy") {
      await copyText(message.content);
      toast("Copied to clipboard");
      return;
    }
    if (action.dataset.action === "regen") {
      regenerate(message.id);
      return;
    }
    if (action.dataset.action === "up" || action.dataset.action === "down") {
      const value = action.dataset.action === "up" ? 1 : -1;
      const next = message.feedback === value ? 0 : value;
      store.updateMessage(state.conversationId, message.id, { feedback: next });
      const up = messageElement.querySelector('[data-action="up"]');
      const down = messageElement.querySelector('[data-action="down"]');
      up?.classList.toggle("on", next === 1);
      down?.classList.toggle("on", next === -1);
      up?.setAttribute("aria-pressed", String(next === 1));
      down?.setAttribute("aria-pressed", String(next === -1));
    }
  });

  dom.searchInput.addEventListener("input", () => {
    state.searchIndex = 0;
    renderSearch();
  });

  dom.searchInput.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      state.searchIndex = Math.min(state.searchIndex + 1, state.searchIds.length - 1);
      renderSearch();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      state.searchIndex = Math.max(state.searchIndex - 1, 0);
      renderSearch();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const id = state.searchIds[state.searchIndex];
      if (id) openSearchResult(id);
    }
  });

  dom.searchResults.addEventListener("click", (event) => {
    const item = event.target.closest("[data-search-id]");
    if (item) openSearchResult(item.dataset.searchId);
  });
  $("#search-close").addEventListener("click", () => dom.searchDialog.close());

  document.addEventListener("keydown", (event) => {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (dom.searchDialog.open) dom.searchDialog.close();
      else openSearch();
      return;
    }
    if (mod && event.shiftKey && event.key.toLowerCase() === "o") {
      event.preventDefault();
      navigate("#/new");
      setTimeout(() => dom.input.focus(), 30);
      return;
    }
    if (event.key === "Escape") {
      closeMenu();
      if (isMobile() && dom.app.classList.contains("sidebar-open")) closeMobileSidebar();
    }
  });

  dom.scroll.addEventListener(
    "scroll",
    () => {
      const distance = dom.scroll.scrollHeight - dom.scroll.scrollTop - dom.scroll.clientHeight;
      state.stick = distance < 90;
    },
    { passive: true }
  );

  window.addEventListener("hashchange", route);
  window.addEventListener("resize", () => {
    closeMenu();
    if (!isMobile()) {
      dom.app.classList.remove("sidebar-open");
      dom.scrim.hidden = true;
    }
  });

  mqDark.addEventListener("change", () => {
    if (store.settings().theme === "system") applyTheme();
  });
}

/* ---------------- Dictation ---------------- */

let recognition = null;

function toggleDictation() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const button = $("#mic-btn");
  if (!SpeechRecognition) {
    toast("Dictation is not supported in this browser.");
    return;
  }

  if (state.listening) {
    recognition?.stop();
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = navigator.language || "en-US";
  recognition.interimResults = true;
  recognition.continuous = false;

  const base = dom.input.value;
  let finalText = "";

  recognition.onstart = () => {
    state.listening = true;
    button.classList.add("on");
  };
  recognition.onresult = (event) => {
    let interim = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (result.isFinal) finalText += result[0].transcript;
      else interim += result[0].transcript;
    }
    const joined = `${base}${finalText}${interim}`.replace(/\s+/g, " ").trimStart();
    dom.input.value = joined;
    autoGrow();
    updateComposerState();
  };
  recognition.onerror = (event) => {
    if (event.error === "not-allowed") toast("Microphone permission was denied.");
    else if (event.error !== "aborted") toast("Dictation stopped unexpectedly.");
  };
  recognition.onend = () => {
    state.listening = false;
    button.classList.remove("on");
  };

  try {
    recognition.start();
  } catch {
    toast("Could not start dictation.");
  }
}

/* ---------------- Init ---------------- */

function init() {
  applyTheme();
  updateChrome();
  autoGrow();
  renderAttachments();

  const cache = store.cachedModels();
  if (cache) state.models = cache.models;

  bindEvents();
  route();

  if (!cache || cache.stale) loadModels();
}

init();
