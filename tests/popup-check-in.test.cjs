const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const popup = readFileSync(path.join(__dirname, '../popup.js'), 'utf8');
const checkIn = popup.split('// ---------- Check-in ----------')[1].split('let refreshedBadgeTimer;')[0];
const load = popup.slice(popup.indexOf('async function load()'), popup.indexOf('async function syncAccount('));
const refresh = popup.slice(popup.indexOf('async function refreshAccount('), popup.indexOf('chrome.storage.onChanged'));

function page() {
  const elements = new Map();
  const calls = [];
  const pending = [];
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { textContent: '', addEventListener() {}, setAttribute() {} });
    return elements.get(id);
  };
  const context = vm.createContext({
    $: element, t: (key) => key, fmt: String, authenticated: true,
    checkInAccountId: null, checkInState: null, checkInBusy: false, checkInVersion: 0,
    send: async (request) => {
      calls.push(request.type);
      if (request.type === 'getCheckIn' || request.type === 'claimCheckIn') return new Promise(resolve => pending.push(resolve));
      return { ok: true };
    },
    chrome: { storage: { local: { get: async () => ({}) } } },
    setSeg() {}, renderChips() {}, renderStats() {}, renderSettingsSummary() {}, showRefreshedBadge() {},
    syncAccount: async () => context.setCheckInAccount('alice')
  });
  vm.runInContext(checkIn + load + refresh, context);
  return { context, calls, element, finish(claimed) {
    pending.shift()({ ok: true, account: { id: 'alice' }, checkIn: { claimed, amount: 50 } });
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
