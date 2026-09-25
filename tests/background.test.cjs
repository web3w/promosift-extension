const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const source = readFileSync(path.join(root, "background.js"), "utf8");
const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
const enMessages = JSON.parse(readFileSync(path.join(root, "_locales", "en", "messages.json"), "utf8"));
const X_MATCHES = ["https://x.com/*", "https://twitter.com/*"];
const API_BASE = JSON.parse(readFileSync(path.join(root, "config.json"), "utf8")).apiBase;
const POPUP = "chrome-extension://adsift-test/popup.html";
const account = (id = "alice", credits = 10, used = 0) => ({ id, email: `${id}@example.com`, role: "user", status: "active", credits, used, createdAt: 1 });
const session = (id = "alice", credits = 10, used = 0) => ({ dataConsent: true, auth: { token: `${id}-token`, apiBase: API_BASE, expiresAt: Date.now() + 60_000 }, account: account(id, credits, used) });
const serverResult = (user = account("alice", 9, 1)) => ({ ok: true, result: { prob: 0.4, kind: "organic", kindProbs: { organic: 0.6 } }, topics: {}, ai: null, account: user });
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for async request");
    await tick();
  }
}
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => clone(body) });

// Testing only goes through Chrome messages and the context menu entry point; every request is intercepted here to avoid hitting a real service or billing.
function harness(initial = {}, remote = () => response(serverResult()), timers = { setTimeout, clearTimeout }, identity = {}) {
  const storage = clone(initial);
  const calls = [];
  const menus = [];
  const toasts = [];
  const badges = [];
  const accessLevels = [];
  let onChanged = () => {};
  let onMessage;
  let onInstalled;
  let onClicked;
  let onTabUpdated;
  const windowListeners = new Set();
  const windowUpdates = [];
  const windows = new Map();
  const chrome = {
    windows: {
      onCreated: { addListener: fn => windowListeners.add(fn), removeListener: fn => windowListeners.delete(fn) },
      async get(id) { return windows.get(id); },
      async update(id, bounds) { windowUpdates.push({ id, ...bounds }); }
    },
    identity: { getRedirectURL: () => "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/google", ...identity },
    runtime: {
      getURL: (name) => `chrome-extension://adsift-test/${name}`,
      onMessage: { addListener: (fn) => (onMessage = fn) },
      onInstalled: { addListener: (fn) => (onInstalled = fn) }
    },
    i18n: {
      getMessage: (key) => enMessages[key]?.message || key
    },
    storage: {
      onChanged: { addListener: (fn) => (onChanged = fn) },
      local: {
        async setAccessLevel(value) { accessLevels.push(clone(value)); },
        async get(query) {
          if (Array.isArray(query)) return clone(Object.fromEntries(query.filter(key => key in storage).map(key => [key, storage[key]])));
          if (typeof query === "string") return query in storage ? clone({ [query]: storage[query] }) : {};
          return clone(Object.fromEntries(Object.entries(query).map(([key, fallback]) => [key, key in storage ? storage[key] : fallback])));
        },
        async set(value) {
          const changes = {};
          for (const [key, next] of Object.entries(value)) {
            if (JSON.stringify(storage[key]) !== JSON.stringify(next)) changes[key] = { oldValue: clone(storage[key]), newValue: clone(next) };
          }
          Object.assign(storage, clone(value));
          if (Object.keys(changes).length) onChanged(changes, "local");
        },
        async remove(key) { delete storage[key]; }
      }
    },
    contextMenus: {
      create: (menu) => menus.push(clone(menu)),
      onClicked: { addListener: (fn) => (onClicked = fn) }
    },
    action: {
      async setBadgeText(details) { badges.push(clone(details)); },
      async setBadgeBackgroundColor() {}
    },
    tabs: {
      onUpdated: { addListener: (fn) => (onTabUpdated = fn) },
      async query() { return []; },
      async sendMessage(tabId, message) {
        toasts.push({ tabId, message: clone(message) });
      }
    }
  };
  vm.runInNewContext(source, {
    chrome,
    URL, URLSearchParams, TextEncoder, btoa, crypto: require("node:crypto").webcrypto,
    AbortController,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    console,
    async fetch(url, init = {}) {
      if (url === "chrome-extension://adsift-test/config.json") return response({ apiBase: API_BASE });
      const call = { url: String(url), init, body: init.body ? JSON.parse(init.body) : undefined };
      calls.push(call);
      return remote(call);
    }
  }, { filename: "background.js" });
  return {
    windowListeners, windowUpdates,
    async createWindow(win) { windows.set(win.id, win); await Promise.all([...windowListeners].map(fn => fn(win))); },
    storage,
    calls,
    menus,
    toasts,
    badges,
    accessLevels,
    set: (value) => chrome.storage.local.set(value),
    install: () => onInstalled(),
    click: (info, tab) => onClicked(info, tab),
    tabUpdated: (tabId, changeInfo) => onTabUpdated(tabId, changeInfo),
    message: (message, senderUrl = POPUP, tabId) => new Promise((resolve, reject) => {
      try {
        const asyncReply = onMessage(message, { url: senderUrl, tab: tabId == null ? undefined : { id: tabId } }, (value) => resolve(clone(value)));
        if (asyncReply !== true && asyncReply !== false) reject(new Error(`Unhandled message: ${message.type}`));
      } catch (error) {
        reject(error);
      }
    })
  };
}

test("manifest only injects into X/Twitter and keeps required host permissions", () => {
  assert.equal(manifest.name, "__MSG_extName__");
  assert.equal(manifest.action.default_title, "__MSG_extName__");
  assert.equal(manifest.default_locale, "en");
  assert.deepEqual(manifest.content_scripts.flatMap((script) => script.matches).sort(), [...X_MATCHES].sort());
  assert.deepEqual([...manifest.host_permissions].sort(), [...X_MATCHES, `${API_BASE}/*`, "https://accounts.google.com/*"].sort());
});

test("toolbar badge counts identified ads per X tab and rejects other senders", async () => {
  const app = harness(session());
  assert.equal((await app.message({ type: "setBadgeCount", count: 3 }, "https://x.com/home", 7)).ok, true);
  assert.equal((await app.message({ type: "setBadgeCount", count: 1 }, "https://twitter.com/home", 8)).ok, true);
  assert.equal((await app.message({ type: "setBadgeCount", count: 0 }, "https://x.com/home", 7)).ok, true);
  assert.equal((await app.message({ type: "setBadgeCount", count: 1000 }, "https://x.com/home", 7)).ok, true);
  app.tabUpdated(8, { status: "loading" });
  assert.deepEqual(app.badges, [
    { tabId: 7, text: "3" }, { tabId: 8, text: "1" },
    { tabId: 7, text: "" }, { tabId: 7, text: "999+" }, { tabId: 8, text: "" }
  ]);
  assert.equal((await app.message({ type: "setBadgeCount", count: 2 }, "https://example.com", 7)).ok, false);
  assert.equal((await app.message({ type: "setBadgeCount", count: -1 }, "https://x.com/home", 7)).ok, false);
  assert.equal(app.badges.length, 5);
  assert.equal(app.calls.length, 0);
});

test("en and zh_CN locales define the same message keys", () => {
  const zh = JSON.parse(readFileSync(path.join(root, "_locales", "zh_CN", "messages.json"), "utf8"));
  assert.deepEqual(Object.keys(enMessages).sort(), Object.keys(zh).sort());
  for (const key of Object.keys(enMessages)) {
    assert.equal(typeof enMessages[key].message, "string", `en.${key} must have a string message`);
    assert.equal(typeof zh[key].message, "string", `zh_CN.${key} must have a string message`);
  }
});

test("the context menu only appears on X, and clicking it on a non-X/non-HTTPS page does not classify", async () => {
  const app = harness(session());
  await app.install();
  assert.equal(app.menus.length, 1);
  const menu = app.menus[0];
  assert.equal(menu.title, enMessages.contextMenuCheckSelection.message);
  assert.deepEqual(menu.documentUrlPatterns.sort(), [...X_MATCHES].sort());
  assert.deepEqual(menu.contexts, ["selection"]);
  for (const url of ["https://weibo.com/feed", "https://x.com.evil.example/", "http://x.com/home", "not-a-url"]) {
    await app.click({ menuItemId: menu.id, selectionText: "Buy my course", pageUrl: url }, { id: 7, url });
  }
  assert.equal(app.calls.length, 0);
  assert.equal(app.toasts.length, 0);
});

test("selected text on X and Twitter uses the X context and returns the result to the original tab", async () => {
  const app = harness(session(), () => response(serverResult(account("alice", 9, 1))));
  await app.install();
  for (const [index, url] of ["https://x.com/home", "https://twitter.com/home"].entries()) {
    const text = `Limited-time offer, click the link to buy the course ${index}`;
    await app.click({ menuItemId: app.menus[0].id, selectionText: ` ${text} ` }, { id: index + 1, url });
    await tick();
    assert.equal(app.calls[index].body.state.platform, "X");
    assert.equal(app.calls[index].body.state.text, text);
    assert.equal(app.toasts[index].tabId, index + 1);
  }
});

test("public settings carry no account token, and mark unauthenticated when logged out", async () => {
  const app = harness({ mode: "fold", keywords: ["AI"] });
  const settings = await app.message({ type: "getSettings" });
  assert.equal(settings.authenticated, false);
  assert.equal(settings.mode, "fold");
  assert.deepEqual(settings.keywords, ["AI"]);
  assert.equal(JSON.stringify(settings).includes("Bearer"), false);
  assert.equal(app.calls.length, 0);
});

test("account mode classifies with the session, skips AI detection for short content, and updates the account balance", async () => {
  const app = harness(session(), () => response(serverResult()));
  const result = await app.message({ type: "classify", state: { platform: "X", text: "Just chatting today" } });
  assert.equal(result.ok, true);
  assert.deepEqual(app.calls.map(call => call.url), [`${API_BASE}/v1/classify`]);
  assert.equal(app.calls[0].init.headers.Authorization, "Bearer alice-token");
  assert.equal(app.calls[0].body.state.platform, "X");
  assert.equal(app.calls[0].body.ai, false);
  assert.equal(result.aiShort, true);
  assert.deepEqual(app.storage.account, account("alice", 9, 1));
  assert.equal(app.storage.devices, undefined);
});

test("sufficiently long content requests AI detection", async () => {
  const app = harness(session(), () => response(serverResult()));
  const text = "This is a sufficiently long, standalone body of text for classifying ads and AI-generated content. ".repeat(4);
  const result = await app.message({ type: "classify", state: { platform: "X", text } });
  assert.equal(result.ok, true);
  assert.equal(app.calls[0].body.ai, true);
  assert.equal(result.aiShort, false);
});

test("classification still accepts a response after the server's 15-second model window", async () => {
  let now = 0;
  let complete;
  const pending = new Set();
  const timers = {
    setTimeout(fn, delay) {
      const timer = { fn, at: now + delay };
      pending.add(timer);
      return timer;
    },
    clearTimeout(timer) { pending.delete(timer); },
    advance(ms) {
      now += ms;
      for (const timer of [...pending]) if (timer.at <= now) { pending.delete(timer); timer.fn(); }
    }
  };
  const app = harness(session(), ({ init }) => new Promise((resolve, reject) => {
    complete = resolve;
    init.signal.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
  }), timers);
  const result = app.message({ type: "classify", state: { text: "a response arriving after the server model window" } });
  await waitFor(() => typeof complete === "function");
  timers.advance(16_000);
  complete(response(serverResult()));
  assert.equal((await result).ok, true);
});

test("cached classification uses the latest threshold without another request", async () => {
  const app = harness(session(), () => response(serverResult(account("alice", 9, 1))));
  const message = { type: "classify", state: { platform: "X", text: "threshold test content" } };
  const first = await app.message(message);
  assert.equal(first.result.prob, 0.4);
  app.storage.threshold = 0.3;
  const second = await app.message(message);
  assert.equal(second.result.isAd, true);
  assert.equal(app.calls.length, 1);
  assert.deepEqual(app.storage.stats, { checked: 1, ads: 0 });
});

test("concurrent and repeated classification shares one billable request", async () => {
  const releases = [];
  let requests = 0;
  const app = harness(session(), () => ++requests > 2 ? response(serverResult()) : new Promise((resolve) => { releases.push(() => resolve(response(serverResult()))); }));
  const message = { type: "classify", state: { platform: "X", text: "each explicit query counts even for repeated content" } };
  const first = app.message(message);
  const second = app.message(message);
  await waitFor(() => releases.length === 1);
  assert.equal(app.calls.length, 1);
  releases.forEach(release => release());
  const results = await Promise.all([first, second]);
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(await app.message(message), results[0]);
  await tick();
  assert.equal(app.calls.length, 1);
  assert.deepEqual(app.storage.stats, { checked: 1, ads: 0 });
});

test("no classification request is sent while logged out, with an expired session, or with a session from a different API base", async () => {
  for (const initial of [{}, { ...session(), auth: { ...session().auth, expiresAt: 1 } }, { ...session(), auth: { ...session().auth, apiBase: "https://old.example" } }]) {
    const app = harness(initial);
    const result = await app.message({ type: "classify", state: { text: "logged-out post" } });
    assert.equal(result.code, "auth_required");
    assert.equal((await app.message({ type: "getSettings" })).authenticated, false);
    assert.equal(app.calls.length, 0);
  }
});

test("logging in with a verification code saves an isolated session, and neither messages nor public settings leak the token", async () => {
  const app = harness({ dataConsent: true }, ({ url, body }) => {
    if (url.endsWith("/request-code")) {
      assert.deepEqual(body, { email: "alice@example.com" });
      return response({ ok: true, retryAfter: 60 });
    }
    assert.deepEqual(body, { email: "alice@example.com", code: "123456", client: "extension" });
    return response({ ok: true, token: "private-token", expiresAt: Date.now() + 60_000, account: account() });
  });
  assert.equal((await app.message({ type: "requestCode", email: "alice@example.com" })).ok, true);
  const login = await app.message({ type: "login", email: "alice@example.com", code: "123456" });
  assert.equal(login.ok, true);
  assert.equal(login.token, undefined);
  assert.equal(app.storage.auth.token, "private-token");
  const settings = await app.message({ type: "getSettings" }, "https://x.com/home");
  assert.equal(settings.authenticated, true);
  assert.doesNotMatch(JSON.stringify(settings), /private-token|alice@example|auth"/);
  assert.deepEqual(app.accessLevels, [{ accessLevel: "TRUSTED_CONTEXTS" }]);
  for (const type of ["login", "logout", "getAccount", "requestCode"]) {
    assert.equal((await app.message({ type }, "https://x.com/home")).code, "forbidden");
  }
});

test("an incorrect verification code does not create a session; logout revokes the current session", async () => {
  const invalid = harness({ dataConsent: true }, () => response({ ok: false, code: "invalid_code", error: "Invalid code" }, 400));
  assert.equal((await invalid.message({ type: "login", email: "alice@example.com", code: "000000" })).code, "invalid_code");
  assert.equal(invalid.storage.auth, undefined);
  const app = harness(session(), () => response({ ok: true }));
  assert.equal((await app.message({ type: "logout" })).ok, true);
  assert.equal(app.calls[0].url, `${API_BASE}/v1/auth/logout`);
  assert.equal(app.storage.auth, null);
  assert.equal(app.storage.account, null);
  assert.deepEqual(app.storage.stats, { checked: 0, ads: 0 });
  assert.equal((await app.message({ type: "getSettings" })).authenticated, false);
});

test("a 401 clears the login state without auto-registering; a failed network logout is not disguised as revoked", async () => {
  const app = harness(session(), () => response({ ok: false, code: "auth_required", error: "Session expired" }, 401));
  assert.equal((await app.message({ type: "getAccount" })).code, "auth_required");
  assert.equal(app.storage.auth, null);
  assert.equal(app.calls.length, 1);
  const offline = harness(session(), () => { throw Error("network offline"); });
  assert.equal((await offline.message({ type: "logout" })).code, "network");
  assert.equal(offline.storage.auth.token, "alice-token");
});

test("running out of credits stops requests; refreshing after a top-up recovers immediately with no midnight freeze", async () => {
  let exhausted = true;
  const app = harness(session(), ({ url }) => {
    if (url.endsWith("/v1/me")) return response({ ok: true, account: account("alice", 20) });
    return exhausted ? response({ ok: false, code: "quota", error: "Out of credits" }, 402) : response(serverResult(account("alice", 19, 1)));
  });
  for (const text of ["post one", "post two"]) assert.equal((await app.message({ type: "classify", state: { text } })).code, "quota");
  assert.equal(app.calls.length, 1);
  exhausted = false;
  assert.equal((await app.message({ type: "getAccount" })).ok, true);
  assert.equal((await app.message({ type: "classify", state: { text: "post after top-up" } })).ok, true);
  assert.equal(app.calls.length, 3);
});

test("switching accounts invalidates an old in-flight result without overwriting the new account's balance or stats", async () => {
  let release;
  const app = harness(session(), ({ url, init }) => {
    if (url.endsWith("/verify-code")) return response({ ok: true, token: "bob-token", expiresAt: Date.now() + 60_000, account: account("bob", 30) });
    if (init.headers.Authorization === "Bearer alice-token") return new Promise(resolve => { release = () => resolve(response(serverResult())); });
    return response(serverResult(account("bob", 29, 1)));
  });
  const message = { type: "classify", state: { text: "still the same post after switching accounts" } };
  const old = app.message(message);
  await waitFor(() => release);
  await app.message({ type: "login", email: "bob@example.com", code: "123456" });
  release();
  assert.equal((await old).code, "session_changed");
  assert.deepEqual(app.storage.account, account("bob", 30));
  assert.deepEqual(app.storage.stats, { checked: 0, ads: 0 });
  assert.equal((await app.message(message)).ok, true);
  assert.deepEqual(app.storage.account, account("bob", 29, 1));
  assert.deepEqual(app.storage.stats, { checked: 1, ads: 0 });
  assert.equal(app.calls.filter(call => call.url.endsWith("/classify")).length, 2);
});

test("an in-progress request is retried at most twice; other errors are never auto-retried", async () => {
  const pending = harness(session(), () => response({ ok: false, code: "in_progress", error: "Please retry shortly" }, 409));
  assert.equal((await pending.message({ type: "classify", state: { text: "a post that is currently being processed" } })).code, "in_progress");
  assert.equal(pending.calls.length, 3);
  const failed = harness(session(), () => response({ ok: false, code: "upstream", error: "Upstream failure" }, 503));
  assert.equal((await failed.message({ type: "classify", state: { text: "a post that fails" } })).code, "upstream");
  assert.equal(failed.calls.length, 1);
});

test("an earlier account response cannot overwrite a more recent refresh result", async () => {
  let release;
  const app = harness(session(), ({ url }) => {
    if (url.endsWith("/classify")) return new Promise(resolve => { release = () => resolve(response(serverResult(account("alice", 9, 1)))); });
    return response({ ok: true, account: account("alice", 50, 1) });
  });
  const old = app.message({ type: "classify", state: { text: "out-of-order responses" } });
  await waitFor(() => release);
  await app.message({ type: "getAccount" });
  release();
  assert.equal((await old).ok, true);
  assert.deepEqual(app.storage.account, account("alice", 50, 1));
});

test("logging out cancels a verification-code login that has not finished yet", async () => {
  let release;
  const app = harness({ dataConsent: true }, () => new Promise(resolve => { release = () => resolve(response({ ok: true, token: "cancelled-token", expiresAt: Date.now() + 60_000, account: account() })); }));
  const old = app.message({ type: "login", email: "alice@example.com", code: "123456" });
  await tick();
  await app.message({ type: "logout" });
  release();
  assert.equal((await old).code, "session_changed");
  assert.equal(app.storage.auth, null);
});

test("a disabled account clears its session, and each account's successful requests are counted separately", async () => {
  const disabled = harness(session(), () => response({ ok: false, code: "account_disabled", error: "Account disabled" }, 403));
  assert.equal((await disabled.message({ type: "getAccount" })).code, "account_disabled");
  assert.equal(disabled.storage.auth, null);
  const app = harness(session(), ({ url, init }) => {
    if (url.endsWith("/verify-code")) return response({ ok: true, token: "bob-token", expiresAt: Date.now() + 60_000, account: account("bob", 30) });
    return response(serverResult(init.headers.Authorization === "Bearer alice-token" ? account("alice", 9, 1) : account("bob", 29, 1)));
  });
  const message = { type: "classify", state: { text: "a local result must not be reused across accounts" } };
  assert.equal((await app.message(message)).ok, true);
  assert.equal((await app.message(message)).ok, true);
  await app.message({ type: "login", email: "bob@example.com", code: "123456" });
  assert.equal((await app.message(message)).ok, true);
  assert.equal(app.calls.filter(call => call.url.endsWith("/classify")).length, 2);
  assert.deepEqual(app.storage.stats, { checked: 1, ads: 0 });
});

test("switching accounts cancels requests still waiting in the queue", async () => {
  const releases = [];
  const app = harness(session(), ({ url }) => {
    if (url.endsWith("/verify-code")) return response({ ok: true, token: "bob-token", expiresAt: Date.now() + 60_000, account: account("bob", 30) });
    return new Promise(resolve => { releases.push(() => resolve(response(serverResult()))); });
  });
  const results = Array.from({ length: 6 }, (_, index) => app.message({ type: "classify", state: { text: `queued post ${index}` } }));
  await waitFor(() => releases.length === 4);
  assert.equal(releases.length, 4);
  await app.message({ type: "login", email: "bob@example.com", code: "123456" });
  releases.forEach(release => release());
  assert.ok((await Promise.all(results)).every(result => result.code === "session_changed"));
  assert.equal(app.calls.filter(call => call.url.endsWith("/classify")).length, 4);
  assert.deepEqual(app.storage.stats, { checked: 0, ads: 0 });
});

test("queued requests that have not been sent yet stop hitting the server once credits run out", async () => {
  const app = harness(session(), () => response({ ok: false, code: "quota", error: "Out of detection credits" }, 402));
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => app.message({ type: "classify", state: { text: `quota-stopped queue item ${index}` } })));
  assert.ok(results.every(result => result.code === "quota"));
  assert.ok(app.calls.length <= 4);
});

test("check-in status is read-only; only an explicit claim from the popup sends a POST, and the balance stays in sync", async () => {
  let claimed = false;
  const app = harness(session(), ({ url, init, body }) => {
    assert.equal(url, API_BASE + "/v1/check-in");
    assert.equal(init.headers.Authorization, "Bearer alice-token");
    if (init.method === "POST") {
      assert.deepEqual(body, {});
      claimed = true;
    } else {
      assert.equal(init.method, "GET");
      assert.equal(body, undefined);
    }
    return response({ ok: true, account: account("alice", claimed ? 110 : 10), checkIn: { date: "2026-09-22", claimed, amount: 100, nextAvailableAt: 1790092800000, timeZone: "Asia/Shanghai" } });
  });
  assert.equal((await app.message({ type: "getCheckIn" })).checkIn.claimed, false);
  assert.equal((await app.message({ type: "getCheckIn" })).account.credits, 10);
  assert.ok(app.calls.every(call => call.init.method === "GET"));
  assert.equal((await app.message({ type: "claimCheckIn" })).checkIn.claimed, true);
  assert.equal(app.storage.account.credits, 110);
  assert.equal((await app.message({ type: "getCheckIn" })).checkIn.claimed, true);
  assert.equal(app.calls.filter(call => call.init.method === "POST").length, 1);
  for (const type of ["getCheckIn", "claimCheckIn"]) {
    assert.equal((await app.message({ type }, "https://x.com/home")).code, "forbidden");
  }
  assert.equal(app.calls.length, 4);
  const loggedOut = harness();
  assert.equal((await loggedOut.message({ type: "claimCheckIn" })).code, "auth_required");
  assert.equal(loggedOut.calls.length, 0);
});

test("a failed check-in never inflates the balance, and switching accounts discards a stale check-in result", async () => {
  const offline = harness(session(), () => { throw Error("network offline"); });
  assert.equal((await offline.message({ type: "claimCheckIn" })).code, "network");
  assert.equal(offline.storage.account.credits, 10);
  assert.equal(offline.calls.length, 1);
  let release;
  const app = harness(session(), () => new Promise(resolve => { release = () => resolve(response({ ok: true, account: account("alice", 110), checkIn: { claimed: true } })); }));
  const old = app.message({ type: "claimCheckIn" });
  await tick();
  await app.set(session("bob", 30));
  release();
  assert.equal((await old).code, "session_changed");
  assert.deepEqual(app.storage.account, account("bob", 30));
});

// 旧账户没有授权记录时也必须阻止上传；只有插件弹窗能保存明确同意。
test("classification requires explicit consent even for an existing session", async () => {
  const initial = session();
  delete initial.dataConsent;
  const app = harness(initial);
  assert.equal((await app.message({ type: "getSettings" })).dataConsent, false);
  assert.equal((await app.message({ type: "classify", state: { text: "private test" } })).code, "consent_required");
  assert.equal(app.calls.length, 0);
  assert.equal((await app.message({ type: "setDataConsent", consent: true }, "https://x.com/home", 7)).code, "forbidden");
  assert.equal((await app.message({ type: "setDataConsent", consent: true })).ok, true);
  assert.equal((await app.message({ type: "setDataConsent", consent: "true" })).code, "invalid_consent");
  assert.equal((await app.message({ type: "getSettings" })).dataConsent, true);
  assert.equal((await app.message({ type: "classify", state: { text: "test post" } })).ok, true);
  assert.equal(app.calls.length, 1);
  assert.equal((await app.message({ type: "setDataConsent", consent: false })).ok, true);
  assert.equal((await app.message({ type: "classify", state: { text: "after withdrawal" } })).code, "consent_required");
  assert.equal(app.calls.length, 1);
});

test("recent login email survives logout and failed attempts, and updates after successful login", async () => {
  const app = harness({ dataConsent: true }, ({ url, body }) => {
    if (url.endsWith("/logout")) return response({ ok: true });
    if (body.code === "000000") return response({ ok: false, code: "invalid_code" }, 400);
    return response({ ok: true, token: "test-session", expiresAt: Date.now() + 60_000, account: account(body.email.split("@")[0]) });
  });
  assert.equal((await app.message({ type: "login", email: "alice@example.com", code: "123456" })).ok, true);
  assert.equal(app.storage.lastLoginEmail, "alice@example.com");
  await app.message({ type: "logout" });
  assert.equal(app.storage.auth, null);
  assert.equal(app.storage.lastLoginEmail, "alice@example.com");
  await app.message({ type: "login", email: "bob@example.com", code: "000000" });
  assert.equal(app.storage.lastLoginEmail, "alice@example.com");
  await app.message({ type: "login", email: "bob@example.com", code: "123456" });
  assert.equal(app.storage.lastLoginEmail, "bob@example.com");
  assert.doesNotMatch(JSON.stringify(await app.message({ type: "getSettings" }, "https://x.com/home")), /lastLoginEmail|bob@example/);
});

test("Google sign-in exchanges a PKCE ticket, saves the recent email, and preserves data consent", async () => {
  let challenge;
  const app = harness({ dataConsent: true }, ({ url, body }) => {
    if (url.endsWith("/status")) return response({ ok: true, available: true });
    assert.ok(url.endsWith("/exchange"));
    assert.equal(body.ticket, "a".repeat(64));
    assert.equal(require("node:crypto").createHash("sha256").update(body.verifier).digest("base64url"), challenge);
    return response({ ok: true, token: "google-session", expiresAt: Date.now() + 60_000, account: account() });
  }, undefined, { async launchWebAuthFlow({ url, interactive }) {
    assert.equal(interactive, true);
    const target = new URL(url);
    assert.equal(target.origin, new URL(API_BASE).origin);
    challenge = target.searchParams.get("challenge");
    return target.searchParams.get("redirect_uri") + "?ticket=" + "a".repeat(64);
  } });
  assert.equal((await app.message({ type: "loginWithGoogle" }, "https://x.com/home")).code, "forbidden");
  assert.equal((await app.message({ type: "loginWithGoogle" })).ok, true);
  assert.equal(app.storage.auth.token, "google-session");
  assert.equal(app.storage.lastLoginEmail, "alice@example.com");
  assert.equal(app.storage.dataConsent, true);
});
test("Google cancellation and unavailable configuration leave the existing session unchanged", async () => {
  const app = harness(session(), () => response({ ok: true, available: true }), undefined, { async launchWebAuthFlow() { throw Error("closed"); } });
  assert.equal((await app.message({ type: "loginWithGoogle" })).code, "google_cancelled");
  assert.equal(app.storage.auth.token, "alice-token");
  assert.equal(app.calls.length, 1);
  const unavailable = harness({ dataConsent: true }, () => response({ ok: true, available: false }));
  assert.equal((await unavailable.message({ type: "loginWithGoogle" })).code, "google_unavailable");
  assert.equal(unavailable.storage.auth, undefined);
  const notDeployed = harness({ dataConsent: true }, () => response({}, 404));
  assert.equal((await notDeployed.message({ type: "loginWithGoogle" })).code, "google_unavailable");
  assert.equal(notDeployed.storage.auth, undefined);
  assert.equal(notDeployed.calls.length, 1);
});
test("logout while Google sign-in is open prevents the returned session from being saved", async () => {
  let complete;
  const app = harness({ dataConsent: true }, ({ url }) => response(url.endsWith("/status") ? { ok: true, available: true } : { ok: true, token: "stale", expiresAt: Date.now() + 60_000, account: account() }), undefined, { launchWebAuthFlow() { return new Promise(resolve => { complete = resolve; }); } });
  const pending = app.message({ type: "loginWithGoogle" });
  while (!complete) await tick();
  assert.equal((await app.message({ type: "loginWithGoogle" })).code, "google_pending");
  await app.message({ type: "logout" });
  complete("https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/google?ticket=" + "a".repeat(64));
  assert.equal((await pending).code, "session_changed");
  assert.equal(app.storage.auth, null);
});

test("Google auth resizes only matching popups and removes its listener on cancellation", async () => {
  let cancel;
  const app = harness({ dataConsent: true }, () => response({ ok: true, available: true }), undefined, { launchWebAuthFlow() { return new Promise((resolve, reject) => { cancel = reject; }); } });
  const pending = app.message({ type: "loginWithGoogle" });
  while (!cancel) await tick();
  const win = { id: 9, type: "popup", left: 100, top: 100, width: 800, height: 600, tabs: [{ url: "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=" + encodeURIComponent(new URL("/auth/google/callback", API_BASE).href) }] };
  await app.createWindow({ ...win, type: "normal" });
  await app.createWindow({ ...win, tabs: [{ url: "https://accounts.google.com/?redirect_uri=https://other.example/callback" }] });
  await app.createWindow({ ...win, tabs: [{}] });
  assert.equal(app.windowUpdates.length, 0);
  await app.createWindow(win);
  assert.deepEqual(app.windowUpdates, [{ id: 9, width: 520, height: 680, left: 240, top: 60 }]);
  cancel(new Error("closed"));
  assert.equal((await pending).code, "google_cancelled");
  assert.equal(app.windowListeners.size, 0);
});

test("email and Google authentication require saved consent", async () => {
  for (const dataConsent of [undefined, false]) {
    const app = harness({ dataConsent });
    for (const type of ["requestCode", "login", "loginWithGoogle"]) {
      assert.equal((await app.message({ type, email: "test@example.com", code: "123456" })).code, "consent_required");
    }
    assert.equal(app.calls.length, 0);
  }
});

test("persistent cache survives worker restart, keeps current balance, and expires", async () => {
  const message = { type: "classify", state: { text: "persistent cache post" } };
  const first = harness(session());
  assert.equal((await first.message(message)).ok, true);
  const restored = harness({ ...first.storage, account: account("alice", 0, 10), stats: { checked: 0, ads: 0 } });
  assert.equal((await restored.message(message)).ok, true);
  assert.equal(restored.calls.length, 0);
  assert.equal(restored.storage.account.credits, 0);
  assert.equal(restored.storage.stats.checked, 0);
  const persisted = JSON.stringify(restored.storage.classificationCache);
  assert.ok(!persisted.includes("persistent cache post"));
  assert.ok(!persisted.includes("alice-token"));
  Object.values(restored.storage.classificationCache)[0].expiresAt = Date.now() - 1;
  await restored.set({ account: account("alice", 10) });
  assert.equal((await restored.message(message)).ok, true);
  assert.equal(restored.calls.length, 1);
});

test("cache keys include input and AI/topics but ignore presentation and object field order", async () => {
  const app = harness(session());
  const text = "A complete sentence about a product and its features. ".repeat(4);
  const message = { type: "classify", state: { text, author: "alice" }, topics: ["AI", "tools"] };
  await app.message(message);
  await app.set({ mode: "fold", threshold: 0.1 });
  await app.message({ ...message, state: { author: "alice", text }, topics: ["tools", "AI"] });
  assert.equal(app.calls.length, 1);
  await app.message({ ...message, state: { text, author: "bob" } });
  await app.message({ ...message, topics: ["AI"] });
  await app.set({ aiDetect: false });
  await app.message(message);
  assert.equal(app.calls.length, 4);
});

test("failed requests are not cached and cache remains bounded", async () => {
  let fail = true;
  const app = harness(session(), () => fail ? response({ code: "upstream", error: "failed" }, 503) : response(serverResult()));
  const message = { type: "classify", state: { text: "retry only when explicitly requested" } };
  assert.equal((await app.message(message)).ok, false);
  assert.equal(app.storage.classificationCache, undefined);
  fail = false;
  app.storage.classificationCache = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [String(i), { expiresAt: Date.now() + 100000, value: {} }]));
  assert.equal((await app.message(message)).ok, true);
  assert.equal(app.calls.length, 2);
  assert.equal(Object.keys(app.storage.classificationCache).length, 500);
  assert.equal(app.storage.classificationCache['0'], undefined);
});
