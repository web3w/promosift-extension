// PromoSift background: after logging in with an email account, classification uses server-side credits.
const MAX_CONCURRENT = 4;
const CACHE_LIMIT = 2000;
const REQUEST_TIMEOUT_MS = 15_000;
const AI_MIN_CHARS = 60;
const DEFAULT_SETTINGS = {
  enabled: true,
  mode: "label",
  keywords: [],
  smartMatch: true,
  aiDetect: true,
  threshold: 0.6
};

// The content script can only read public settings via messaging; it cannot read the login session.
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
let configPromise;
function loadConfig() {
  configPromise ??= fetch(chrome.runtime.getURL("config.json")).then((r) => r.json()).then((config) => {
    const url = new URL(config.apiBase);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
      throw new Error("The PromoSift service address must use HTTPS");
    }
    return url.href.replace(/\/$/, "");
  });
  return configPromise;
}
function aiEligible(state, minChars) {
  const text = `${state?.title || ""}${state?.text || ""}`
    .replace(/#[^#\n]{1,40}#|\[[^\]]{1,10}\]|@[\w\u4e00-\u9fa5-]+|https?:\/\/\S+/g, "")
    .replace(/[\s\p{P}\p{S}\p{Extended_Pictographic}]/gu, "");
  return [...text].length >= minChars;
}

class PromoSiftError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const cache = new Map();
const inflight = new Map();
let version = 0;
let identity;
let quotaExhausted = false;
let accountSequence = 0;
let savedAccountSequence = 0;
let authAttempt = 0;
let writes = Promise.resolve();
function write(fn) {
  const next = writes.then(fn);
  writes = next.catch(() => {});
  return next;
}
function invalidate() {
  version++;
  identity = undefined;
  quotaExhausted = false;
  savedAccountSequence = 0;
  cache.clear();
  inflight.clear();
}
async function context() {
  await storageReady;
  const base = await loadConfig();
  const data = await chrome.storage.local.get({ ...DEFAULT_SETTINGS, auth: null, account: null });
  const auth = data.auth?.apiBase === base && data.auth.expiresAt > Date.now() ? data.auth : null;
  const nextIdentity = JSON.stringify([base, auth?.token || ""]);
  if (identity !== undefined && identity !== nextIdentity) invalidate();
  identity = nextIdentity;
  return { base, auth, account: auth ? data.account : null, settings: data, identity, version };
}
async function assertCurrent(ctx) {
  const now = await context();
  if (ctx.version !== now.version || ctx.identity !== now.identity) {
    throw new PromoSiftError("session_changed", "Account or classification settings changed, please retry");
  }
  return now;
}
async function getPublicSettings() {
  const ctx = await context();
  const settings = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((key) => [key, ctx.settings[key]]));
  return { ...settings, authenticated: Boolean(ctx.auth) };
}
let settingsNotice = 0;
async function notifySettings() {
  const notice = ++settingsNotice;
  const settings = await getPublicSettings();
  const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
  if (notice !== settingsNotice) return;
  await Promise.all(tabs.map((tab) => chrome.tabs.sendMessage(tab.id, { type: "settingsChanged", settings }).catch(() => {})));
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.auth) invalidate();
  const recovered = changes.account?.newValue?.credits > (changes.account?.oldValue?.credits || 0);
  if (recovered) quotaExhausted = false;
  if (recovered || changes.auth || Object.keys(DEFAULT_SETTINGS).some((key) => key in changes)) {
    notifySettings().catch(() => {});
  }
});
chrome.runtime.onInstalled.addListener(async () => {
  await storageReady;
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  await chrome.storage.local.set(settings);
  // Legacy device tokens no longer factor into identity; clear old device registration data.
  await chrome.storage.local.remove("devices");
  chrome.contextMenus.create({
    id: "adsift-check-selection",
    title: chrome.i18n.getMessage("contextMenuCheckSelection"),
    contexts: ["selection"],
    documentUrlPatterns: ["https://x.com/*", "https://twitter.com/*"]
  });
});

async function fetchWithTimeout(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
async function clearSession(ctx) {
  await write(async () => {
    await assertCurrent(ctx);
    await chrome.storage.local.set({ auth: null, account: null, stats: { checked: 0, ads: 0 } });
  });
}
async function saveAccount(account, ctx, sequence) {
  if (!account) return;
  let recovered = false;
  await write(async () => {
    const now = await assertCurrent(ctx);
    // Concurrent responses can arrive out of order; a stale response must not overwrite a newer account balance or resurrect a revoked session.
    if (sequence < savedAccountSequence || (now.account?.id === account.id && now.account.used > account.used)) return;
    savedAccountSequence = sequence;
    recovered = quotaExhausted && account.credits > 0;
    if (account.credits > 0) quotaExhausted = false;
    await chrome.storage.local.set({ account });
  });
  if (recovered) await notifySettings();
}
async function api(path, { method = "GET", body, ctx, anonymous = false } = {}) {
  const base = ctx?.base || await loadConfig();
  if (!anonymous && !ctx?.auth) throw new PromoSiftError("auth_required", "Please log in to PromoSift first");
  if (ctx) await assertCurrent(ctx);
  const sequence = ++accountSequence;
  let res;
  try {
    res = await fetchWithTimeout(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(!anonymous ? { Authorization: `Bearer ${ctx.auth.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    throw new PromoSiftError("network", "Couldn't reach the PromoSift service, please try again later");
  }
  const data = await res.json().catch(() => ({}));
  if (ctx) await assertCurrent(ctx);
  if (!res.ok) {
    if (ctx && (res.status === 401 || data.code === "account_disabled")) await clearSession(ctx);
    if (res.status === 402) quotaExhausted = true;
    throw new PromoSiftError(data.code || (res.status >= 500 ? "upstream" : "other"), data.error || `Request failed (${res.status})`);
  }
  if (ctx && data.account) await saveAccount(data.account, ctx, sequence);
  return data;
}
async function login(email, code) {
  const attempt = ++authAttempt;
  const base = await loadConfig();
  const data = await api("/v1/auth/verify-code", { method: "POST", anonymous: true, body: { email, code, client: "extension" } });
  await write(async () => {
    if (attempt !== authAttempt) throw new PromoSiftError("session_changed", "Login was cancelled");
    await chrome.storage.local.set({ auth: { token: data.token, expiresAt: data.expiresAt, apiBase: base }, account: data.account, stats: { checked: 0, ads: 0 } });
  });
  return { ok: true, account: data.account };
}
async function logout(all = false) {
  ++authAttempt;
  const ctx = await context();
  if (ctx.auth) {
    // If server-side revocation fails, keep the local session and surface the error; never disguise a "local-only clear" as a successful logout.
    try {
      await api(all ? "/v1/auth/logout-all" : "/v1/auth/logout", { method: "POST", ctx });
    } catch (error) {
      if (!["auth_required", "account_disabled"].includes(error.code)) throw error;
      return { ok: true };
    }
  }
  await clearSession(ctx);
  return { ok: true };
}
// ---------- Classification: in-session cache and concurrency control ----------
function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + ":" + str.length;
}
let active = 0;
const queue = [];
function schedule(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}
function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const { fn, resolve, reject } = queue.shift();
    active++;
    fn().then(resolve, reject).finally(() => { active--; pump(); });
  }
}
async function classify(state, topics = []) {
  state = { ...state, platform: "X" };
  const ctx = await context();
  const settings = ctx.settings;
  if (!ctx.auth) throw new PromoSiftError("auth_required", "Please log in to PromoSift first");
  topics = [...new Set(topics.map((t) => String(t).trim()).filter(Boolean))].slice(0, 10);
  await assertCurrent(ctx);
  const eligible = aiEligible(state, AI_MIN_CHARS);
  const wantAi = settings.aiDetect !== false && eligible;
  const key = `${ctx.version}:` + hash(JSON.stringify([state, [...topics].sort(), wantAi]));
  if (cache.has(key)) return { ...cache.get(key), ctx };
  if (inflight.has(key)) return inflight.get(key);
  if (quotaExhausted || ctx.account?.credits === 0) throw new PromoSiftError("quota", "Out of detection credits, please refresh your account");
  const p = schedule(async () => {
    const current = await assertCurrent(ctx);
    if (quotaExhausted || current.account?.credits === 0) throw new PromoSiftError("quota", "Out of detection credits, please refresh your account");
    let data;
    // Only retry the explicit "request already in progress" case; a network timeout must not auto-resend a request that may already have been billed.
    for (let attempt = 0; ; attempt++) {
      try {
        data = await api("/v1/classify", { method: "POST", body: { state, topics, ai: wantAi }, ctx });
        break;
      } catch (error) {
        if (error.code !== "in_progress" || attempt >= 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        await assertCurrent(ctx);
      }
    }
    await assertCurrent(ctx);
    const result = { result: data.result, topics: data.topics || {}, ai: data.ai ?? null, aiShort: settings.aiDetect !== false && !eligible };
    await write(async () => {
      await assertCurrent(ctx);
      const { stats = { checked: 0, ads: 0 } } = await chrome.storage.local.get("stats");
      await chrome.storage.local.set({ stats: { checked: stats.checked + 1, ads: stats.ads + Number(result.result.prob >= settings.threshold) } });
    });
    await assertCurrent(ctx);
    cache.set(key, result);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    return { ...result, ctx };
  }).finally(() => {
    if (inflight.get(key) === p) inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}
const errorResponse = (error) => ({ ok: false, code: error instanceof PromoSiftError ? error.code : "other", error: String(error?.message || error) });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const reply = (promise) => {
    promise.then(sendResponse, (error) => sendResponse(errorResponse(error)));
    return true;
  };
  const trusted = sender.url === chrome.runtime.getURL("popup.html");
  // Login and logout may only be called from the extension popup; the page's content script has no account-management privileges.
  if (!["getSettings", "classify"].includes(msg?.type) && !trusted) {
    sendResponse({ ok: false, code: "forbidden", error: "Only the extension popup can perform this action" });
    return false;
  }
  switch (msg?.type) {
    case "getSettings": return reply(getPublicSettings());
    case "classify": return reply(classify(msg.state, msg.topics || []).then(async (r) => {
      const now = await assertCurrent(r.ctx);
      return { ok: true, result: { ...r.result, isAd: r.result.prob >= now.settings.threshold }, topics: r.topics, ai: r.ai, aiShort: r.aiShort };
    }));
    case "requestCode": return reply(api("/v1/auth/request-code", { method: "POST", anonymous: true, body: { email: msg.email } }));
    case "login": return reply(login(msg.email, msg.code));
    case "logout": return reply(logout(Boolean(msg.all)));
    case "getAccount": return reply(context().then((ctx) => api("/v1/me", { ctx })).then((data) => ({ ok: true, account: data.account })));
    case "getCheckIn": return reply(context().then((ctx) => api("/v1/check-in", { ctx })));
    // Only an explicit claim action from the popup sends a POST; reading account/check-in status never claims credits.
    case "claimCheckIn": return reply(context().then((ctx) => api("/v1/check-in", { ctx, method: "POST", body: {} })));
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "adsift-check-selection" || !tab?.id) return;
  try {
    const url = new URL(info.pageUrl || tab.url);
    if (url.protocol !== "https:" || !["x.com", "twitter.com"].includes(url.hostname)) return;
  } catch { return; }
  const text = (info.selectionText || "").trim();
  if (!text) return;
  try {
    const { result, ctx } = await classify({ platform: "X", text });
    const now = await assertCurrent(ctx);
    await chrome.tabs.sendMessage(tab.id, { type: "showToast", result: { ...result, isAd: result.prob >= now.settings.threshold }, text });
  } catch (error) {
    if (error.code === "session_changed") return;
    chrome.tabs.sendMessage(tab.id, { type: "showToast", error: String(error.message || error) }).catch(() => {});
  }
});
