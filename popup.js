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
const THRESHOLD_HINT = { "0.8": t("sensitivityHintLow"), "0.6": t("sensitivityHintMid"), "0.4": t("sensitivityHintHigh") };
const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => ({ ok: false, error: t("accountConnectFailed") }));
const fmt = (n) => Number(n).toLocaleString(chrome.i18n.getUILanguage());
let authenticated = false;
let viewVersion = 0;
let checkInAccountId = null;
let checkInState = null;
let checkInBusy = false;
let checkInVersion = 0;

function setCheckInAccount(id) {
  if (checkInAccountId === id) return;
  checkInAccountId = id;
  checkInState = null;
  checkInBusy = false;
  checkInVersion++;
  $("checkInRow").hidden = !id;
  if (id) updateCheckIn();
}
async function updateCheckIn(claim = false) {
  if (!checkInAccountId || checkInBusy || (claim && checkInState?.claimed)) return;
  const current = ++checkInVersion;
  checkInBusy = true;
  $("checkIn").disabled = true;
  $("checkIn").textContent = claim ? t("checkInClaiming") : t("checkInQuerying");
  // Only reads state on init/refresh; a write request is only sent when the user explicitly clicks claim. Discard stale responses after switching accounts.
  const res = await send({ type: claim ? "claimCheckIn" : "getCheckIn" });
  if (current !== checkInVersion) return;
  checkInBusy = false;
  if (res?.ok && res.account.id === checkInAccountId) {
    checkInState = res.checkIn;
    $("checkIn").disabled = checkInState.claimed;
    $("checkIn").textContent = checkInState.claimed ? t("checkInClaimedToday") : t("checkInClaimPrompt");
    $("checkInNote").textContent = t("checkInNote");
  } else {
    if (!claim) checkInState = null;
    $("checkIn").disabled = false;
    $("checkIn").textContent = checkInState ? t("checkInRetryClaim") : t("checkInRetryQuery");
    $("checkInNote").textContent = res?.error || t("checkInNotConfirmed");
  }
}
$("checkIn").addEventListener("click", () => updateCheckIn(Boolean(checkInState)));

async function load() {
  const s = await send({ type: "getSettings" });
  const { stats } = await chrome.storage.local.get(["stats"]);
  $("enabled").checked = s.enabled;
  document.body.classList.toggle("off", !s.enabled);
  setSeg("mode", s.mode === "blur" ? "fold" : s.mode, false);
  renderChips(s.keywords || []);
  $("smartMatch").checked = s.smartMatch !== false;
  $("aiDetect").checked = s.aiDetect !== false;
  setSeg("threshold", String(s.threshold), false);
  renderStats(stats);
  await syncAccount();
  if (authenticated) refreshAccount();
}
async function syncAccount() {
  const current = ++viewVersion;
  const s = await send({ type: "getSettings" });
  const { account } = await chrome.storage.local.get("account");
  if (current !== viewVersion) return;
  authenticated = Boolean(s.authenticated);
  if (authenticated && account) renderAccount(account);
  else renderLoggedOut();
}
function renderLoggedOut(message = t("accountLoggedOutNote")) {
  setCheckInAccount(null);
  $("account").dataset.state = "free";
  $("planName").textContent = t("accountLoginCta");
  $("accountMeta").textContent = "";
  $("accountEmail").textContent = "";
  $("accountNote").textContent = message;
  $("accountActions").hidden = true;
  $("loginField").hidden = false;
}
function renderAccount(account) {
  setCheckInAccount(account.id);
  $("refreshAccount").hidden = false;
  $("account").dataset.state = account.credits > 0 ? "free" : "empty";
  $("planName").textContent = t("accountName");
  $("accountMeta").textContent = t("accountCreditsRemaining", fmt(account.credits));
  $("accountEmail").textContent = account.email;
  $("accountNote").textContent = t("accountUsedTotal", fmt(account.used)) + " · " + (account.credits > 0 ? t("accountSharedAcrossDevices") : t("accountOutOfCredits"));
  $("accountActions").hidden = false;
  $("loginField").hidden = true;
}
function renderAccountError(message) {
  $("accountStatus").dataset.tone = "error";
  $("accountStatus").textContent = message;
}
async function refreshAccount() {
  $("refreshAccount").disabled = true;
  const res = await send({ type: "getAccount" });
  $("refreshAccount").disabled = false;
  await syncAccount();
  if (res?.ok) {
    $("accountStatus").dataset.tone = "ok";
    $("accountStatus").textContent = t("accountRefreshed");
    await updateCheckIn();
  } else if (["auth_required", "account_disabled"].includes(res?.code)) {
    renderLoggedOut(res.error);
  } else if (res?.code !== "session_changed") renderAccountError(res?.error || t("accountRefreshFailed"));
}
$("refreshAccount").addEventListener("click", refreshAccount);
let cooldownTimer;
function cooldown(seconds) {
  clearInterval(cooldownTimer);
  const until = Date.now() + seconds * 1000;
  const update = () => {
    const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    $("requestCode").disabled = left > 0;
    $("requestCode").textContent = left ? t("loginResendIn", String(left)) : t("loginSendCode");
    if (!left) clearInterval(cooldownTimer);
  };
  update();
  cooldownTimer = setInterval(update, 1000);
}
$("requestCodeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("requestCode").disabled = true;
  $("loginStatus").dataset.tone = "";
  $("loginStatus").textContent = t("loginSendingCode");
  const res = await send({ type: "requestCode", email: $("email").value.trim() });
  if (res?.ok) {
    cooldown(res.retryAfter || 60);
    $("loginStatus").dataset.tone = "ok";
    $("loginStatus").textContent = t("loginCodeSent");
    $("loginCode").focus();
  } else {
    $("requestCode").disabled = false;
    $("loginStatus").dataset.tone = "error";
    $("loginStatus").textContent = res?.error || t("loginCodeSendFailed");
  }
});
$("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!$("email").reportValidity()) return;
  $("login").disabled = true;
  $("loginStatus").dataset.tone = "";
  $("loginStatus").textContent = t("loginInProgress");
  const res = await send({ type: "login", email: $("email").value.trim(), code: $("loginCode").value.trim() });
  $("login").disabled = false;
  if (!res?.ok) {
    $("loginStatus").dataset.tone = "error";
    $("loginStatus").textContent = res?.error || t("loginFailed");
    return;
  }
  $("loginCode").value = "";
  $("loginStatus").textContent = "";
  $("accountStatus").textContent = "";
  await syncAccount();
});
async function logout(all) {
  $("logout").disabled = $("logoutAll").disabled = true;
  const res = await send({ type: "logout", all });
  $("logout").disabled = $("logoutAll").disabled = false;
  if (!res?.ok) return renderAccountError(res?.error || t("accountLogoutFailed"));
  $("accountStatus").textContent = "";
  await syncAccount();
}
$("logout").addEventListener("click", () => logout(false));
$("logoutAll").addEventListener("click", () => logout(true));

// ---------- Blocked keywords ----------

const MAX_KEYWORDS = 10;
let keywords = [];

function renderChips(list) {
  keywords = list;
  const ul = $("chips");
  ul.textContent = "";
  for (const k of list) {
    const li = document.createElement("li");
    li.className = "chip";
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
}

function saveKeywords(list) {
  renderChips(list);
  chrome.storage.local.set({ keywords: list });
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
$("smartMatch").addEventListener("change", (e) => chrome.storage.local.set({ smartMatch: e.target.checked }));
$("aiDetect").addEventListener("change", (e) => chrome.storage.local.set({ aiDetect: e.target.checked }));

// ---------- Stats ----------

function renderStats(stats = { checked: 0, ads: 0 }) {
  $("checked").textContent = stats.checked;
  $("ads").textContent = stats.ads;
  $("rate").textContent = stats.checked ? `${Math.round((stats.ads / stats.checked) * 100)}%` : "–";
}

chrome.storage.onChanged.addListener((c) => {
  if (c.stats) renderStats(c.stats.newValue);
  if (c.auth || c.account) syncAccount();
});

// ---------- Segmented control ----------

function setSeg(name, value, animate = true) {
  const seg = document.querySelector(`.seg[data-name="${name}"]`);
  const buttons = [...seg.querySelectorAll("button")];
  let i = buttons.findIndex((b) => b.dataset.value === value);
  if (i < 0) i = name === "threshold" ? 1 : 0;
  buttons.forEach((b, j) => b.setAttribute("aria-checked", String(j === i)));
  seg.classList.toggle("no-anim", !animate);
  seg.style.setProperty("--n", buttons.length);
  seg.style.setProperty("--i", i);
  if (name === "threshold") $("thresholdHint").textContent = THRESHOLD_HINT[buttons[i].dataset.value] || "";
}

document.querySelectorAll(".seg").forEach((seg) => {
  seg.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const name = seg.dataset.name;
    const value = btn.dataset.value;
    setSeg(name, value);
    chrome.storage.local.set({ [name]: name === "threshold" ? Number(value) : value });
  });
});

$("enabled").addEventListener("change", (e) => {
  document.body.classList.toggle("off", !e.target.checked);
  chrome.storage.local.set({ enabled: e.target.checked });
});

load().catch(() => renderAccountError(t("accountConnectFailed")));
