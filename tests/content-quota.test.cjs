const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
const accountSettings = { mode: "label", keywords: [], smartMatch: true, authenticated: true, dataConsent: true, keySource: "server" };
const success = { ok: true, result: { isAd: false, prob: 0, kind: "organic", kindProbs: { organic: 1 } } };

// 通过真实消息和 observer 入口驱动内容脚本；只模拟本测试所需的 X DOM。
function loadPage(exhausted = false) {
  const elements = [];
  const articles = [];
  const messages = [];
  const handlers = new Map();
  const observers = [];
  const idleTasks = [];
  const timers = [];
  let listener;
  class Element {
    constructor(tag = "span") {
      this.tag = tag;
      this.dataset = {};
      this.attributes = {};
      this.listeners = {};
      this.textContent = "";
      this.children = [];
      this.isConnected = true;
      const classes = new Set();
      this.classList = {
        add: (...values) => values.forEach(value => classes.add(value)),
        remove: (...values) => values.forEach(value => classes.delete(value)),
        contains: value => classes.has(value),
        toggle: (value, on) => on ? classes.add(value) : classes.delete(value)
      };
      this.style = { setProperty() {} };
      elements.push(this);
    }
    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return this.attributes[key]; }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    appendChild(child) { this.children.push(child); return child; }
    append(child) { this.appendChild(child); }
    after(child) { this.inserted = child; }
    remove() { this.isConnected = false; }
    closest(selector) {
      if (selector === "article") return this.articleParent || (this.tag === "article" ? this : null);
      if (selector === 'div[role="link"]') return this.quoted ? this : null;
      return selector === ".jev-badge" && this.className === "jev-badge" ? this : null;
    }
    querySelectorAll(selector) {
      if (selector === "time[datetime]") return this.times || [];
      if (selector.startsWith('a[href*="/status/"]')) return (this.metrics || []).filter(node =>
        (node.tag === "a" && (node.getAttribute("href") || "").includes("/status/") && node.getAttribute("href").includes("/analytics")) ||
        /^(View count|View post analytics)$/i.test(node.getAttribute("aria-label") || ""));
      return [];
    }
    querySelector(selector) {
      if (this.tag !== "article") return null;
      if (selector === "a:has(> time)") return this.anchor;
      if (selector.includes("tweetText")) return this.body;
      return null;
    }
    getBoundingClientRect() { return { top: 10, bottom: 100, height: 90, left: 10, width: 60 }; }
  }
  class Observer {
    constructor(callback) { this.callback = callback; this.observed = new Set(); observers.push(this); }
    observe(el) { this.observed.add(el); }
    unobserve(el) { this.observed.delete(el); }
    disconnect() { this.observed.clear(); }
  }
  const document = {
    body: new Element("body"), documentElement: new Element("html"), readyState: "complete",
    createElement: tag => new Element(tag),
    querySelectorAll(selector) {
      if (selector === 'article[data-testid="tweet"]') return articles;
      if (selector.startsWith("article")) return [];
      if (selector.includes(".jev-badge")) return elements.filter(el => el.isConnected && el.className === "jev-badge" && (!selector.includes('data-state="loading"') || el.dataset.state === "loading"));
      return [];
    }
  };
  const runtime = {
    id: "test", lastError: null,
    sendMessage(message, callback) { messages.push({ ...message, callback }); },
    onMessage: { addListener(callback) { listener = callback; } }
  };
  vm.runInNewContext(source, {
    location: { hostname: "x.com", href: "https://x.com/home" },
    chrome: { runtime, i18n: { getMessage: key => ({ badgeNoCredits: "No credits", badgeNoCreditsHint: "Out of credits. Open PromoSift to get more." }[key] || key) } },
    Element, document, window: { requestIdleCallback: true },
    IntersectionObserver: Observer, MutationObserver: Observer,
    requestIdleCallback: callback => idleTasks.push(callback),
    setTimeout: callback => timers.push(callback), clearTimeout() {},
    addEventListener: (type, callback) => handlers.set(type, [...(handlers.get(type) || []), callback]),
    removeEventListener() {}, getComputedStyle: () => ({ backgroundColor: "rgb(0, 0, 0)" }),
    innerHeight: 800, innerWidth: 1200, matchMedia: () => ({ matches: true })
  });
  const flush = () => { while (idleTasks.length) idleTasks.shift()(); };
  const addArticle = text => {
    const article = new Element("article");
    article.body = new Element("body"); article.body.textContent = text;
    article.anchor = new Element("a"); article.anchor.setAttribute("href", `/author/status/${articles.length + 1}`);
    articles.push(article);
    return article;
  };
  const addTime = (article, datetime, { quoted = false, nested = false } = {}) => {
    const time = new Element("time");
    time.setAttribute("datetime", datetime);
    time.articleParent = nested ? new Element("article") : article;
    time.quoted = quoted;
    (article.times ||= []).push(time);
  };
  const addMetric = (article, { href, label, text = "", tag = "a", quoted = false, nested = false }) => {
    const node = new Element(tag);
    if (href) node.setAttribute("href", href);
    if (label) node.setAttribute("aria-label", label);
    node.textContent = text;
    node.articleParent = nested ? new Element("article") : article;
    node.quoted = quoted;
    (article.metrics ||= []).push(node);
  };
  const start = () => { messages.find(m => m.type === "getSettings").callback({ ...accountSettings, quotaExhausted: exhausted }); flush(); };
  const intersect = (...posts) => { observers[0].callback(posts.map(target => ({ target, isIntersecting: true }))); flush(); };
  const mutate = () => { observers[1].callback(); while (timers.length) timers.shift()(); flush(); };
  const badges = () => document.querySelectorAll(".jev-badge");
  return { messages, elements, addArticle, addTime, addMetric, start, intersect, mutate, badges,
    message: message => listener(message),
    observed: () => observers[0].observed,
    activate(badge, type = "click", key) {
      const event = { type, key, target: badge, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
      for (const callback of handlers.get(type) || []) callback(event);
      return event;
    }
  };
}

test("初始余额为零时仅一条轻标记，点击和键盘打开侧栏", () => {
  const page = loadPage(true);
  const first = page.addArticle("first post");
  const second = page.addArticle("second post");
  page.start(); page.intersect(first, second);
  assert.equal(page.messages.filter(m => m.type === "classify").length, 0);
  assert.equal(page.badges().length, 1);
  const badge = page.badges()[0];
  assert.equal(badge.dataset.state, "quota");
  assert.equal(badge.textContent, "No credits");
  for (const [type, key] of [["click"], ["keydown", "Enter"], ["keydown", " "]]) {
    const event = page.activate(badge, type, key);
    assert.equal(event.prevented, true); assert.equal(event.stopped, true);
  }
  assert.equal(page.messages.filter(m => m.type === "openSidePanel").length, 3);
  assert.equal(first.classList.contains("jev-reveal"), false);
  badge.listeners.mouseenter();
  const tooltip = page.elements.find(el => el.className === "jev-tip");
  assert.match(tooltip.innerHTML, /Out of credits/);
  assert.doesNotMatch(tooltip.innerHTML, /tipUnknownError|jev-tip-err|%/);
  badge.remove(); page.mutate(); page.intersect(second);
  assert.equal(page.badges().length, 0, "节点回收后本页面不重复提醒");
});

test("多个额度失败仅显示一个标记且不创建 toast", () => {
  const page = loadPage();
  const first = page.addArticle("first post"); const second = page.addArticle("second post");
  page.start(); page.intersect(first, second);
  for (const request of page.messages.filter(m => m.type === "classify")) request.callback({ ok: false, code: "quota" });
  assert.equal(page.badges().length, 1);
  assert.equal(page.badges()[0].dataset.state, "quota");
  assert.equal(page.elements.some(el => el.className === "jev-toast"), false);
});

test("耗尽广播保留在途成功结果，恢复只重试未检测帖子", () => {
  const page = loadPage();
  const checked = page.addArticle("already checked post");
  const pending = page.addArticle("pending successful post");
  const failed = page.addArticle("failed for quota post");
  const skipped = page.addArticle("skipped while empty post");
  page.start(); page.intersect(checked);
  page.messages.find(m => m.type === "classify").callback(success);
  checked.classList.add("jev-fold");
  const oldBadge = checked.__jevBadge;
  page.intersect(pending, failed);
  const requests = page.messages.filter(m => m.type === "classify");
  page.message({ type: "quotaChanged", exhausted: true }); page.mutate();
  requests[1].callback(success);
  requests[2].callback({ ok: false, code: "quota" });
  page.intersect(skipped);
  assert.equal(pending.__jevBadge?.dataset.state, "ok");
  page.message({ type: "quotaChanged", exhausted: false });
  assert.equal(page.badges().some(b => b.dataset.state === "quota"), false);
  assert.equal(checked.__jevBadge, oldBadge);
  assert.equal(checked.classList.contains("jev-fold"), true);
  assert.ok(page.observed().has(failed)); assert.ok(page.observed().has(skipped));
  page.intersect(checked, pending, failed, skipped);
  assert.equal(page.messages.filter(m => m.type === "classify").length, 5);
});

test("相同的公开设置仍重置缓存，防止切换账号后复用上一账号结果", () => {
  const page = loadPage(); const checked = page.addArticle("already checked post");
  page.start(); page.intersect(checked);
  page.messages.find(m => m.type === "classify").callback(success);
  page.message({ type: "settingsChanged", settings: { ...accountSettings, quotaExhausted: false } });
  page.intersect(checked);
  assert.equal(page.messages.filter(m => m.type === "classify").length, 2);
});

test("发布时间仅采集本帖 time，跳过引用卡片和嵌套引用帖", () => {
  const page = loadPage();
  const post = page.addArticle("post with publication time");
  page.addTime(post, "2020-01-01T00:00:00Z", { quoted: true });
  page.addTime(post, "2021-01-01T00:00:00Z", { nested: true });
  page.addTime(post, "2026-09-26T12:00:00+08:00");
  page.start(); page.intersect(post);
  const request = page.messages.find(message => message.type === "classify");
  assert.equal(request.meta.publishedAt, "2026-09-26T12:00:00+08:00");
  assert.equal(request.state.publishedAt, undefined, "发布时间不进入分类内容");
});

test("没有本帖时间时不使用引用时间或当前时间补齐", () => {
  for (const reference of [null, { quoted: true }, { nested: true }]) {
    const page = loadPage(); const post = page.addArticle("post without its own timestamp");
    if (reference) page.addTime(post, "2020-01-01T00:00:00Z", reference);
    page.start(); page.intersect(post);
    const request = page.messages.find(message => message.type === "classify");
    assert.equal(request.meta?.publishedAt, undefined);
  }
});

test("本帖 analytics 的中文和英文精确浏览量优先进入 meta", () => {
  const cases = [
    ["15127 次查看。查看帖子分析", "1.5万", 15127],
    ["2077974 次查看。查看帖子分析", "207万", 2077974],
    ["70499 次查看。查看帖子分析", "7万", 70499],
    ["63 次查看。查看帖子分析", "63", 63],
    ["15,127 views. View post analytics", "15K", 15127],
    ["1 view. View post analytics", "1", 1],
    ["23 次观看。查看帖子分析", "20", 23],
    ["23 次浏览。查看帖子分析", "20", 23],
    ["0 次查看。查看帖子分析", "", 0]
  ];
  for (const [label, text, expected] of cases) {
    const page = loadPage(); const post = page.addArticle("post with real X analytics markup");
    page.addMetric(post, { label: "View count", text });
    page.addMetric(post, { href: "/ruruiei2w0/status/2103455528399900672/analytics", label, text });
    page.start(); page.intersect(post);
    const request = page.messages.find(message => message.type === "classify");
    assert.equal(request.meta.counts.views, expected, label);
    assert.equal(request.state.views, undefined, "浏览量仍仅作为元数据上传");
  }
});

test("没有精确 aria 浏览数时回退英文或中文缩写，不能把小数首位当成精确值", () => {
  const cases = [["1.5K", 1500], ["2.5M", 2500000], ["1.2B", 1200000000], ["1.5万", 15000], ["1.2亿", 120000000], ["0", 0]];
  for (const [text, expected] of cases) {
    const page = loadPage(); const post = page.addArticle("post with abbreviated views");
    page.addMetric(post, { href: "/author/status/123/analytics?source=post", label: `${text} views. View post analytics`, text });
    page.start(); page.intersect(post);
    assert.equal(page.messages.find(message => message.type === "classify").meta.counts.views, expected, text);
  }
  const page = loadPage(); const post = page.addArticle("legacy exact English label");
  page.addMetric(post, { label: "View post analytics", text: "3.3K" });
  page.start(); page.intersect(post);
  assert.equal(page.messages.find(message => message.type === "classify").meta.counts.views, 3300);
});

test("浏览量不读取引用卡片、嵌套帖子、时间或收藏，缺失不伪造零", () => {
  for (const own of [null, { label: "View post analytics", text: "" }, { label: "42 views. View post analytics", text: "40" }]) {
    const page = loadPage(); const post = page.addArticle("post with unrelated numeric metadata");
    const href = "/author/status/123/analytics";
    page.addMetric(post, { href, label: "999 次查看。查看帖子分析", text: "999", quoted: true });
    page.addMetric(post, { href, label: "888 views. View post analytics", text: "888", nested: true });
    page.addMetric(post, { tag: "button", label: "27 Bookmarks. Bookmark", text: "27" });
    page.addMetric(post, { href: "/author/status/123", label: "2026-09-26", text: "2026" });
    page.addTime(post, "2026-09-26T04:00:00Z");
    if (own) page.addMetric(post, { href, ...own });
    page.start(); page.intersect(post);
    const request = page.messages.find(message => message.type === "classify");
    assert.equal(request.meta.counts?.views, own?.text ? 42 : undefined);
    assert.equal(request.meta.publishedAt, "2026-09-26T04:00:00Z");
  }
});
