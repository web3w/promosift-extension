const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const popup = readFileSync(path.join(__dirname, '../popup.js'), 'utf8');
const checkIn = popup.split('// ---------- Check-in ----------')[1].split('let refreshedBadgeTimer;')[0];
const load = popup.slice(popup.indexOf('async function load()'), popup.indexOf('async function syncAccount('));
const refresh = popup.slice(popup.indexOf('async function refreshAccount('), popup.indexOf('chrome.storage.onChanged'));

function page(timeZone = 'UTC', nextAvailableAt = Date.parse('2026-09-26T16:00:00Z')) {
  const elements = new Map();
  const calls = [];
  const pending = [];
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { textContent: '', addEventListener() {}, setAttribute() {} });
    return elements.get(id);
  };
  const context = vm.createContext({
    $: element, t: (key, time) => key === 'checkInNote' ? `Resets daily · ${time}` : key, fmt: String, authenticated: true,
    Intl: { DateTimeFormat: function(locale, options) {
      // 模拟浏览器默认时区，确保产品代码没有固定指定时区。
      assert.equal(options.timeZone, undefined);
      return new Intl.DateTimeFormat(locale, { ...options, timeZone });
    } },
    checkInAccountId: null, checkInState: null, checkInBusy: false, checkInVersion: 0,
    send: async (request) => {
      calls.push(request.type);
      if (request.type === 'getCheckIn' || request.type === 'claimCheckIn') return new Promise(resolve => pending.push(resolve));
      return { ok: true };
    },
    chrome: { i18n: { getUILanguage: () => 'en-US' }, storage: { local: { get: async () => ({}) } } },
    setSeg() {}, renderChips() {}, renderStats() {}, renderSettingsSummary() {}, showRefreshedBadge() {},
    syncAccount: async () => context.setCheckInAccount('alice')
  });
  vm.runInContext(checkIn + load + refresh, context);
  return { context, calls, element, finish(claimed) {
    pending.shift()({ ok: true, account: { id: 'alice' }, checkIn: { claimed, amount: 50, nextAvailableAt } });
  } };
}

test('初始化即使首次签到查询先完成，也只查询一次签到状态', async () => {
  const p = page();
  // 在账户刷新返回前完成首次签到查询，覆盖原先会重复查询的时序。
  p.context.syncAccount = async () => {
    p.context.setCheckInAccount('alice');
    if (p.calls.filter(type => type === 'getCheckIn').length === 1 && !p.context.checkInState) p.finish(true);
  };
  await p.context.load();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.calls.filter(type => type === 'getCheckIn').length, 1);
  assert.equal(p.calls.filter(type => type === 'getAccount').length, 1);
});

test('重置时间跟随浏览器时区，并使用重置日期对应的夏令时', async () => {
  for (const [zone, date, expected] of [
    ['Asia/Shanghai', '2026-09-26T16:00:00Z', '00:00 GMT+8'],
    ['UTC', '2026-09-26T16:00:00Z', '16:00 UTC'],
    ['Asia/Kolkata', '2026-09-26T16:00:00Z', '21:30 GMT+5:30'],
    ['America/Los_Angeles', '2026-09-26T16:00:00Z', '09:00 PDT'],
    ['America/Los_Angeles', '2026-12-26T16:00:00Z', '08:00 PST']
  ]) {
    const p = page(zone, Date.parse(date));
    p.context.setCheckInAccount('alice');
    p.finish(true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(p.element('checkInNote').textContent, `Resets daily · ${expected}`);
  }
});

test('首次查询显示加载，后续刷新保留 Claimed，跨日后允许主动领取', async () => {
  const p = page();
  p.context.setCheckInAccount('alice');
  assert.equal(p.element('checkIn').textContent, 'checkInQuerying');
  p.finish(true);
  await new Promise(resolve => setImmediate(resolve));
  const refreshing = p.context.refreshAccount();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.element('checkIn').textContent, 'checkInClaimedToday');
  assert.equal(p.element('checkIn').disabled, true);
  p.finish(false);
  await refreshing;
  assert.equal(p.element('checkIn').textContent, 'checkInClaimPrompt');
  assert.equal(p.element('checkIn').disabled, false);
  assert.ok(!p.calls.includes('claimCheckIn'));
  const claiming = p.context.updateCheckIn(true);
  assert.equal(p.element('checkIn').textContent, 'checkInClaiming');
  p.finish(true);
  await claiming;
  assert.equal(p.element('checkIn').textContent, 'checkInClaimedToday');
});
