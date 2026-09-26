const $ = (id) => document.getElementById(id);
const t = (key, ...substitutions) => chrome.i18n.getMessage(key, substitutions.length ? substitutions : undefined) || key;

// Resolve static markup strings declared via data-i18n* attributes; dynamic strings set at runtime use t() directly.
function localizeStaticText() {
  document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => (el.placeholder = t(el.dataset.i18nPlaceholder)));
  document.querySelectorAll("[data-i18n-aria-label]").forEach((el) => el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel)));
  document.querySelectorAll("[data-i18n-title]").forEach((el) => el.setAttribute("title", t(el.dataset.i18nTitle)));
}
localizeStaticText();
const MODE_NOTE = { label: t("displayModeHintLabel"), fold: t("displayModeHintFold") };
const THRESHOLD_HINT = { "0.8": t("sensitivityHintLow"), "0.6": t("sensitivityHintMid"), "0.4": t("sensitivityHintHigh") };
const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => ({ ok: false, error: t("accountConnectFailed") }));
const fmt = (n) => Number(n).toLocaleString(chrome.i18n.getUILanguage());
let authenticated = false;
let googleBusy = false;
let viewVersion = 0;
let checkInAccountId = null;
let checkInState = null;
let checkInBusy = false;
let checkInVersion = 0;
let currentSettings = null;
let sessionChecked = 0;
let activePageVersion = 0;

function message(el, text = "", tone = "") {
  el.textContent = text;
  el.dataset.tone = tone;
  el.hidden = !text;
}

// ---------- Settings summary row ----------

let settingsExpanded = false;
function renderSettingsSummary() {
  if (!currentSettings) return;
  const words = (currentSettings.keywords || []).length;
  const parts = [
    currentSettings.aiDetect !== false ? t("settingsSummaryAiOn") : t("settingsSummaryAiOff"),
    words ? t("settingsSummaryKeywords", String(words)) : t("settingsSummaryKeywordsNone"),
    t(`settingsSummarySensitivity${currentSettings.threshold === 0.8 ? "Low" : currentSettings.threshold === 0.4 ? "High" : "Mid"}`)
  ];
  // 三项摘要统一用间隔点分隔，保持紧凑且便于阅读。
  $("settingsSummary").textContent = parts.join(" · ");
}
let settingsAnimation;
$("settingsToggle").addEventListener("click", async () => {
  const panel = $("settingsDetail");
  const height = panel.getBoundingClientRect().height;
  settingsAnimation?.cancel();
  settingsExpanded = !settingsExpanded;
  $("settingsToggle").setAttribute("aria-expanded", String(settingsExpanded));
  $("settingsToggleLabel").textContent = t(settingsExpanded ? "settingsCollapse" : "settingsExpand");
  panel.hidden = false;
  panel.inert = !settingsExpanded;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  // 从当前高度展开/收起，连续点击时取消旧动画；收起期间禁止聚焦隐藏控件。
  panel.style.overflow = "hidden";
  const animation = settingsAnimation = panel.animate(
    [{ height: `${height}px` }, { height: `${settingsExpanded ? panel.scrollHeight : 0}px` }],
    { duration: reducedMotion ? 0 : 240, easing: "ease-out" }
  );
  try { await animation.finished; } catch { return; }
  panel.hidden = !settingsExpanded;
  panel.style.overflow = "";
  settingsAnimation = null;
  // 弹窗高度有限，展开后将设置入口滚到上方，使下方设置进入可见区域。
  if (settingsExpanded) $("settingsToggle").closest(".summary").scrollIntoView({ behavior: reducedMotion ? "instant" : "smooth", block: "start" });
});

// ---------- Check-in ----------

function setCheckInAccount(id) {
  if (checkInAccountId === id) return;
  checkInAccountId = id;
  checkInState = null;
  checkInBusy = false;
  checkInVersion++;
  if (id) updateCheckIn();
}
async function updateCheckIn(claim = false) {
  if (!checkInAccountId || checkInBusy || (claim && checkInState?.claimed)) return;
  const current = ++checkInVersion;
  checkInBusy = true;
  $("checkIn").disabled = true;
  // 已有签到状态时静默查询，避免 Claimed 反复切换为加载文案；领取仍显示进度。
  if (claim || !checkInState) $("checkIn").textContent = claim ? t("checkInClaiming") : t("checkInQuerying");
  // Only reads state on init/refresh; a write request is only sent when the user explicitly clicks claim. Discard stale responses after switching accounts.
  const res = await send({ type: claim ? "claimCheckIn" : "getCheckIn" });
  if (current !== checkInVersion) return;
  checkInBusy = false;
  if (res?.ok && res.account.id === checkInAccountId) {
    checkInState = res.checkIn;
    $("checkIn").disabled = checkInState.claimed;
    $("checkIn").textContent = checkInState.claimed ? t("checkInClaimedToday") : t("checkInClaimPrompt", fmt(checkInState.amount));
    $("checkInNote").textContent = t("checkInNote");
    if (claim && checkInState.claimed) showRefreshedBadge();
  } else {
    if (!claim) checkInState = null;
    $("checkIn").disabled = false;
    $("checkIn").textContent = checkInState ? t("checkInRetryClaim") : t("checkInRetryQuery");
    $("checkInNote").textContent = res?.error || t("checkInNotConfirmed");
  }
}
$("checkIn").addEventListener("click", () => updateCheckIn(Boolean(checkInState)));

let refreshedBadgeTimer;
function showRefreshedBadge() {
  $("refreshedBadge").hidden = false;
  clearTimeout(refreshedBadgeTimer);
  refreshedBadgeTimer = setTimeout(() => { $("refreshedBadge").hidden = true; }, 3000);
}

// 默认不勾选，只有用户主动勾选才保存授权；打开隐私链接不会授权。
$("acceptDataConsent").addEventListener("change", async () => {
  const consent = $("acceptDataConsent").checked;
  $("acceptDataConsent").disabled = true;
  updateConsentButtons();
  const res = await send({ type: "setDataConsent", consent });
  $("acceptDataConsent").disabled = false;
  if (!res?.ok) {
    $("acceptDataConsent").checked = !consent;
    message($("dataConsentError"), t("dataConsentFailed"), "error");
    updateConsentButtons();
    return;
  }
  message($("dataConsentError"), "");
  await syncAccount({ resetLoginState: false });
});

$("googleLogin").addEventListener("click", async () => {
  if (!hasLoginConsent() || googleBusy || sendingCode) return;
  googleBusy = true;
  updateConsentButtons();
  message($("loginStatus"), "");
  const res = await send({ type: "loginWithGoogle" });
  googleBusy = false;
  updateConsentButtons();
  if (!res?.ok) {
    const key = res?.code === "google_cancelled" ? "googleCancelled" : res?.code === "google_unavailable" ? "googleUnavailable" : "googleFailed";
    message($("loginStatus"), t(key), "error");
    return;
  }
  $("loginDoneNote").textContent = t("loginDoneNote", fmt(res.account.credits));
  setLoginState("done");
  await syncAccount();
});

// ---------- Load + account rendering ----------

async function load() {
  const s = await send({ type: "getSettings" });
  const { stats, lastLoginEmail, account } = await chrome.storage.local.get(["stats", "lastLoginEmail", "account"]);
  // 只预填空输入框，避免异步加载覆盖用户已经输入的邮箱。
  if (!$("email").value) $("email").value = lastLoginEmail || account?.email || "";
  currentSettings = s;
  setSeg("mode", s.mode === "blur" ? "fold" : s.mode, false);
  renderChips(s.keywords || []);
  $("aiDetect").setAttribute("aria-checked", String(s.aiDetect !== false));
  setSeg("threshold", String(s.threshold), false);
  renderStats(stats);
  renderSettingsSummary();
  await syncAccount();
  // syncAccount 已触发首次签到查询，初始化刷新余额时不再重复查询。
  if (authenticated) refreshAccount({ refreshCheckIn: false });
}
async function syncAccount({ resetLoginState = true } = {}) {
  const current = ++viewVersion;
  const s = await send({ type: "getSettings" });
  const { account } = await chrome.storage.local.get("account");
  if (current !== viewVersion) return;
  // 隐私勾选只在登录前显示，已保存的同意状态仍用于登录和识别校验。
  $("dataConsentNotice").hidden = Boolean(s.authenticated);
  $("acceptDataConsent").checked = s.dataConsent === true;
  currentSettings = s;
  updateConsentButtons();
  const wasAuthenticated = authenticated;
  authenticated = Boolean(s.authenticated);
  $("loginView").querySelector(".login-card").append($("dataConsentNotice"));
  // Right after a successful login, the "you're signed in" screen (data-login-state="done") must
  // stay visible until the user dismisses it; only reset to the empty email step when the popup
  // opened logged-out, or when a session ends (logout / expiry) while it was previously signed in.
  if (resetLoginState && !(authenticated && !wasAuthenticated)) document.body.dataset.loginState = "idle";
  $("loginView").hidden = authenticated && document.body.dataset.loginState !== "done";
  $("appView").hidden = !authenticated;
  if (authenticated && account) renderAccount(account);
  else setCheckInAccount(null);
}
function renderAccount(account) {
  setCheckInAccount(account.id);
  // 后台确认额度不足时也显示暂停，避免余额缓存尚未更新时仍显示 Live。
  const exhausted = currentSettings?.quotaExhausted === true || account.credits === 0;
  $("account").dataset.state = exhausted ? "empty" : "ok";
  $("accountEmptyNote").hidden = !exhausted;
  $("sessionStatus").dataset.state = exhausted ? "paused" : "live";
  $("sessionStatus").textContent = t(exhausted ? "statsPaused" : "statsAutoTally");
  const unit = t("accountCreditsUnit");
  $("creditsValue").textContent = fmt(account.credits);
  $("creditsUnit").textContent = unit;
  const total = account.credits + account.used;
  $("creditsBar").style.width = `${total > 0 ? Math.min(100, Math.round((account.credits / total) * 100)) : 0}%`;
  $("accountEmail").textContent = account.email;
  $("accountEmail").title = account.email;
  $("accountUsedLine").textContent = t("accountUsedTotal", fmt(account.used));
}
async function refreshAccount({ refreshCheckIn = true } = {}) {
  const res = await send({ type: "getAccount" });
  await syncAccount();
  if (res?.ok) {
    if (refreshCheckIn) await updateCheckIn();
  } else if (["auth_required", "account_disabled"].includes(res?.code)) {
    await syncAccount();
    message($("loginStatus"), res.error, "error");
  } else if (res?.code !== "session_changed") {
    message($("accountStatus"), res?.error || t("accountRefreshFailed"), "error");
  }
}
chrome.storage.onChanged.addListener((c) => {
  if (c.stats) renderStats(c.stats.newValue);
  if (c.auth || c.account || c.dataConsent) syncAccount({ resetLoginState: !c.dataConsent });
});
chrome.runtime.onMessage.addListener((msg) => {
  // 重新读取当前账户状态，不把旧账户的异步额度通知直接应用到界面。
  if (msg?.type === "quotaChanged") syncAccount();
});
window.addEventListener("focus", () => {
  // 从领取或购买页面返回时同步余额，不在后台持续轮询。
  if (authenticated) refreshAccount();
});

// ---------- Sign-in flow ----------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const LOGIN_CODE_TTL_MS = 10 * 60 * 1000;
let loginTimer;
let resendAvailableAt = 0;
let codeExpiresAt = 0;
let sendingCode = false;

// 同意必须已成功保存，保存中及未勾选时所有登录入口都保持禁用。
function hasLoginConsent() {
  return currentSettings?.dataConsent === true && $("acceptDataConsent").checked && !$("acceptDataConsent").disabled;
}
function updateConsentButtons() {
  const blocked = !hasLoginConsent();
  $("requestCode").disabled = blocked || sendingCode || googleBusy;
  $("googleLogin").disabled = blocked || sendingCode || googleBusy;
  lockLoginButton($("loginCode").value.length !== 6 || document.body.dataset.loginState === "expired");
  updateLoginTimer();
}
function setLoginState(state) {
  document.body.dataset.loginState = state;
  $("authStatus").dataset.tone = state === "done" ? "ok" : "";
  if (state === "idle") {
    stopLoginTimer();
    resendAvailableAt = codeExpiresAt = 0;
    $("emailError").hidden = true;
    $("email").classList.remove("bad");
    $("codeError").hidden = true;
    $("loginCode").classList.remove("bad");
    $("loginCode").value = "";
    $("loginCode").disabled = false;
    lockLoginButton(true);
  }
  if (state === "sent") {
    $("codeError").hidden = true;
    $("loginCode").classList.remove("bad");
    $("loginCode").value = "";
    $("loginCode").disabled = false;
    $("loginStepCodeNote").textContent = t("loginStepCodeNote");
    lockLoginButton(true);
  }
  if (state === "error") { $("codeError").hidden = false; $("loginCode").classList.add("bad"); }
  if (state === "done") stopLoginTimer();
}
function lockLoginButton(locked) {
  locked = locked || !hasLoginConsent();
  $("login").disabled = locked;
  $("login").setAttribute("aria-disabled", String(locked));
}
function stopLoginTimer() {
  clearInterval(loginTimer);
  loginTimer = null;
}
function updateLoginTimer() {
  const state = document.body.dataset.loginState;
  if (!["sent", "error", "expired"].includes(state)) return;
  const now = Date.now();
  // 用实际时间判断有效期与冷却期，避免侧栏休眠后倒计时停滞；过期码不再允许提交。
  if (codeExpiresAt && now >= codeExpiresAt && state !== "expired") {
    document.body.dataset.loginState = "expired";
    $("loginStepCodeNote").textContent = t("loginCodeExpired");
    $("loginCode").value = "";
    $("loginCode").disabled = true;
    $("codeError").hidden = true;
    $("loginCode").classList.remove("bad");
    lockLoginButton(true);
    message($("loginStatus"), "");
  }
  const left = Math.max(0, Math.ceil((resendAvailableAt - now) / 1000));
  $("resendCode").disabled = !hasLoginConsent() || sendingCode || left > 0;
  $("resendCode").textContent = sendingCode ? t("loginSendingCode") : left ? t("loginResendIn", String(left)) : t("loginResendCode");
  if (!left && document.body.dataset.loginState === "expired") stopLoginTimer();
}
function codeSent(retryAfter = 60) {
  const now = Date.now();
  codeExpiresAt = now + LOGIN_CODE_TTL_MS;
  resendAvailableAt = now + retryAfter * 1000;
  setLoginState("sent");
  message($("loginStatus"), "");
  stopLoginTimer();
  updateLoginTimer();
  loginTimer = setInterval(updateLoginTimer, 1000);
}

$("requestCodeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!hasLoginConsent() || sendingCode || googleBusy) return;
  const value = $("email").value.trim();
  if (!EMAIL_RE.test(value)) {
    $("emailError").hidden = false;
    $("email").classList.add("bad");
    $("email").focus();
    return;
  }
  $("emailError").hidden = true;
  $("email").classList.remove("bad");
  sendingCode = true;
  updateConsentButtons();
  message($("loginStatus"), "");
  document.body.dataset.loginState = "sending";
  const res = await send({ type: "requestCode", email: value });
  sendingCode = false;
  updateConsentButtons();
  if (res?.ok) {
    $("sentToEmail").textContent = value;
    codeSent(res.retryAfter);
    $("loginCode").focus();
  } else {
    setLoginState("idle");
    message($("loginStatus"), res?.error || t("loginCodeSendFailed"), "error");
  }
});
$("email").addEventListener("input", () => {
  if (EMAIL_RE.test($("email").value.trim())) {
    $("emailError").hidden = true;
    $("email").classList.remove("bad");
  }
});
$("loginCode").addEventListener("input", () => {
  if (codeExpiresAt && Date.now() >= codeExpiresAt) { updateLoginTimer(); return; }
  $("loginCode").value = $("loginCode").value.replace(/\D/g, "").slice(0, 6);
  $("codeError").hidden = true;
  $("loginCode").classList.remove("bad");
  lockLoginButton($("loginCode").value.length !== 6);
});
$("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (codeExpiresAt && Date.now() >= codeExpiresAt) { updateLoginTimer(); return; }
  if (!hasLoginConsent() || $("login").disabled) return;
  lockLoginButton(true);
  message($("loginStatus"), "");
  const res = await send({ type: "login", email: $("sentToEmail").textContent, code: $("loginCode").value.trim() });
  if (!res?.ok) {
    setLoginState("error");
    updateLoginTimer();
    lockLoginButton($("loginCode").value.length !== 6);
    message($("loginStatus"), res?.error || t("loginFailed"), "error");
    return;
  }
  $("loginDoneNote").textContent = t("loginDoneNote", fmt(res.account.credits));
  setLoginState("done");
  await syncAccount(); // authenticated flips true; loginView stays visible to show the "done" screen until dismissed.
});
$("resendCode").addEventListener("click", async () => {
  if (!["sent", "error", "expired"].includes(document.body.dataset.loginState)) return;
  updateLoginTimer();
  if ($("resendCode").disabled || sendingCode) return;
  sendingCode = true;
  updateLoginTimer();
  const value = $("sentToEmail").textContent;
  const res = await send({ type: "requestCode", email: value });
  sendingCode = false;
  if ($("sentToEmail").textContent !== value || document.body.dataset.loginState === "idle") return;
  if (res?.ok) codeSent(res.retryAfter);
  else {
    updateLoginTimer();
    message($("loginStatus"), res?.error || t("loginCodeSendFailed"), "error");
  }
});
$("changeEmail").addEventListener("click", () => {
  setLoginState("idle");
  $("email").focus();
});
$("loginDoneClose").addEventListener("click", () => {
  document.body.dataset.loginState = "idle";
  $("loginView").hidden = true;
  $("appView").hidden = false;
});

// ---------- Logout ----------

$("logout").addEventListener("click", async () => {
  $("logout").disabled = true;
  const res = await send({ type: "logout" });
  if (!res?.ok) {
    $("logout").disabled = false;
    message($("accountStatus"), res?.error || t("accountLogoutFailed"), "error");
    return;
  }
  await syncAccount();
});

// ---------- Blocked keywords ----------

const MAX_KEYWORDS = 10;
let keywords = [];

function renderChips(list) {
  keywords = list;
  const ul = $("chips");
  ul.textContent = "";
  for (const k of list) {
    const li = document.createElement("li");
    li.className = "tag";
    const text = document.createElement("span");
    text.textContent = k;
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "×";
    del.setAttribute("aria-label", t("keywordRemoveAriaLabel", k));
    del.onclick = () => saveKeywords(keywords.filter((x) => x !== k));
    li.append(text, del);
    ul.append(li);
  }
  $("kwInput").disabled = list.length >= MAX_KEYWORDS;
  $("kwInput").placeholder = list.length >= MAX_KEYWORDS ? t("keywordsPlaceholderMax", String(MAX_KEYWORDS)) : list.length ? t("keywordsPlaceholderMore") : t("keywordsPlaceholder");
  $("kwCount").textContent = t("keywordsCount", String(list.length));
  if (currentSettings) { currentSettings.keywords = list; renderSettingsSummary(); }
}

function saveKeywords(list) {
  renderChips(list);
  chrome.storage.local.set({ keywords: list });
}
function addKeyword(value) {
  const trimmed = value.trim().slice(0, 20);
  if (!trimmed || keywords.length >= MAX_KEYWORDS || keywords.some((x) => x.toLowerCase() === trimmed.toLowerCase())) return;
  saveKeywords([...keywords, trimmed]);
}

$("kwInput").addEventListener("keydown", (e) => {
  if (e.isComposing) return; // Enter presses while an IME composition is active (e.g. selecting a Chinese candidate) don't count.
  const input = e.target;
  if (e.key === "Enter" || e.key === ",") {
    e.preventDefault();
    // Support pasting several keywords at once: split on comma, Chinese comma/enumeration comma, or whitespace.
    const add = input.value.split(/[,，、\s]+/).map((k) => k.trim().slice(0, 20)).filter(Boolean);
    const next = [...keywords];
    for (const k of add) if (!next.some((x) => x.toLowerCase() === k.toLowerCase())) next.push(k);
    input.value = "";
    if (next.length !== keywords.length) saveKeywords(next.slice(0, MAX_KEYWORDS));
  } else if (e.key === "Backspace" && !input.value && keywords.length) {
    saveKeywords(keywords.slice(0, -1));
  }
});
$("kwBox").addEventListener("click", (e) => {
  if (!e.target.closest("button")) $("kwInput").focus();
});
document.querySelectorAll("[data-preset]").forEach((button) => {
  button.textContent = t(button.dataset.preset);
  button.addEventListener("click", () => addKeyword(t(button.dataset.preset)));
});

// ---------- Row toggle (AI flag) ----------

function bindRowToggle(rowId, swId, storageKey) {
  const row = $(rowId);
  const sw = $(swId);
  const toggle = () => {
    const next = sw.getAttribute("aria-checked") !== "true";
    sw.setAttribute("aria-checked", String(next));
    chrome.storage.local.set({ [storageKey]: next });
    if (currentSettings) { currentSettings[storageKey] = next; renderSettingsSummary(); }
  };
  sw.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
  row.addEventListener("click", (e) => { if (e.target !== sw) toggle(); });
}
bindRowToggle("aiRow", "aiDetect", "aiDetect");

// ---------- Stats ----------

// 仅查询已获授权的 X 域名，不增加读取其他网站地址的权限。
async function updateOpenXCard() {
  const version = ++activePageVersion;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true, url: ["https://x.com/*", "https://twitter.com/*"] });
    if (version !== activePageVersion) return;
    const show = sessionChecked === 0 && tabs.length === 0;
    $("openXCard").hidden = !show;
    $("sessionStats").hidden = show;
  } catch { /* 无法确认当前页时保留统计区。 */ }
}
// 侧栏保持打开时，也跟随切换标签页和导航更新提示。
chrome.tabs.onActivated.addListener(updateOpenXCard);
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.url || change.status === "complete") updateOpenXCard();
});
function renderStats(stats = { checked: 0, ads: 0 }) {
  sessionChecked = stats.checked || 0;
  updateOpenXCard();
  $("checked").textContent = fmt(stats.checked);
  $("ads").textContent = fmt(stats.ads);
  const rate = stats.checked ? Math.round((stats.ads / stats.checked) * 100) : 0;
  $("rate").textContent = stats.checked ? `${rate}` : "–";
  if (stats.checked) {
    const rateEl = $("rate");
    rateEl.innerHTML = "";
    rateEl.append(document.createTextNode(String(rate)));
    const small = document.createElement("small");
    small.textContent = "%";
    rateEl.append(small);
  }
  $("rateBar").style.width = `${stats.checked ? rate : 0}%`;
}

// ---------- Segmented control ----------

function setSeg(name, value, animate = true) {
  const seg = document.querySelector(`.seg[data-name="${name}"]`);
  const buttons = [...seg.querySelectorAll("button")];
  let i = buttons.findIndex((b) => b.dataset.value === value);
  if (i < 0) i = name === "threshold" ? 1 : 0;
  buttons.forEach((b, j) => b.setAttribute("aria-checked", String(j === i)));
  if (name === "mode") $("modeNote").textContent = MODE_NOTE[buttons[i].dataset.value] || "";
  if (name === "threshold") $("thresholdNote").textContent = THRESHOLD_HINT[buttons[i].dataset.value] || "";
}

document.querySelectorAll(".seg").forEach((seg) => {
  seg.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const name = seg.dataset.name;
    const value = btn.dataset.value;
    setSeg(name, value);
    const stored = name === "threshold" ? Number(value) : value;
    chrome.storage.local.set({ [name]: stored });
    if (currentSettings) { currentSettings[name] = stored; renderSettingsSummary(); }
  });
});

load().catch(() => message($("accountStatus"), t("accountConnectFailed"), "error"));
