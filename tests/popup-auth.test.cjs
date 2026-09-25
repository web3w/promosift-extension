const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const popup = readFileSync(path.join(root, 'popup.js'), 'utf8');
const flow = popup.split('// ---------- Sign-in flow ----------')[1].split('// ---------- Logout ----------')[0];
const messages = JSON.parse(readFileSync(path.join(root, '_locales/en/messages.json'), 'utf8'));

function page(send) {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, {
        value: '', textContent: '', disabled: false, hidden: false, dataset: {},
        classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
        listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; },
        setAttribute(name, value) { this[name] = value; }, focus() {}
      });
    }
    return elements.get(id);
  };
  const document = { body: { dataset: { loginState: 'idle' } } };
  const context = vm.createContext({
    document, $: element, send, currentSettings: { dataConsent: true }, googleBusy: false,
    t: (key, value) => messages[key].message.replace('$SECONDS$', value),
    message: (target, value = '', tone = '') => { target.textContent = value; target.dataset.tone = tone; target.hidden = !value; },
    fmt: String, syncAccount: async () => {},
    Date: { now: () => now },
    setInterval: (fn) => { timers.set(++nextTimer, fn); return nextTimer; },
    clearInterval: (id) => timers.delete(id)
  });
  element("acceptDataConsent").checked = true;
  vm.runInContext(flow, context);
  return {
    element, document,
    emit: (id, type) => element(id).listeners[type]({ preventDefault() {} }),
    advance(ms) { now += ms; for (const fn of [...timers.values()]) fn(); }
  };
}

test('过期后禁止提交旧码，允许重发，成功重发清空旧码并重新计时', async () => {
  const calls = [];
  const p = page(async (request) => { calls.push(request); return { ok: true, retryAfter: 60 }; });
  p.element('email').value = 'alice@example.com';
  await p.emit('requestCodeForm', 'submit');
  assert.equal(p.document.body.dataset.loginState, 'sent');
  assert.equal(p.element('resendCode').disabled, true);
  p.element('loginCode').value = '123456';
  p.advance(60_000);
  assert.equal(p.element('resendCode').disabled, false);
  p.advance(540_000);
  assert.equal(p.document.body.dataset.loginState, 'expired');
  assert.equal(p.element('loginCode').disabled, true);
  assert.equal(p.element('loginCode').value, '');
  assert.equal(p.element('loginStepCodeNote').textContent, messages.loginCodeExpired.message);
  await p.emit('loginForm', 'submit');
  assert.equal(calls.length, 1);
  await p.emit('resendCode', 'click');
  assert.deepEqual(calls.map((call) => call.type), ['requestCode', 'requestCode']);
  assert.equal(p.document.body.dataset.loginState, 'sent');
  assert.equal(p.element('loginCode').disabled, false);
  assert.equal(p.element('resendCode').disabled, true);
});

test('校验失败不重置重发冷却；重发请求未完成时不重复提交', async () => {
  let finishResend;
  const calls = [];
  const p = page((request) => {
    calls.push(request);
    if (request.type === 'login') return Promise.resolve({ ok: false, error: 'invalid code' });
    if (calls.length === 1) return Promise.resolve({ ok: true, retryAfter: 60 });
    return new Promise((resolve) => { finishResend = resolve; });
  });
  p.element('email').value = 'alice@example.com';
  await p.emit('requestCodeForm', 'submit');
  p.advance(60_000);
  p.element('loginCode').value = '123456';
  await p.emit('loginCode', 'input');
  await p.emit('loginForm', 'submit');
  assert.equal(p.element('resendCode').disabled, false);
  const pending = p.emit('resendCode', 'click');
  await p.emit('resendCode', 'click');
  assert.equal(calls.filter((call) => call.type === 'requestCode').length, 2);
  finishResend({ ok: true, retryAfter: 60 });
  await pending;
  assert.equal(p.element('loginCode').value, '');
  assert.equal(p.element('resendCode').disabled, true);
});

test('过期后重发失败保留重试入口，成功后恢复验证码输入', async () => {
  let requests = 0;
  const p = page(async () => {
    requests++;
    return requests === 2 ? { ok: false, error: 'mail unavailable' } : { ok: true, retryAfter: 60 };
  });
  p.element('email').value = 'alice@example.com';
  await p.emit('requestCodeForm', 'submit');
  p.advance(600_000);
  await p.emit('resendCode', 'click');
  assert.equal(p.document.body.dataset.loginState, 'expired');
  assert.equal(p.element('resendCode').disabled, false);
  assert.equal(p.element('loginCode').disabled, true);
  assert.equal(p.element('loginStatus').textContent, 'mail unavailable');
  await p.emit('resendCode', 'click');
  assert.equal(requests, 3);
  assert.equal(p.document.body.dataset.loginState, 'sent');
  assert.equal(p.element('loginCode').disabled, false);
  assert.equal(p.element('loginStatus').hidden, true);
});
