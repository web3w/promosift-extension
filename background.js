// PromoSift background: after logging in with an email account, classification uses server-side credits.
const MAX_CONCURRENT = 4;
// 服务端最多等待模型 15 秒，客户端需额外等待数据库提交和网络往返。
const REQUEST_TIMEOUT_MS = 25_000;
const AI_MIN_CHARS = 60;
const DEFAULT_SETTINGS = {
  dataConsent: false,
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
// meta comes straight from page DOM content read by content.js; bound and coerce it defensively
// before it ever leaves the extension, the same way normalizePost bounds `state` server-side.
function normalizePublishedAt(value) {
  if (typeof value !== "string") return undefined;
  const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)(Z|[+-]\d{2}:\d{2})$/);
  if (!match) return undefined;
  // Date 会把 2 月 30 日等输入顺延；先核对本地日期部分，不能把错误时间当成有效发布时间。
  const local = new Date(`${match[1]}Z`);
  if (!Number.isFinite(local.getTime()) || local.toISOString().slice(0, 19) !== match[1].slice(0, 19)) return undefined;
  if (match[2] !== "Z" && (Number(match[2].slice(1, 3)) > 23 || Number(match[2].slice(4, 6)) > 59)) return undefined;
  const date = new Date(value);
  const iso = Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  return iso?.length === 24 ? iso : undefined;
}
function sanitizeMeta(meta) {
  if (!meta || typeof meta !== "object") return undefined;
  const out = {};
  if (typeof meta.authorId === "string" && meta.authorId.trim()) out.authorId = meta.authorId.trim().slice(0, 100);
  const publishedAt = normalizePublishedAt(meta.publishedAt);
  if (publishedAt) out.publishedAt = publishedAt;
  if (meta.counts && typeof meta.counts === "object") {
    const counts = {};
    for (const key of ["replies", "reposts", "likes", "views"]) {
      const n = meta.counts[key];
      if (typeof n === "number" && Number.isFinite(n) && n >= 0) counts[key] = Math.round(n);
    }
    if (Object.keys(counts).length) out.counts = counts;
  }
  const asUrls = (value) => Array.isArray(value) ? value.filter((u) => typeof u === "string" && /^https:\/\//.test(u)).slice(0, 8) : [];
  if (meta.media && typeof meta.media === "object") {
    const media = {};
    const images = asUrls(meta.media.images);
    const videos = asUrls(meta.media.videos);
    if (images.length) media.images = images;
    if (videos.length) media.videos = videos;
    if (Object.keys(media).length) out.media = media;
  }
  return Object.keys(out).length ? out : undefined;
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
  return { ...settings, authenticated: Boolean(ctx.auth), quotaExhausted: Boolean(ctx.auth && (quotaExhausted || ctx.account?.credits === 0)) };
}
let settingsNotice = 0;
async function notifySettings() {
  const notice = ++settingsNotice;
  const settings = await getPublicSettings();
  const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
  if (notice !== settingsNotice) return;
  await Promise.all(tabs.map((tab) => chrome.tabs.sendMessage(tab.id, { type: "settingsChanged", settings }).catch(() => {})));
}
let quotaNotice = 0;
async function notifyQuota() {
  const notice = ++quotaNotice;
  const settings = await getPublicSettings();
  const currentVersion = version;
  const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
  if (notice !== quotaNotice || currentVersion !== version) return;
  // 额度变化单独通知，恢复时保留页面已经检测的结果，不触发设置重置。
  const message = { type: "quotaChanged", exhausted: settings.quotaExhausted };
  await Promise.all([
    ...tabs.map((tab) => chrome.tabs.sendMessage(tab.id, message).catch(() => {})),
    chrome.runtime.sendMessage(message).catch(() => {})
  ]);
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.auth) invalidate();
  const recovered = changes.account?.newValue?.credits > 0 && (quotaExhausted || changes.account?.oldValue?.credits === 0);
  if (recovered) quotaExhausted = false;
  if (changes.auth || Object.keys(DEFAULT_SETTINGS).some((key) => key in changes)) {
    notifySettings().catch(() => {});
  } else if (recovered || (changes.account && (changes.account.newValue?.credits === 0) !== (changes.account.oldValue?.credits === 0))) {
    notifyQuota().catch(() => {});
  }
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
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
  if (recovered) await notifyQuota();
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
    if (res.status === 402 && !quotaExhausted) {
      quotaExhausted = true;
      notifyQuota().catch(() => {});
    }
    // 旧版线上服务没有 Google 接口时，明确提示尚未启用，避免误报授权失败。
    const code = path === "/auth/google/status" && res.status === 404 ? "google_unavailable" : res.status === 402 ? "quota" : data.code || (res.status >= 500 ? "upstream" : "other");
    throw new PromoSiftError(code, data.error || `Request failed (${res.status})`);
  }
  if (ctx && data.account) await saveAccount(data.account, ctx, sequence);
  return data;
}
// 在后台再次检查本地同意，防止直接发送消息绕过登录界面的禁用按钮。
async function requireLoginConsent() {
  const { dataConsent } = await chrome.storage.local.get("dataConsent");
  if (dataConsent !== true) throw new PromoSiftError("consent_required", "Please agree to the Privacy Policy before signing in");
}
async function login(email, code) {
  await requireLoginConsent();
  const attempt = ++authAttempt;
  const base = await loadConfig();
  const data = await api("/v1/auth/verify-code", { method: "POST", anonymous: true, body: { email, code, client: "extension" } });
  return saveLogin(data, attempt, base);
}
async function saveLogin(data, attempt, base) {
  await write(async () => {
    if (attempt !== authAttempt) throw new PromoSiftError("session_changed", "Login was cancelled");
    await requireLoginConsent();
    // 仅缓存服务端确认登录成功的邮箱；退出登录保留邮箱，不保存验证码。
    await chrome.storage.local.set({ auth: { token: data.token, expiresAt: data.expiresAt, apiBase: base }, account: data.account, lastLoginEmail: data.account.email, stats: { checked: 0, ads: 0 } });
  });
  return { ok: true, account: data.account };
}
let googleLoginPending = false;
async function loginWithGoogle() {
  await requireLoginConsent();
  if (googleLoginPending) throw new PromoSiftError("google_pending", "Google sign-in is already open");
  googleLoginPending = true;
  const attempt = ++authAttempt;
  try {
    const base = await loadConfig();
    const provider = await api("/auth/google/status", { anonymous: true });
    if (!provider.available) throw new PromoSiftError("google_unavailable", "Google sign-in is temporarily unavailable. Please use email.");
    const verifier = Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, "0")).join("");
    const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const callback = chrome.identity.getRedirectURL("google");
    const url = new URL(base + "/auth/google/start");
    url.search = new URLSearchParams({ client: "extension", redirect_uri: callback, challenge }).toString();
    // identity 不提供尺寸参数；只调整回调指向本站的新 Google 授权弹窗。
    const resizeAuthWindow = async (created) => {
      if (created.type !== "popup") return;
      try {
        const win = await chrome.windows.get(created.id, { populate: true });
        if (!googleLoginPending || win.tabs?.length !== 1) return;
        const page = new URL(win.tabs[0].url || "about:blank");
        if (page.origin !== "https://accounts.google.com" || page.searchParams.get("redirect_uri") !== new URL("/auth/google/callback", base).href) return;
        await chrome.windows.update(win.id, { width: 520, height: 680,
          left: Math.max(0, Math.round(win.left + (win.width - 520) / 2)),
          top: Math.max(0, Math.round(win.top + (win.height - 680) / 2)) });
      } catch { /* 窗口已关闭或尺寸调整失败，不影响授权。 */ }
    };
    chrome.windows.onCreated.addListener(resizeAuthWindow);
    let result;
    try { result = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive: true }); }
    catch { throw new PromoSiftError("google_cancelled", "Google sign-in was cancelled or could not be opened"); }
    finally { chrome.windows.onCreated.removeListener(resizeAuthWindow); }
    const target = new URL(result || callback);
    if (target.origin + target.pathname !== callback) throw new PromoSiftError("google_failed", "Unexpected Google sign-in response");
    const error = target.searchParams.get("google_error");
    if (error) throw new PromoSiftError(error, "Google sign-in could not be completed. Please use email.");
    if (attempt !== authAttempt) throw new PromoSiftError("session_changed", "Login was cancelled");
    const ticket = target.searchParams.get("ticket");
    if (!ticket) throw new PromoSiftError("google_failed", "Missing Google sign-in response");
    // Google 登录不会自动设置数据处理同意；长期会话只从 HTTPS POST 兑换响应获得。
    const data = await api("/auth/google/exchange", { method: "POST", anonymous: true, body: { ticket, verifier } });
    return await saveLogin(data, attempt, base);
  } finally { googleLoginPending = false; }
}
async function logout() {
  ++authAttempt;
  const ctx = await context();
  if (ctx.auth) {
    // If server-side revocation fails, keep the local session and surface the error; never disguise a "local-only clear" as a successful logout.
    try {
      await api("/v1/auth/logout", { method: "POST", ctx });
    } catch (error) {
      if (!["auth_required", "account_disabled"].includes(error.code)) throw error;
      return { ok: true };
    }
  }
  await clearSession(ctx);
  return { ok: true };
}
// ---------- Classification: concurrency control ----------
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
const CLASSIFY_CACHE_TTL = 24 * 60 * 60 * 1000;
const CLASSIFY_CACHE_LIMIT = 500;
const classificationRequests = new Map();
// 对象字段顺序不影响查询身份；只持久化摘要键和结果，不存帖子原文或登录令牌。
function cacheValue(value) {
  if (Array.isArray(value)) return value.map(cacheValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, cacheValue(value[key])]));
  return value;
}
async function classificationKey(ctx, state, topics, ai) {
  const input = JSON.stringify(cacheValue([ctx.base, ctx.account?.id || ctx.auth.token, state, topics, ai]));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))), n => n.toString(16).padStart(2, "0")).join("");
}
async function classify(state, topics = [], meta) {
  state = { ...state, platform: "X" };
  meta = sanitizeMeta(meta);
  const ctx = await context();
  const settings = ctx.settings;
  if (!ctx.auth) throw new PromoSiftError("auth_required", "Please log in to PromoSift first");
  topics = [...new Set(topics.map((t) => String(t).trim()).filter(Boolean))].slice(0, 10);
  await assertCurrent(ctx);
  // 缺少明确同意时，旧登录状态和直接消息都不能触发内容上传。
  if (settings.dataConsent !== true) throw new PromoSiftError("consent_required", "Please open PromoSift and agree to data processing before checking posts");
  const eligible = aiEligible(state, AI_MIN_CHARS);
  const wantAi = settings.aiDetect !== false && eligible;
  const key = await classificationKey(ctx, state, [...topics].sort(), wantAi);
  // 同一会话的相同查询共用一个 Promise，包含缓存读取和排队阶段，避免多标签页同时扣费。
  const requestKey = `${ctx.identity}:${ctx.version}:${key}`;
  let request = classificationRequests.get(requestKey);
  if (!request) {
    request = (async () => {
      const { classificationCache = {} } = await chrome.storage.local.get("classificationCache");
      await assertCurrent(ctx);
      const cached = classificationCache[key];
      if (cached?.expiresAt > Date.now()) return cached.value;
      return schedule(async () => {
        const current = await assertCurrent(ctx);
        if (current.settings.dataConsent !== true) throw new PromoSiftError("consent_required", "Please agree to data processing first");
        if (quotaExhausted || current.account?.credits === 0) throw new PromoSiftError("quota", "Out of detection credits, please refresh your account");
        let data;
        // Only retry the explicit "request already in progress" case; a network timeout must not auto-resend a request that may already have been billed.
        for (let attempt = 0; ; attempt++) {
          try {
            // meta rides along only on an actual model request; it never enters classificationKey or
            // the cache/dedup key above, so it cannot affect billing, caching, or the model's input.
            data = await api("/v1/classify", { method: "POST", body: { state, topics, ai: wantAi, meta }, ctx });
            break;
          } catch (error) {
            if (error.code !== "in_progress" || attempt >= 2) throw error;
            await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
            await assertCurrent(ctx);
          }
        }
        await assertCurrent(ctx);
        const result = { result: data.result, topics: data.topics || {}, ai: data.ai ?? null };
        await write(async () => {
          await assertCurrent(ctx);
          const { stats = { checked: 0, ads: 0 } } = await chrome.storage.local.get("stats");
          const { classificationCache = {} } = await chrome.storage.local.get("classificationCache");
          const now = Date.now();
          const entries = Object.entries(classificationCache).filter(([storedKey, entry]) => storedKey !== key && entry.expiresAt > now);
          entries.push([key, { expiresAt: now + CLASSIFY_CACHE_TTL, value: result }]);
          // 只在真实请求成功时更新统计；命中缓存不会覆盖最新余额，也不会再次计数。
          await chrome.storage.local.set({
            classificationCache: Object.fromEntries(entries.slice(-CLASSIFY_CACHE_LIMIT)),
            stats: { checked: stats.checked + 1, ads: stats.ads + Number(result.result.prob >= settings.threshold) }
          });
        });
        await assertCurrent(ctx);
        return result;
      });
    })();
    classificationRequests.set(requestKey, request);
  }
  try {
    const result = await request;
    const current = await assertCurrent(ctx);
    if (current.settings.dataConsent !== true) throw new PromoSiftError("consent_required", "Please agree to data processing first");
    return { ...result, aiShort: current.settings.aiDetect !== false && !eligible, ctx };
  } finally {
    if (classificationRequests.get(requestKey) === request) classificationRequests.delete(requestKey);
  }
}
const errorResponse = (error) => ({ ok: false, code: error instanceof PromoSiftError ? error.code : "other", error: String(error?.message || error) });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const reply = (promise) => {
    promise.then(sendResponse, (error) => sendResponse(errorResponse(error)));
    return true;
  };
  const trusted = sender.url === chrome.runtime.getURL("popup.html");
  const xTab = Number.isInteger(sender.tab?.id) && /^https:\/\/(?:x|twitter)\.com\//.test(sender.url || "");
  // Login and logout may only be called from the extension popup; the page's content script has no account-management privileges.
  if (!["getSettings", "classify", "setBadgeCount", "openSidePanel"].includes(msg?.type) && !trusted) {
    sendResponse({ ok: false, code: "forbidden", error: "Only the extension popup can perform this action" });
    return false;
  }
  switch (msg?.type) {
    case "openSidePanel": {
      if (!xTab) {
        sendResponse({ ok: false, code: "forbidden" });
        return false;
      }
      // 直接沿用点击消息的用户手势，且只能打开来源标签页的侧栏。
      return reply(chrome.sidePanel.open({ tabId: sender.tab.id }).then(() => ({ ok: true })));
    }
    case "setBadgeCount": {
      if (!xTab || !Number.isSafeInteger(msg.count) || msg.count < 0) {
        sendResponse({ ok: false, code: "forbidden" });
        return false;
      }
      // 角标只属于发送消息的 X 标签页；0 时清空，避免切换页面后显示旧数量。
      return reply(Promise.all([
        chrome.action.setBadgeText({ tabId: sender.tab.id, text: msg.count ? (msg.count > 999 ? "999+" : String(msg.count)) : "" }),
        chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: "#c6f979" })
      ]).then(() => ({ ok: true })));
    }
    case "setDataConsent":
      if (typeof msg.consent !== "boolean") { sendResponse({ ok: false, code: "invalid_consent" }); return false; }
      return reply(chrome.storage.local.set({ dataConsent: msg.consent }).then(() => ({ ok: true })));
    case "getSettings": return reply(getPublicSettings());
    case "classify": return reply(classify(msg.state, msg.topics || [], msg.meta).then(async (r) => {
      const now = await assertCurrent(r.ctx);
      return { ok: true, result: { ...r.result, isAd: r.result.prob >= now.settings.threshold }, topics: r.topics, ai: r.ai, aiShort: r.aiShort };
    }));
    case "requestCode": return reply(requireLoginConsent().then(() => api("/v1/auth/request-code", { method: "POST", anonymous: true, body: { email: msg.email } })));
    case "login": return reply(login(msg.email, msg.code));
    case "loginWithGoogle": return reply(loginWithGoogle());
    case "logout": return reply(logout());
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
