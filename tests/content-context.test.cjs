const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

function loadContent() {
  let listener;
  let pendingMessage;
  let stopped = 0;
  let removed = 0;
  let i18nError = null;
  const observers = [];
  const timers = [];
  const runtime = {
    id: "promosift-test",
    sendMessage(_message, callback) { pendingMessage = callback; },
    onMessage: { addListener(callback) { listener = callback; } }
  };
  const document = {
    body: {},
    documentElement: { appendChild() {} },
    querySelectorAll() { return []; },
    createElement() { return { dataset: {} }; }
  };
  class Observer {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() { stopped++; }
  }
  const chrome = {
    runtime,
    i18n: { getMessage() { if (i18nError) throw i18nError; return "Translated"; } }
  };
  vm.runInNewContext(source, {
    location: { hostname: "x.com" }, chrome, document, window: {},
    MutationObserver: Observer, IntersectionObserver: Observer,
    addEventListener() {}, removeEventListener() { removed++; }, setTimeout(callback) { timers.push(callback); }
  }, { filename: "content.js" });
  return { runtime, pendingMessage, message: (value) => listener(value), setI18nError: (error) => { i18nError = error; }, stopped: () => stopped,
    removed: () => removed, mutate: () => observers[1].callback(), flushTimers: () => { while (timers.length) timers.shift()(); } };
}

test("旧页面在插件上下文失效后停止监听，不再抛出 i18n 异常", () => {
  const page = loadContent();
  page.runtime.id = undefined;
  assert.doesNotThrow(() => page.message({ type: "showToast", error: "test" }));
  assert.equal(page.stopped(), 3);
  assert.equal(page.removed(), 5);
  assert.doesNotThrow(() => page.pendingMessage({ authenticated: true }));
});

test("i18n 在重载时抛出上下文失效异常也会停用旧脚本", () => {
  const page = loadContent();
  page.setI18nError(new Error("Extension context invalidated."));
  assert.doesNotThrow(() => page.message({ type: "showToast", error: "test" }));
  assert.equal(page.stopped(), 3);
});

test("旧页面的延迟扫描在插件上下文失效后退出", () => {
  const page = loadContent();
  page.mutate();
  page.runtime.id = undefined;
  assert.doesNotThrow(() => page.flushTimers());
  assert.equal(page.stopped(), 3);
});
