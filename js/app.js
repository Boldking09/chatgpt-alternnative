import * as store from "./store.js";
import { renderMarkdown, escapeHtml, plainText, snippet } from "./markdown.js";
import { deleteAudio, getAudio, putAudio, clearAudio } from "./audio-store.js";
import {
  fetchModels,
  fetchVideoModels,
  fetchSpeechModels,
  streamCompletion,
  completeChat,
  createVideoGeneration,
  createSpeech,
  speechAudioReference,
  videoAudioReference,
  fetchVideoJob,
  fetchVideoContent,
  waitForVideoGeneration,
  videoJobUrls,
  estimateVideoCost,
  estimateSpeechCost,
  formatVideoCost,
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
  videoOptions: $("#video-options"),
  videoAspect: $("#video-aspect"),
  videoDuration: $("#video-duration"),
  videoResolution: $("#video-resolution"),
  videoAudio: $("#video-audio"),
  videoAudioRow: $("#video-audio-row"),
  videoEstimate: $("#video-estimate"),
  speechOptions: $("#speech-options"),
  speechVoice: $("#speech-voice"),
  speechSpeed: $("#speech-speed"),
  speechInstructions: $("#speech-instructions"),
  speechEstimate: $("#speech-estimate"),
  speechReferenceBtn: $("#speech-reference-btn"),
  speechReferenceChip: $("#speech-reference-chip"),
  speechReferenceClear: $("#speech-reference-clear"),
  speechReferenceName: $("#speech-reference-name"),
  speechTranscriptRow: $("#speech-transcript-row"),
  speechTranscript: $("#speech-transcript"),
  videoReferenceBtn: $("#video-reference-btn"),
  videoReferenceChip: $("#video-reference-chip"),
  videoReferenceName: $("#video-reference-name"),
  videoReferenceClear: $("#video-reference-clear"),
  audioInput: $("#audio-input"),
  voiceDatalist: $("#speech-voices"),
  voiceoverDialog: $("#voiceover-dialog"),
  voiceoverModel: $("#voiceover-model"),
  voiceoverVoice: $("#voiceover-voice"),
  voiceoverScript: $("#voiceover-script"),
  voiceoverInstructions: $("#voiceover-instructions"),
  voiceoverReferenceBtn: $("#voiceover-reference-btn"),
  voiceoverReferenceChip: $("#voiceover-reference-chip"),
  voiceoverReferenceName: $("#voiceover-reference-name"),
  voiceoverReferenceClear: $("#voiceover-reference-clear"),
  voiceoverTranscriptRow: $("#voiceover-transcript-row"),
  voiceoverTranscript: $("#voiceover-transcript"),
  voiceoverState: $("#voiceover-state"),
  voiceoverGenerate: $("#voiceover-generate"),
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
  videoCache: new Map(),
  videoLoading: new Set(),
  audioCache: new Map(),
  audioLoading: new Set(),
  audioMissing: new Set(),
  speechReference: null,
  videoReference: null,
  voiceoverReference: null,
  audioTarget: "",
  voiceoverMessageId: null,
  voiceoverConversationId: null,
  voiceoverController: null,
  voiceoverBusy: false,
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

function currentModelInfo() {
  const id = currentModel();
  return state.models.find((item) => item.id === id) || null;
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

function releaseVideoCache(video) {
  const jobId = video?.jobId;
  if (!jobId) return;
  const cached = state.videoCache.get(jobId);
  if (!cached) return;
  state.videoCache.delete(jobId);
  setTimeout(() => URL.revokeObjectURL(cached.url), 0);
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

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function audioKey(kind, id) {
  return `${kind}:${id}`;
}

function releaseAudio(key) {
  const cached = state.audioCache.get(key);
  if (cached) {
    state.audioCache.delete(key);
    setTimeout(() => URL.revokeObjectURL(cached.url), 0);
  }
  state.audioMissing.delete(key);
  state.audioLoading.delete(key);
  void deleteAudio(key);
}

function releaseMessageAudio(message) {
  if (!message?.id) return;
  releaseAudio(audioKey("speech", message.id));
  releaseAudio(audioKey("voiceover", message.id));
}

function audioExtension(type) {
  const value = String(type || "").toLowerCase();
  if (value.includes("wav")) return "wav";
  if (value.includes("ogg")) return "ogg";
  if (value.includes("opus")) return "opus";
  if (value.includes("aac")) return "aac";
  if (value.includes("flac")) return "flac";
  if (value.includes("mpeg")) return "mp3";
  return "mp3";
}

function playAudioKey(key) {
  const audio = dom.thread.querySelector(`audio[data-audio-key="${key}"]`);
  if (!audio) return;
  audio.play().catch(() => {});
}

async function loadStoredAudio(kind, messageId) {
  const key = audioKey(kind, messageId);
  if (state.audioCache.has(key) || state.audioLoading.has(key) || state.audioMissing.has(key)) return;
  state.audioLoading.add(key);
  const stored = await getAudio(key);
  state.audioLoading.delete(key);
  if (stored instanceof Blob && stored.size) {
    state.audioCache.set(key, { url: URL.createObjectURL(stored), blob: stored });
  } else {
    state.audioMissing.add(key);
  }
  if (state.conversationId) renderThread();
}

function hydrateAudio() {
  if (document.hidden) return;
  const conversation = currentConversation();
  if (!conversation) return;
  const pending = conversation.messages
    .filter((message) => {
      const speech = message.speech;
      const voiceover = message.voiceover;
      return (
        (speech?.status === "completed" && !speech.error) ||
        (voiceover?.status === "completed" && !voiceover.error)
      );
    })
    .slice(0, 4);
  for (const message of pending) {
    if (message.speech?.status === "completed" && !message.speech.error) {
      void loadStoredAudio("speech", message.id);
    }
    if (message.voiceover?.status === "completed" && !message.voiceover.error) {
      void loadStoredAudio("voiceover", message.id);
    }
  }
}

function speechModels() {
  return state.models.filter((model) => model.kind === "speech");
}

function speechReferences(reference) {
  if (!reference?.data) return [];
  const parts = speechAudioReference(reference.data, reference.transcript);
  return parts || [];
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function renderSpeechReference() {
  const reference = state.speechReference;
  if (dom.speechReferenceChip) dom.speechReferenceChip.hidden = !reference;
  if (dom.speechReferenceName) dom.speechReferenceName.textContent = reference?.name || "";
  if (dom.speechTranscriptRow) dom.speechTranscriptRow.hidden = !reference;
  if (dom.speechTranscript && reference) dom.speechTranscript.value = reference.transcript || "";
}

function renderVideoReference() {
  const reference = state.videoReference;
  if (dom.videoReferenceChip) dom.videoReferenceChip.hidden = !reference;
  if (dom.videoReferenceName) dom.videoReferenceName.textContent = reference?.name || "";
}

function renderVoiceoverReference() {
  const reference = state.voiceoverReference;
  if (dom.voiceoverReferenceChip) dom.voiceoverReferenceChip.hidden = !reference;
  if (dom.voiceoverReferenceName) dom.voiceoverReferenceName.textContent = reference?.name || "";
  if (dom.voiceoverTranscriptRow) dom.voiceoverTranscriptRow.hidden = !reference;
  if (dom.voiceoverTranscript && reference) dom.voiceoverTranscript.value = reference.transcript || "";
}

function readAudioSample(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error("Choose an audio file."));
      return;
    }
    const name = String(file.name || "").toLowerCase();
    const audio = file.type.startsWith("audio/") || /\.(wav|mp3|m4a|aac|ogg|opus|webm|flac)$/.test(name);
    if (!audio) {
      reject(new Error("Choose an audio file such as WAV, MP3, M4A, or OGG."));
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      reject(new Error("Audio samples must be smaller than 12 MB."));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string" || !reader.result.startsWith("data:audio/")) {
        reject(new Error("That audio file could not be read."));
        return;
      }
      resolve({ data: reader.result, name: file.name || "Audio sample", size: file.size, type: file.type });
    };
    reader.onerror = () => reject(new Error("That audio file could not be read."));
    reader.readAsDataURL(file);
  });
}

function chooseAudioSample(target) {
  state.audioTarget = target;
  dom.audioInput.value = "";
  dom.audioInput.click();
}

async function applyAudioSample(file) {
  const target = state.audioTarget;
  state.audioTarget = "";
  if (!file || !target) return;
  try {
    const sample = await readAudioSample(file);
    if (target === "speech") {
      state.speechReference = sample;
      renderSpeechReference();
      updateSpeechEstimate();
    } else if (target === "video") {
      state.videoReference = sample;
      renderVideoReference();
    } else if (target === "voiceover") {
      state.voiceoverReference = sample;
      renderVoiceoverReference();
    }
    toast(`Added ${sample.name}`);
  } catch (error) {
    toast(error.message || "That audio file could not be used.");
  }
}

function fillVoiceDatalist() {
  if (!dom.voiceDatalist) return;
  const voices = [...new Set(speechModels().flatMap((model) => model.voices || []))].sort();
  dom.voiceDatalist.innerHTML = voices
    .map((voice) => `<option value="${escapeHtml(voice)}"></option>`)
    .join("");
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
  const video = model?.kind === "video";
  const speech = model?.kind === "speech";
  dom.modelBadge.hidden = !model?.vision && !video && !speech;
  dom.modelBadge.textContent = video ? "video" : speech ? "speech" : "vision";
  dom.modelBadge.classList.toggle("video", video);
  dom.modelBadge.classList.toggle("speech", speech);
}

function updateChrome() {
  updateTopbar();
  updatePromptLabel();
  updateAccount();
  syncVideoOptions();
  syncSpeechOptions();
}

function updateTokenHint() {
  if (["video", "speech"].includes(currentModelInfo()?.kind)) {
    dom.tokenHint.textContent = "";
    return;
  }
  const chars = dom.input.value.length;
  const images = state.pendingImages.length;
  const tokens = Math.ceil(chars / 4) + images * 780;
  dom.tokenHint.textContent = tokens >= 160 ? `~${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tokens` : "";
}

function nearestValue(values, value) {
  const number = Number(value);
  if (!values.length) return Number.isFinite(number) ? number : 0;
  if (!Number.isFinite(number)) return values[0];
  return values.reduce((best, item) => (Math.abs(item - number) < Math.abs(best - number) ? item : best), values[0]);
}

function clampVideoOptions(model, input = {}) {
  const settings = store.settings();
  const durations = Array.isArray(model?.durations) ? model.durations : [];
  const resolutions = Array.isArray(model?.resolutions) ? model.resolutions : [];
  const aspectRatios = Array.isArray(model?.aspectRatios) ? model.aspectRatios : [];

  const duration = durations.length
    ? nearestValue(durations, input.duration ?? settings.videoDuration)
    : Number(input.duration) || Number(settings.videoDuration) || 8;

  let resolution = input.resolution ?? settings.videoResolution;
  if (!resolutions.includes(resolution)) {
    resolution = resolutions.includes("720p") ? "720p" : resolutions[0] || "720p";
  }

  let aspectRatio = input.aspectRatio ?? settings.videoAspectRatio;
  if (!aspectRatios.includes(aspectRatio)) {
    aspectRatio = aspectRatios.includes("16:9") ? "16:9" : aspectRatios[0] || "16:9";
  }

  return {
    duration,
    resolution,
    aspectRatio,
    generateAudio: Boolean(model?.generateAudio) && Boolean(input.generateAudio),
  };
}

function videoOptionsFromControls() {
  const model = currentModelInfo();
  if (model?.kind !== "video") return null;
  return clampVideoOptions(model, {
    duration: dom.videoDuration?.value,
    resolution: dom.videoResolution?.value,
    aspectRatio: dom.videoAspect?.value,
    generateAudio: dom.videoAudio?.checked,
  });
}

function fillVideoSelect(select, values, label) {
  if (!select) return;
  select.innerHTML = values
    .map((value) => `<option value="${escapeHtml(String(value))}">${escapeHtml(label(value))}</option>`)
    .join("");
}

function updateVideoEstimate(options = videoOptionsFromControls()) {
  const model = currentModelInfo();
  if (!dom.videoEstimate) return;
  if (model?.kind !== "video" || !options) {
    dom.videoEstimate.textContent = "";
    dom.videoEstimate.title = "";
    return;
  }
  const cost = estimateVideoCost(model, options);
  dom.videoEstimate.textContent = cost === null ? "" : `Est. ${formatVideoCost(cost)}`;
  dom.videoEstimate.title = cost === null
    ? "Pricing is not published for this model."
    : `Estimated for ${options.duration}s at ${options.resolution}${options.generateAudio ? " with audio" : ""}. Final cost may differ.`;
}

function syncVideoOptions() {
  if (!dom.videoOptions) return;
  const model = currentModelInfo();
  const video = model?.kind === "video";
  dom.videoOptions.hidden = !video;

  if (!video) {
    dom.videoOptions.dataset.signature = "";
    updateVideoEstimate(null);
    return;
  }

  const durations = model.durations?.length ? model.durations : [Number(store.settings().videoDuration) || 8];
  const resolutions = model.resolutions?.length ? model.resolutions : [store.settings().videoResolution || "720p"];
  const aspectRatios = model.aspectRatios?.length ? model.aspectRatios : [store.settings().videoAspectRatio || "16:9"];
  const signature = [model.id, durations.join(","), resolutions.join(","), aspectRatios.join(","), Boolean(model.generateAudio)].join("|");

  if (dom.videoOptions.dataset.signature !== signature) {
    fillVideoSelect(dom.videoAspect, aspectRatios, (value) => value);
    fillVideoSelect(dom.videoDuration, durations, (value) => `${value}s`);
    fillVideoSelect(dom.videoResolution, resolutions, (value) => value);
    dom.videoOptions.dataset.signature = signature;
  }

  const options = clampVideoOptions(model, {
    duration: dom.videoDuration?.value,
    resolution: dom.videoResolution?.value,
    aspectRatio: dom.videoAspect?.value,
    generateAudio: Boolean(dom.videoAudio?.checked) || Boolean(store.settings().videoAudio),
  });

  if (dom.videoDuration) dom.videoDuration.value = String(options.duration);
  if (dom.videoResolution) dom.videoResolution.value = options.resolution;
  if (dom.videoAspect) dom.videoAspect.value = options.aspectRatio;
  if (dom.videoAudioRow) dom.videoAudioRow.hidden = !model.generateAudio;
  if (dom.videoAudio) dom.videoAudio.checked = options.generateAudio;

  const settings = store.settings();
  if (
    settings.videoDuration !== options.duration ||
    settings.videoResolution !== options.resolution ||
    settings.videoAspectRatio !== options.aspectRatio ||
    settings.videoAudio !== options.generateAudio
  ) {
    store.saveSettings({
      videoDuration: options.duration,
      videoResolution: options.resolution,
      videoAspectRatio: options.aspectRatio,
      videoAudio: options.generateAudio,
    });
  }
  updateVideoEstimate(options);
}

function clampSpeechSpeed(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.min(2, Math.max(0.5, Math.round(number * 100) / 100));
}

function speechOptionsFromControls() {
  const model = currentModelInfo();
  if (model?.kind !== "speech") return null;
  return {
    voice: dom.speechVoice?.value.trim() || "",
    speed: clampSpeechSpeed(dom.speechSpeed?.value),
    instructions: dom.speechInstructions?.value.trim() || "",
    reference: state.speechReference,
  };
}

function updateSpeechEstimate() {
  if (!dom.speechEstimate) return;
  const model = currentModelInfo();
  if (model?.kind !== "speech") {
    dom.speechEstimate.textContent = "";
    dom.speechEstimate.title = "";
    return;
  }
  const cost = estimateSpeechCost(model, dom.input.value);
  dom.speechEstimate.textContent = cost === null ? "" : `Est. ${formatVideoCost(cost)}`;
  dom.speechEstimate.title = cost === null
    ? "Pricing is not published for this model."
    : "Estimated from the text length. Final cost may differ.";
}

function syncSpeechOptions() {
  if (!dom.speechOptions) return;
  const model = currentModelInfo();
  const speech = model?.kind === "speech";
  dom.speechOptions.hidden = !speech;
  fillVoiceDatalist();

  const attach = $("#attach-btn");
  if (attach) attach.disabled = speech || model?.kind === "video";
  if (speech) dom.input.placeholder = "Type the words to speak";
  else if (model?.kind === "video") dom.input.placeholder = "Describe the video you want to generate";
  else dom.input.placeholder = "Ask anything";

  if (!speech) {
    dom.speechOptions.dataset.model = "";
    updateSpeechEstimate();
    return;
  }

  if (dom.speechOptions.dataset.model !== model.id) {
    dom.speechOptions.dataset.model = model.id;
    const settings = store.settings();
    const voice = settings.speechVoice && (!model.voices?.length || model.voices.includes(settings.speechVoice))
      ? settings.speechVoice
      : model.voices?.[0] || "";
    if (dom.speechVoice) dom.speechVoice.value = voice;
    if (dom.speechSpeed) dom.speechSpeed.value = String(settings.speechSpeed);
    if (dom.speechInstructions) dom.speechInstructions.value = settings.speechInstructions;
  }
  updateSpeechEstimate();
}

function updateComposerState() {
  const hasContent = dom.input.value.trim().length > 0 || state.pendingImages.length > 0;
  dom.composer.classList.toggle("streaming", state.sending);

  if (state.sending) {
    dom.send.disabled = false;
    dom.send.setAttribute("aria-label", "Stop generating");
    dom.send.title = "Stop generating";
  } else {
    const speech = currentModelInfo()?.kind === "speech";
    const label = speech ? "Generate speech" : "Send message";
    dom.send.disabled = !hasContent;
    dom.send.setAttribute("aria-label", label);
    dom.send.title = label;
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
    for (const message of conversation.messages) releaseVideoCache(message.video);
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

  const countLabel = query
    ? `${filtered.length} of ${state.models.length} models`
    : `${state.models.length} models`;
  dom.modelsState.textContent = state.modelsError ? `${countLabel} · catalog warning` : countLabel;

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
        model.kind === "video" ? `<span class="tag video">Video</span>` : "",
        model.kind === "video" && model.generateAudio ? `<span class="tag">Audio</span>` : "",
        model.kind === "speech" ? `<span class="tag speech">Speech</span>` : "",
        model.kind === "speech" && model.cloning ? `<span class="tag">Cloning</span>` : "",
        model.vision ? `<span class="tag">Vision</span>` : "",
        model.reasoning ? `<span class="tag">Reasoning</span>` : "",
      ].join("");
      const meta = model.kind === "video" || model.kind === "speech"
        ? formatPrice(model)
        : [formatContext(model.context), formatPrice(model)].filter(Boolean).join(" · ");
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
    updateChrome();
    return;
  }
  state.modelsLoading = true;
  state.modelsError = "";
  renderModels();
  if (force) dom.modelsState.textContent = "Refreshing…";

  const cachedVideo = state.models.filter((model) => model.kind === "video");
  const cachedSpeech = state.models.filter((model) => model.kind === "speech");
  const [chatResult, videoResult, speechResult] = await Promise.allSettled([
    fetchModels(store.settings().apiKey),
    fetchVideoModels(store.settings().apiKey),
    fetchSpeechModels(store.settings().apiKey),
  ]);

  if (chatResult.status === "rejected") {
    state.modelsLoading = false;
    state.modelsError = chatResult.reason?.message || "Could not load models.";
    renderModels();
    updateChrome();
    return;
  }

  const merged = new Map(chatResult.value.map((model) => [model.id, model]));
  const warnings = [];

  let videoModels = cachedVideo;
  if (videoResult.status === "fulfilled" && videoResult.value.length) {
    videoModels = videoResult.value;
  } else if (videoResult.status === "rejected") {
    warnings.push(videoResult.reason?.message || "Video models could not be loaded.");
  } else {
    warnings.push("OpenRouter returned no video models.");
  }
  for (const model of videoModels) merged.set(model.id, model);

  let speechCatalog = cachedSpeech;
  if (speechResult.status === "fulfilled" && speechResult.value.length) {
    speechCatalog = speechResult.value;
  } else if (speechResult.status === "rejected") {
    warnings.push(speechResult.reason?.message || "Speech models could not be loaded.");
  } else {
    warnings.push("OpenRouter returned no speech models.");
  }
  for (const model of speechCatalog) merged.set(model.id, model);

  state.models = [...merged.values()];
  state.modelsError = warnings.join(" ");
  state.modelsLoading = false;
  if (!warnings.length) store.saveModels(state.models);
  renderModels();
  updateChrome();
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

  const chosen = state.models.find((item) => item.id === id);
  const patch = { defaultModel: id };
  if (chosen?.kind === "speech") patch.speechModel = id;
  store.saveSettings(patch);
  const conversation = currentConversation();
  if (conversation) store.updateConversation(conversation.id, { model: id });
  state.pendingDefaultModel = id;
  dom.modelsDialog.close();
  updateChrome();
  updateComposerState();
  if (chosen?.kind === "video" && state.pendingImages.length) {
    toast("Video models accept text prompts only — attachments will not be sent.");
  } else if (chosen?.kind === "speech" && state.pendingImages.length) {
    toast("Speech models accept text only — attachments will not be sent.");
  } else {
    toast(`Model set to ${shortModel(id)}`);
  }
}

/* ---------------- Messages ---------------- */

const VIDEO_STATUS_LABELS = {
  pending: "Queued",
  in_progress: "Rendering",
  completed: "Ready",
  failed: "Failed",
  cancelled: "Cancelled",
  expired: "Expired",
};

function jobError(job) {
  const error = job?.error;
  if (!error) return "";
  if (typeof error === "string") return error;
  if (typeof error.message === "string") return error.message;
  try {
    return JSON.stringify(error).slice(0, 400);
  } catch {
    return "The video job reported an error.";
  }
}

function mergeVideoJob(video, job) {
  const cost = Number(job?.usage?.cost);
  const expires = Number(job?.expires_at);
  return {
    ...video,
    jobId: typeof job?.id === "string" && job.id ? job.id : video.jobId,
    pollingUrl: typeof job?.polling_url === "string" && job.polling_url ? job.polling_url : video.pollingUrl,
    status: typeof job?.status === "string" && job.status ? job.status : video.status,
    cost: Number.isFinite(cost) && cost >= 0 ? cost : video.cost,
    expiresAt: Number.isFinite(expires) && expires > 0 ? expires : video.expiresAt,
    error: jobError(job),
  };
}

function videoCardHtml(message) {
  const video = message.video;
  const cached = state.videoCache.get(video.jobId);
  const busy = state.videoLoading.has(video.jobId);
  const label = VIDEO_STATUS_LABELS[video.status] || "Working";
  const detail = [video.duration ? `${video.duration}s` : "", video.resolution, video.aspectRatio, video.generateAudio ? "audio" : ""]
    .filter(Boolean)
    .join(" · ");
  const cost = Number(video.cost) > 0
    ? formatVideoCost(video.cost)
    : Number(video.estimatedCost) > 0
      ? `est. ${formatVideoCost(video.estimatedCost)}`
      : "";

  let stage = "";
  if (cached) {
    stage = `<video class="video-player" src="${cached.url}" controls playsinline preload="metadata"></video>`;
  } else if (video.status === "completed" && video.error) {
    stage = `<div class="video-placeholder failed"><svg class="icon"><use href="#i-x"/></svg><span>Video ready, but the file could not be loaded.</span></div>`;
  } else if (video.status === "completed") {
    stage = `<div class="video-placeholder"><span class="spinner"></span><span>Loading video…</span></div>`;
  } else if (["failed", "cancelled", "expired"].includes(video.status)) {
    stage = `<div class="video-placeholder failed"><svg class="icon"><use href="#i-x"/></svg><span>${escapeHtml(label)}</span></div>`;
  } else {
    stage = `<div class="video-placeholder"><span class="spinner"></span><span>${escapeHtml(label)}…</span><small>This can take a few minutes.</small></div>`;
  }

  const error = video.error
    ? `<div class="msg-error video-error"><svg class="icon"><use href="#i-x"/></svg><span>${escapeHtml(video.error)}</span></div>`
    : "";

  const refresh = cached
    ? ""
    : `<button type="button" class="chip-btn" data-video-refresh="${message.id}"${busy ? " disabled" : ""}>
        <svg class="icon"><use href="#i-refresh"/></svg><span>${busy ? "Checking…" : "Check status"}</span>
      </button>`;
  const downloadButton = cached
    ? `<a class="chip-btn" href="${cached.url}" download="ourchat-${escapeHtml(video.jobId)}.mp4">
        <svg class="icon"><use href="#i-download"/></svg><span>Download</span>
      </a>`
    : `<button type="button" class="chip-btn" disabled><svg class="icon"><use href="#i-download"/></svg><span>Download</span></button>`;
  const voiceoverBusy = message.voiceover?.status === "generating" || state.voiceoverBusy;
  const voiceoverButton = cached && speechModels().length
    ? `<button type="button" class="chip-btn" data-voiceover="${message.id}"${voiceoverBusy ? " disabled" : ""}>
        <svg class="icon"><use href="#i-mic"/></svg><span>${message.voiceover ? "Redo voiceover" : "Add voiceover"}</span>
      </button>`
    : "";
  const voiceover = voiceoverCardHtml(message);

  return `<div class="video-card" data-video-message="${message.id}" data-video-job="${escapeHtml(video.jobId)}">
    <div class="video-stage">${stage}</div>
    <div class="video-info">
      <div class="video-status">
        <span class="video-status-label${video.status === "failed" ? " error" : ""}">${escapeHtml(label)}</span>
        <span class="video-status-detail">${escapeHtml(detail)}</span>
        ${cost ? `<span class="video-cost">${escapeHtml(cost)}</span>` : ""}
      </div>
      <div class="video-actions">${refresh}${downloadButton}${voiceoverButton}</div>
      ${voiceover}
    </div>
    ${error}
  </div>`;
}

function speechCardHtml(message) {
  const speech = message.speech;
  if (!speech) return "";
  const key = audioKey("speech", message.id);
  const cached = state.audioCache.get(key);
  const loading = state.audioLoading.has(key);
  const missing = state.audioMissing.has(key);
  const failed = speech.status === "failed" || Boolean(speech.error);
  const detail = [
    speech.voice ? `Voice ${speech.voice}` : "",
    speech.format ? speech.format.toUpperCase() : "",
    formatBytes(speech.bytes),
    speech.referenceName ? `cloned from ${speech.referenceName}` : "",
    Number(speech.estimatedCost) > 0 ? `est. ${formatVideoCost(speech.estimatedCost)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  let stage = "";
  if (cached) {
    stage = `<audio class="audio-player" src="${cached.url}" data-audio-key="${key}" controls preload="metadata"></audio>`;
  } else if (failed) {
    stage = `<div class="audio-placeholder failed"><svg class="icon"><use href="#i-x"/></svg><span>${escapeHtml(speech.error || "Speech generation failed.")}</span></div>`;
  } else if (loading || speech.status === "generating") {
    stage = `<div class="audio-placeholder"><span class="spinner"></span><span>Generating speech…</span></div>`;
  } else if (missing) {
    stage = `<div class="audio-placeholder failed"><svg class="icon"><use href="#i-x"/></svg><span>Audio file is not available.</span></div>`;
  } else {
    stage = `<div class="audio-placeholder"><span class="spinner"></span><span>Loading audio…</span></div>`;
  }

  const download = cached
    ? `<a class="chip-btn" href="${cached.url}" download="ourchat-speech-${escapeHtml(message.id)}.${escapeHtml(speech.format || "mp3")}">
        <svg class="icon"><use href="#i-download"/></svg><span>Download audio</span>
      </a>`
    : "";

  return `<div class="audio-card">
    <div class="audio-stage">${stage}</div>
    <div class="audio-info">
      <div class="audio-title"><svg class="icon"><use href="#i-mic"/></svg><span>Speech</span></div>
      <div class="audio-detail">${escapeHtml(detail || "Generated audio")}</div>
      ${download ? `<div class="audio-actions">${download}</div>` : ""}
    </div>
  </div>`;
}

function voiceoverCardHtml(message) {
  const voiceover = message.voiceover;
  if (!voiceover) return "";
  const key = audioKey("voiceover", message.id);
  const cached = state.audioCache.get(key);
  const loading = state.audioLoading.has(key);
  const missing = state.audioMissing.has(key);
  const failed = voiceover.status === "failed" || Boolean(voiceover.error);
  const detail = [
    voiceover.voice ? `Voice ${voiceover.voice}` : "",
    voiceover.format ? voiceover.format.toUpperCase() : "",
    formatBytes(voiceover.bytes),
    voiceover.referenceName ? `cloned from ${voiceover.referenceName}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  let stage = "";
  if (cached) {
    stage = `<audio class="audio-player compact" src="${cached.url}" data-audio-key="${key}" controls preload="metadata"></audio>`;
  } else if (failed) {
    stage = `<div class="audio-placeholder failed"><svg class="icon"><use href="#i-x"/></svg><span>${escapeHtml(voiceover.error || "Voiceover failed.")}</span></div>`;
  } else if (loading || voiceover.status === "generating") {
    stage = `<div class="audio-placeholder"><span class="spinner"></span><span>Generating voiceover…</span></div>`;
  } else if (missing) {
    stage = `<div class="audio-placeholder failed"><svg class="icon"><use href="#i-x"/></svg><span>Voiceover file is not available.</span></div>`;
  } else {
    stage = `<div class="audio-placeholder"><span class="spinner"></span><span>Loading voiceover…</span></div>`;
  }

  const download = cached
    ? `<a class="chip-btn" href="${cached.url}" download="ourchat-voiceover-${escapeHtml(message.id)}.${escapeHtml(voiceover.format || "mp3")}">
        <svg class="icon"><use href="#i-download"/></svg><span>Download track</span>
      </a>`
    : "";

  return `<div class="audio-card voiceover-card">
    <div class="audio-stage">${stage}</div>
    <div class="audio-info">
      <div class="audio-title"><svg class="icon"><use href="#i-mic"/></svg><span>Voiceover</span><small>separate track</small></div>
      <div class="audio-detail">${escapeHtml(detail || "Generated voiceover")}</div>
      ${download ? `<div class="audio-actions">${download}</div>` : ""}
    </div>
    ${voiceover.error && cached ? `<div class="audio-note">${escapeHtml(voiceover.error)}</div>` : ""}
  </div>`;
}

async function refreshVideoAsset(messageId, { notify = false } = {}) {
  const conversationId = state.conversationId;
  const conversation = currentConversation();
  const message = conversation?.messages.find((item) => item.id === messageId);
  const video = message?.video;
  if (!conversation || !video?.jobId) return;
  if (state.videoCache.has(video.jobId) || state.videoLoading.has(video.jobId)) return;

  state.videoLoading.add(video.jobId);
  store.updateMessage(conversationId, messageId, { video: { ...video, error: "" } });
  if (state.conversationId === conversationId) renderThread();

  let next = { ...video, error: "" };
  try {
    const job = await fetchVideoJob({
      apiKey: store.settings().apiKey,
      id: video.jobId,
      pollingUrl: video.pollingUrl,
    });
    next = mergeVideoJob(video, job);
    if (next.status === "completed") {
      const url = videoJobUrls(job)[0];
      if (!url) throw new Error("The job completed without a video URL.");
      const blob = await fetchVideoContent({ apiKey: store.settings().apiKey, url });
      const objectUrl = URL.createObjectURL(blob);
      state.videoCache.set(video.jobId, { url: objectUrl, blob, createdAt: Date.now() });
    }
    store.updateMessage(conversationId, messageId, { video: { ...next, error: "" } });
    if (notify) {
      if (next.status === "completed") toast("Video is ready");
      else if (["failed", "cancelled", "expired"].includes(next.status)) toast(`Video ${next.status}`);
      else toast("Still rendering");
    }
  } catch (error) {
    next = { ...next, error: friendlyError(error) };
    store.updateMessage(conversationId, messageId, { video: next });
    if (notify) toast(next.error);
  } finally {
    state.videoLoading.delete(video.jobId);
    if (state.conversationId === conversationId) {
      renderThread();
      updateComposerState();
    }
  }
}

function hydrateVideos() {
  if (document.hidden || state.sending) return;
  const conversation = currentConversation();
  if (!conversation) return;
  const pending = conversation.messages
    .filter(
      (message) =>
        message.video?.status === "completed" &&
        message.video.jobId &&
        !message.video.error &&
        !state.videoCache.has(message.video.jobId) &&
        !state.videoLoading.has(message.video.jobId)
    )
    .slice(0, 3);
  for (const message of pending) refreshVideoAsset(message.id);
}

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
  } else if (context.streaming && !message.video && !message.speech) {
    body = `<div class="msg-body"><div class="typing"><i></i><i></i><i></i></div></div>`;
  } else if (!message.error && !message.video && !message.speech) {
    body = `<div class="msg-body"><p class="muted-line">No response.</p></div>`;
  }

  const speech = message.speech ? speechCardHtml(message) : "";
  const video = message.video ? videoCardHtml(message) : "";
  const error = message.error && !message.video
    ? `<div class="msg-error"><svg class="icon"><use href="#i-x"/></svg><span>${escapeHtml(message.error)}</span></div>`
    : "";

  const metaBits = [];
  if (message.model) metaBits.push(escapeHtml(shortModel(message.model)));
  if (!message.video && !message.speech && Number(message.usage?.total_tokens) > 0) {
    metaBits.push(`${Number(message.usage.total_tokens).toLocaleString()} tokens`);
  }
  if (!message.video && !message.speech && Number(message.usage?.cost) > 0) metaBits.push(`$${Number(message.usage.cost).toFixed(4)}`);
  if (message.speech) {
    if (formatBytes(message.speech.bytes)) metaBits.push(formatBytes(message.speech.bytes));
    if (Number(message.speech.estimatedCost) > 0) metaBits.push(`est. ${formatVideoCost(message.speech.estimatedCost)}`);
  }
  if (!message.video && !message.speech && message.stopped) metaBits.push("stopped");
  const meta = metaBits.length ? `<div class="msg-meta">${metaBits.join(" · ")}</div>` : "";

  const feedback = message.video || message.speech
    ? ""
    : `<button type="button" class="icon-btn" data-action="copy" title="Copy" aria-label="Copy response">
        <svg class="icon"><use href="#i-copy"/></svg>
      </button>
      <span class="divider"></span>
      <button type="button" class="icon-btn${message.feedback === 1 ? " on" : ""}" data-action="up" title="Good response" aria-label="Good response" aria-pressed="${message.feedback === 1}">
        <svg class="icon"><use href="#i-thumb-up"/></svg>
      </button>
      <button type="button" class="icon-btn${message.feedback === -1 ? " on" : ""}" data-action="down" title="Bad response" aria-label="Bad response" aria-pressed="${message.feedback === -1}">
        <svg class="icon"><use href="#i-thumb-down"/></svg>
      </button>`;
  const regen = context.lastAssistant
    ? `<button type="button" class="icon-btn" data-action="regen" title="Regenerate" aria-label="Regenerate response">
        <svg class="icon"><use href="#i-refresh"/></svg>
      </button>`
    : "";
  const actions = context.streaming || (!feedback && !regen)
    ? ""
    : `<div class="msg-actions">${feedback}${regen}</div>`;

  return `<div class="message assistant" data-id="${message.id}">
    <div class="assistant-avatar"><svg class="icon"><use href="#i-spark"/></svg></div>
    <div class="msg-main">
      ${reasoning}
      ${body}
      ${speech}
      ${video}
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
  setTimeout(() => {
    hydrateVideos();
    hydrateAudio();
  }, 0);
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

const VIDEO_SUGGESTIONS = [
  {
    icon: "i-spark",
    title: "Cinematic night scene",
    text: "Moody, neon, slow push-in",
    prompt: "A paper boat drifting down a rain-soaked Tokyo alley at night, neon reflections, slow cinematic push-in.",
  },
  {
    icon: "i-star",
    title: "Nature in macro",
    text: "Golden light, shallow focus",
    prompt: "Macro shot of a hummingbird hovering beside a red flower, golden backlight, shallow depth of field.",
  },
  {
    icon: "i-edit",
    title: "Atmospheric timelapse",
    text: "Fog and first light",
    prompt: "Timelapse of fog rolling over a mountain ridge at sunrise, warm light, gentle camera drift.",
  },
  {
    icon: "i-image",
    title: "Playful animation",
    text: "A tiny cosmic explorer",
    prompt: "A tiny astronaut exploring a glowing crystal cave, whimsical 3D animation style, soft volumetric light.",
  },
];

const SPEECH_SUGGESTIONS = [
  {
    icon: "i-mic",
    title: "Read a passage",
    text: "Natural narration",
    prompt: "The ocean keeps its own time. It moves without hurry, shaping stone and shore alike, and leaves the light scattered behind it.",
  },
  {
    icon: "i-star",
    title: "Warm welcome",
    text: "Friendly and composed",
    prompt: "Welcome back. Take a breath, settle in, and let's pick up exactly where we left off.",
  },
  {
    icon: "i-edit",
    title: "Product teaser",
    text: "Bright, confident delivery",
    prompt: "Meet the tool that turns a rough idea into something you can actually hear. Clear, expressive, and ready in seconds.",
  },
  {
    icon: "i-spark",
    title: "Calm meditation",
    text: "Slow and spacious",
    prompt: "Let your shoulders soften. Notice the air moving in, and the quiet pause before the next breath.",
  },
];

function renderEmpty() {
  const hasKey = store.settings().apiKey.length > 0;
  const modelKind = currentModelInfo()?.kind;
  const video = modelKind === "video";
  const speech = modelKind === "speech";
  const suggestions = video ? VIDEO_SUGGESTIONS : speech ? SPEECH_SUGGESTIONS : SUGGESTIONS;
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
    <h1 class="empty-title">${video ? "What should we create?" : speech ? "What should we say?" : "What can I help with?"}</h1>
    <p class="empty-sub">${
      hasKey
        ? video
          ? "Describe a shot, then set the duration, aspect ratio, and resolution below."
          : speech
            ? "Type a script, choose a voice, and optionally clone from a short sample."
            : "Ask anything — draft, debug, plan, or think out loud."
        : "A private, OpenRouter-powered chat. Your key stays in this browser."
    }</p>
    ${connect}
    <div class="suggestions">
      ${suggestions.map(
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

  const modelInfo = state.models.find((item) => item.id === model);
  if (modelInfo?.kind === "video") {
    if (images.length) {
      toast("Video models accept a text prompt only. Remove the attachments first.");
      return;
    }
    const options = videoOptionsFromControls() || clampVideoOptions(modelInfo);

    store.addMessage(conversation.id, { role: "user", content: text, at: Date.now() });
    store.setTitleFromMessage(conversation.id, text || "Video");
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
    await runVideoGeneration(conversation.id, assistant.id, text, modelInfo, options);
    return;
  }

  if (modelInfo?.kind === "speech") {
    if (images.length) {
      toast("Speech models accept text only. Remove the attachments first.");
      return;
    }
    const options = speechOptionsFromControls() || {
      voice: "",
      speed: 1,
      instructions: "",
      reference: null,
    };

    store.addMessage(conversation.id, { role: "user", content: text, at: Date.now() });
    store.setTitleFromMessage(conversation.id, text);
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
    await runSpeechGeneration(conversation.id, assistant.id, text, modelInfo, options);
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

async function runVideoGeneration(conversationId, assistantId, prompt, model, preferred) {
  const controller = new AbortController();
  state.controller = controller;
  state.sending = true;
  updateComposerState();

  const options = clampVideoOptions(model, preferred);
  const estimatedCost = estimateVideoCost(model, options);
  let latest = null;

  const persist = (video) => {
    latest = video;
    store.updateMessage(conversationId, assistantId, { video: latest });
    if (state.conversationId === conversationId) {
      renderThread();
      if (state.stick) scrollBottom();
    }
  };

  try {
    const payload = await createVideoGeneration({
      apiKey: store.settings().apiKey,
      model: model.id,
      prompt,
      duration: options.duration,
      resolution: options.resolution,
      aspectRatio: options.aspectRatio,
      generateAudio: options.generateAudio,
      inputReferences: state.videoReference ? [videoAudioReference(state.videoReference.data)] : [],
      signal: controller.signal,
    });

    persist(
      mergeVideoJob(
        {
          jobId: payload.id,
          pollingUrl: payload.polling_url || "",
          status: payload.status || "pending",
          cost: 0,
          estimatedCost: estimatedCost ?? null,
          expiresAt: Number(payload.expires_at) || 0,
          duration: options.duration,
          resolution: options.resolution,
          aspectRatio: options.aspectRatio,
          generateAudio: options.generateAudio,
          error: "",
        },
        payload
      )
    );

    const finalJob = await waitForVideoGeneration({
      apiKey: store.settings().apiKey,
      job: payload,
      intervalMs: 4000,
      signal: controller.signal,
      onUpdate: (job) => persist(mergeVideoJob(latest, job)),
    });

    const finalVideo = mergeVideoJob(latest, finalJob);
    if (finalVideo.status === "completed") {
      const urls = videoJobUrls(finalJob);
      if (!urls.length) throw new Error("The video completed but OpenRouter returned no video URL.");
      const blob = await fetchVideoContent({
        apiKey: store.settings().apiKey,
        url: urls[0],
        signal: controller.signal,
      });
      const objectUrl = URL.createObjectURL(blob);
      state.videoCache.set(finalVideo.jobId, { url: objectUrl, blob, createdAt: Date.now() });
      persist({ ...finalVideo, error: "" });
    } else {
      const fallback = `Video ${finalVideo.status || "generation"} did not produce a file.`;
      persist({ ...finalVideo, error: finalVideo.error || fallback });
    }
  } catch (error) {
    if (error.name === "AbortError") {
      if (latest) {
        persist({
          ...latest,
          error: "Tracking stopped. The job may still finish and bill on OpenRouter. Use Check status to resume.",
        });
      } else {
        store.updateMessage(conversationId, assistantId, {
          stopped: true,
          error: "Video request stopped.",
        });
      }
    } else if (latest) {
      persist({ ...latest, error: friendlyError(error) });
    } else {
      store.updateMessage(conversationId, assistantId, { error: friendlyError(error) });
    }
  } finally {
    if (state.controller === controller) {
      state.controller = null;
      state.sending = false;
    }
    renderSidebar();
    if (state.conversationId === conversationId) {
      renderThread();
      updateComposerState();
      if (state.stick) scrollBottom();
    }
  }
}

async function runSpeechGeneration(conversationId, assistantId, text, model, options) {
  const controller = new AbortController();
  state.controller = controller;
  state.sending = true;
  updateComposerState();

  const key = audioKey("speech", assistantId);
  const estimatedCost = estimateSpeechCost(model, text);
  let speech = {
    status: "generating",
    model: model.id,
    voice: options.voice || "",
    format: "mp3",
    bytes: 0,
    estimatedCost: estimatedCost ?? null,
    referenceName: options.reference?.name || "",
    instructions: options.instructions || "",
    error: "",
  };

  const persist = (next) => {
    speech = next;
    store.updateMessage(conversationId, assistantId, { speech });
    if (state.conversationId === conversationId) {
      renderThread();
      if (state.stick) scrollBottom();
    }
  };

  persist(speech);

  try {
    const result = await createSpeech({
      apiKey: store.settings().apiKey,
      model: model.id,
      input: text,
      voice: options.voice,
      instructions: options.instructions,
      speed: options.speed,
      responseFormat: "mp3",
      references: options.reference ? speechReferences(options.reference) : [],
      signal: controller.signal,
    });

    const previous = state.audioCache.get(key);
    if (previous) {
      state.audioCache.delete(key);
      URL.revokeObjectURL(previous.url);
    }
    state.audioCache.set(key, { url: URL.createObjectURL(result.blob), blob: result.blob, createdAt: Date.now() });
    state.audioMissing.delete(key);
    await putAudio(key, result.blob);

    persist({
      ...speech,
      status: "completed",
      bytes: result.blob.size,
      format: audioExtension(result.type),
      error: "",
    });
    setTimeout(() => playAudioKey(key), 80);
  } catch (error) {
    if (error.name === "AbortError") {
      persist({ ...speech, status: "failed", error: "Speech generation stopped." });
    } else {
      persist({ ...speech, status: "failed", error: friendlyError(error) });
    }
  } finally {
    if (state.controller === controller) {
      state.controller = null;
      state.sending = false;
    }
    renderSidebar();
    if (state.conversationId === conversationId) {
      renderThread();
      updateComposerState();
      if (state.stick) scrollBottom();
    }
  }
}

async function runVoiceoverGeneration(conversationId, assistantId, script, model, options) {
  const controller = new AbortController();
  state.voiceoverController = controller;
  state.voiceoverBusy = true;

  const key = audioKey("voiceover", assistantId);
  const conversation = store.getConversation(conversationId);
  const message = conversation?.messages.find((item) => item.id === assistantId);
  if (!message) {
    state.voiceoverController = null;
    state.voiceoverBusy = false;
    return;
  }

  let voiceover = {
    status: "generating",
    model: model.id,
    voice: options.voice || "",
    format: "mp3",
    bytes: 0,
    referenceName: options.reference?.name || "",
    instructions: options.instructions || "",
    script,
    error: "",
    at: Date.now(),
  };

  const persist = (next) => {
    voiceover = next;
    store.updateMessage(conversationId, assistantId, { voiceover });
    if (state.conversationId === conversationId) {
      renderThread();
      if (state.stick) scrollBottom();
    }
  };

  releaseAudio(key);
  persist(voiceover);

  try {
    const result = await createSpeech({
      apiKey: store.settings().apiKey,
      model: model.id,
      input: script,
      voice: options.voice,
      instructions: options.instructions,
      speed: options.speed,
      responseFormat: "mp3",
      references: options.reference ? speechReferences(options.reference) : [],
      signal: controller.signal,
    });

    state.audioCache.set(key, { url: URL.createObjectURL(result.blob), blob: result.blob, createdAt: Date.now() });
    state.audioMissing.delete(key);
    await putAudio(key, result.blob);

    persist({
      ...voiceover,
      status: "completed",
      bytes: result.blob.size,
      format: audioExtension(result.type),
      error: "",
    });
    setTimeout(() => playAudioKey(key), 80);
  } catch (error) {
    if (error.name === "AbortError") {
      persist({ ...voiceover, status: "failed", error: "Voiceover generation stopped." });
    } else {
      persist({ ...voiceover, status: "failed", error: friendlyError(error) });
    }
  } finally {
    if (state.voiceoverController === controller) {
      state.voiceoverController = null;
      state.voiceoverBusy = false;
    }
    if (state.conversationId === conversationId) {
      renderThread();
      if (state.stick) scrollBottom();
    }
  }
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

  const target = conversation.messages.find((message) => message.id === assistantId);
  const previousVideo = target?.video || null;
  const model = conversation.model || store.settings().defaultModel;
  const modelInfo = state.models.find((item) => item.id === model);
  const lastUser = [...conversation.messages].reverse().find((message) => message.role === "user");

  if (modelInfo?.kind === "video") {
    if (!lastUser?.content) {
      toast("A text prompt is needed to regenerate this video.");
      return;
    }
    if (lastUser.images?.length) {
      toast("Video models accept a text prompt only.");
      return;
    }
  }

  if (modelInfo?.kind === "speech") {
    if (!lastUser?.content) {
      toast("Text is needed to regenerate this speech.");
      return;
    }
    if (lastUser.images?.length) {
      toast("Speech models accept text only.");
      return;
    }
  }

  releaseVideoCache(target?.video);
  releaseMessageAudio(target);
  store.removeMessagesFrom(conversation.id, assistantId);
  const history = conversation.messages.slice();
  if (!history.length) {
    renderThread();
    return;
  }

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

  if (modelInfo?.kind === "video") {
    const options = previousVideo
      ? {
          duration: previousVideo.duration,
          resolution: previousVideo.resolution,
          aspectRatio: previousVideo.aspectRatio,
          generateAudio: previousVideo.generateAudio,
        }
      : videoOptionsFromControls() || clampVideoOptions(modelInfo);
    runVideoGeneration(conversation.id, assistant.id, lastUser.content, modelInfo, options);
    return;
  }

  if (modelInfo?.kind === "speech") {
    const options = speechOptionsFromControls() || {
      voice: target?.speech?.voice || "",
      speed: 1,
      instructions: target?.speech?.instructions || "",
      reference: state.speechReference,
    };
    runSpeechGeneration(conversation.id, assistant.id, lastUser.content, modelInfo, options);
    return;
  }

  runCompletion(conversation.id, assistant.id, history, model);
}

function openVoiceover(messageId) {
  const conversation = currentConversation();
  const message = conversation?.messages.find((item) => item.id === messageId);
  if (!conversation || !message?.video) return;
  const models = speechModels();
  if (!models.length) {
    toast("No speech models are available. Refresh the model catalog.");
    return;
  }

  state.voiceoverMessageId = messageId;
  state.voiceoverConversationId = conversation.id;
  state.voiceoverReference = null;
  dom.voiceoverModel.innerHTML = models
    .map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.name || model.id)}</option>`)
    .join("");

  const preferred = message.voiceover?.model || store.settings().speechModel;
  const selected = models.find((model) => model.id === preferred) || models[0];
  dom.voiceoverModel.value = selected.id;
  const voice = message.voiceover?.voice && (!selected.voices?.length || selected.voices.includes(message.voiceover.voice))
    ? message.voiceover.voice
    : selected.voices?.[0] || store.settings().speechVoice || "";
  dom.voiceoverVoice.value = voice;
  dom.voiceoverScript.value = message.voiceover?.script || "";
  dom.voiceoverInstructions.value = message.voiceover?.instructions || store.settings().speechInstructions || "";
  dom.voiceoverState.textContent = "";
  dom.voiceoverGenerate.disabled = false;
  renderVoiceoverReference();
  dom.voiceoverDialog.showModal();
}

function generateVoiceover() {
  if (state.voiceoverBusy) return;
  const script = dom.voiceoverScript.value.trim();
  if (!script) {
    dom.voiceoverState.textContent = "Enter a script first.";
    dom.voiceoverScript.focus();
    return;
  }
  const model = speechModels().find((item) => item.id === dom.voiceoverModel.value);
  if (!model) {
    dom.voiceoverState.textContent = "Choose a speech model.";
    return;
  }
  const conversationId = state.voiceoverConversationId;
  const assistantId = state.voiceoverMessageId;
  if (!conversationId || !assistantId) return;

  const options = {
    voice: dom.voiceoverVoice.value.trim(),
    speed: clampSpeechSpeed(store.settings().speechSpeed),
    instructions: dom.voiceoverInstructions.value.trim(),
    reference: state.voiceoverReference,
  };

  dom.voiceoverState.textContent = "";
  dom.voiceoverGenerate.disabled = true;
  dom.voiceoverDialog.close();
  void runVoiceoverGeneration(conversationId, assistantId, script, model, options);
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
  if (currentModelInfo()?.kind === "video") {
    toast("Video models accept a text prompt only.");
    return;
  }
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
    for (const item of state.videoCache.values()) URL.revokeObjectURL(item.url);
    state.videoCache.clear();
    state.videoLoading.clear();
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
    updateSpeechEstimate();
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

  const videoSettingChanged = () => {
    if (currentModelInfo()?.kind !== "video") return;
    const options = videoOptionsFromControls();
    if (!options) return;
    store.saveSettings({
      videoDuration: options.duration,
      videoResolution: options.resolution,
      videoAspectRatio: options.aspectRatio,
      videoAudio: options.generateAudio,
    });
    updateVideoEstimate(options);
    updateComposerState();
  };
  [dom.videoAspect, dom.videoDuration, dom.videoResolution, dom.videoAudio].forEach((control) => {
    control?.addEventListener("change", videoSettingChanged);
  });

  dom.speechReferenceBtn?.addEventListener("click", () => chooseAudioSample("speech"));
  dom.videoReferenceBtn?.addEventListener("click", () => chooseAudioSample("video"));
  dom.voiceoverReferenceBtn?.addEventListener("click", () => chooseAudioSample("voiceover"));

  dom.speechReferenceClear?.addEventListener("click", () => {
    state.speechReference = null;
    renderSpeechReference();
    updateSpeechEstimate();
  });
  dom.videoReferenceClear?.addEventListener("click", () => {
    state.videoReference = null;
    renderVideoReference();
  });
  dom.voiceoverReferenceClear?.addEventListener("click", () => {
    state.voiceoverReference = null;
    renderVoiceoverReference();
  });

  dom.speechTranscript?.addEventListener("input", () => {
    if (state.speechReference) state.speechReference.transcript = dom.speechTranscript.value;
  });
  dom.voiceoverTranscript?.addEventListener("input", () => {
    if (state.voiceoverReference) state.voiceoverReference.transcript = dom.voiceoverTranscript.value;
  });

  dom.speechVoice?.addEventListener("change", () => {
    store.saveSettings({ speechVoice: dom.speechVoice.value.trim() });
  });
  dom.speechSpeed?.addEventListener("change", () => {
    const speed = clampSpeechSpeed(dom.speechSpeed.value);
    dom.speechSpeed.value = String(speed);
    store.saveSettings({ speechSpeed: speed });
    updateSpeechEstimate();
  });
  dom.speechInstructions?.addEventListener("change", () => {
    store.saveSettings({ speechInstructions: dom.speechInstructions.value.trim() });
  });

  dom.voiceoverModel?.addEventListener("change", () => {
    const model = speechModels().find((item) => item.id === dom.voiceoverModel.value);
    if (model?.voices?.length) dom.voiceoverVoice.value = model.voices[0];
  });
  dom.voiceoverGenerate?.addEventListener("click", generateVoiceover);

  dom.audioInput.addEventListener("change", () => {
    const file = dom.audioInput.files?.[0];
    dom.audioInput.value = "";
    void applyAudioSample(file);
  });
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
    const voiceoverButton = event.target.closest("[data-voiceover]");
    if (voiceoverButton) {
      openVoiceover(voiceoverButton.dataset.voiceover);
      return;
    }

    const videoRefresh = event.target.closest("[data-video-refresh]");
    if (videoRefresh) {
      await refreshVideoAsset(videoRefresh.dataset.videoRefresh, { notify: true });
      return;
    }

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
