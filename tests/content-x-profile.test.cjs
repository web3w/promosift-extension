const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
const signedIn = { authenticated: true, dataConsent: true, mode: "label", keywords: [], quotaExhausted: true };

function page(initialProfile, initialSettings = signedIn) {
  let profile = initialProfile;
  let listener;
  let now = 1_000;
  const messages = [];
  const observers = [];
  const timers = [];
  const menu = { querySelector: selector => selector === '[data-testid^="UserAvatar-Container-"]' ? {
    getAttribute: () => `UserAvatar-Container-${profile.handle}`,
    querySelector: selector => selector === "img[alt]" ? { getAttribute: () => profile.name } : null
  } : null };
  class Observer {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() {}
  }
  const runtime = {
    id: "test", lastError: null,
    sendMessage(message, callback) { messages.push({ ...message, callback }); },
    onMessage: { addListener(fn) { listener = fn; } }
  };
  const document = {
    body: {}, documentElement: { dataset: {} }, readyState: "complete", cookie: "guest_id=v1; twid=u%3D1234567890123456789; lang=en",
    querySelectorAll(selector) {
      return selector === '[data-testid="SideNav_AccountSwitcher_Button"]' && profile ? [menu] : [];
    }
  };
  vm.runInNewContext(source, {
    location: { hostname: "x.com", href: "https://x.com/someone_else/status/123" },
    chrome: { runtime, i18n: { getMessage: key => key } }, document, window: {},
    Date: class extends Date { static now() { return now; } },
    MutationObserver: Observer, IntersectionObserver: Observer,
    getComputedStyle: () => ({ backgroundColor: "rgb(0, 0, 0)" }),
    addEventListener() {}, removeEventListener() {},
    setTimeout: fn => timers.push(fn), clearTimeout() {}
  });
  const flush = () => { while (timers.length) timers.shift()(); };
  const mutate = () => { observers[1].callback(); flush(); };
  messages.find(message => message.type === "getSettings").callback(initialSettings);
  flush();
  return {
    reports: () => messages.filter(message => message.type === "reportXProfile"),
    mutate,
    switchX(next) { profile = next; mutate(); },
    settings(next) { listener({ type: "settingsChanged", settings: next }); flush(); },
    advance(ms) { now += ms; mutate(); }
  };
}

test("读取 twid 数字 ID 与当前账号菜单的 handle 和显示名称，零额度也上报且重复 DOM 更新不重发", () => {
  const p = page({ handle: "promosift", name: "PromoSift" });
  assert.deepEqual(JSON.parse(JSON.stringify(p.reports()[0].profile)), { x_user_id: "1234567890123456789", x_user_handle: "promosift", x_user_name: "PromoSift" });
  p.mutate();
  assert.equal(p.reports().length, 1);
  p.reports()[0].callback({ ok: true });
  p.mutate();
  assert.equal(p.reports().length, 1);
});

test("X 未登录、名称缺失、账号格式错误、PromoSift 未登录或未同意均跳过", () => {
  for (const profile of [null, { handle: "promosift", name: "" }, { handle: "bad/handle", name: "Other" }]) {
    assert.equal(page(profile).reports().length, 0);
  }
  for (const settings of [{ ...signedIn, authenticated: false }, { ...signedIn, dataConsent: false }]) {
    assert.equal(page({ handle: "promosift", name: "PromoSift" }, settings).reports().length, 0);
  }
});

test("账号菜单稍后出现时采集，登出后跳过，再登录重新采集", () => {
  const p = page(null);
  p.switchX({ handle: "promosift", name: "PromoSift" });
  p.reports()[0].callback({ ok: true });
  p.switchX(null);
  assert.equal(p.reports().length, 1);
  p.switchX({ handle: "promosift", name: "PromoSift" });
  assert.equal(p.reports().length, 2);
});

test("上报途中切换 X 账号或修改名称，按顺序提交最新页面值", () => {
  const p = page({ handle: "first", name: "First" });
  p.switchX({ handle: "second", name: "Second" });
  assert.equal(p.reports().length, 1);
  p.reports()[0].callback({ ok: true });
  assert.equal(p.reports()[1].profile.x_user_handle, "second");
  p.reports()[1].callback({ ok: true });
  p.switchX({ handle: "second", name: "Renamed" });
  assert.equal(p.reports()[2].profile.x_user_name, "Renamed");
});

test("切换 PromoSift 会话后同一 X 账号仍会上报，旧回调不会阻止新会话", () => {
  const p = page({ handle: "promosift", name: "PromoSift" });
  p.settings({ ...signedIn, authenticated: false });
  p.settings(signedIn);
  p.reports()[0].callback({ ok: false, code: "session_changed" });
  assert.equal(p.reports().length, 2);
});

test("上报失败后 DOM 变更不会密集重试，下一分钟可以再次上报", () => {
  const p = page({ handle: "promosift", name: "PromoSift" });
  p.reports()[0].callback({ ok: false });
  p.mutate();
  assert.equal(p.reports().length, 1);
  p.advance(60_000);
  assert.equal(p.reports().length, 2);
});
