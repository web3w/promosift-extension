// 隔离浏览器拦截识别接口，用实际请求数验证模式切换不重复计费。
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
(async () => {
  const profile = await fs.mkdtemp('/tmp/promosift-mode-');
  const ext = require('node:path').resolve(__dirname, '..');
  const ctx = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
  try {
    const errors = [];
    ctx.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    await ctx.route('https://x.com/**', route => route.fulfill({ contentType: 'text/html', body: '<html><body><article data-testid="tweet"><div data-testid="User-Name">Author @author</div><a href="/author/status/123"><time>now</time></a><div data-testid="tweetText">Try our new product today and get the special offer with this promotional code.</div></article></body></html>' }));
    const worker = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
    await worker.evaluate(async () => {
      await storageReady;
      const config = await (await fetch(chrome.runtime.getURL('config.json'))).json();
      const account = { id: 'test', email: 'test@example.com', credits: 500, used: 0 };
      await chrome.storage.local.set({ mode: 'label', dataConsent: true, auth: { token: 'test', apiBase: config.apiBase, expiresAt: Date.now() + 600000 }, account });
      globalThis.requests = 0;
      const original = fetch;
      globalThis.fetch = async (url) => {
        if (String(url).startsWith('chrome-extension:')) return original(url);
        if (String(url).endsWith('/v1/classify')) {
          requests++;
          await new Promise(resolve => { globalThis.finishCheck = resolve; });
          return Response.json({ ok: true, account: { ...account, credits: 499, used: 1 }, result: { prob: 0.95, kind: 'hard_sell', kindProbs: { hard_sell: 1 } } });
        }
        if (String(url).endsWith('/v1/me')) return Response.json({ ok: true, account: (await chrome.storage.local.get('account')).account });
        if (String(url).endsWith('/v1/check-in')) return Response.json({ ok: true, account: (await chrome.storage.local.get('account')).account, checkIn: { claimed: false, amount: 50 } });
        throw Error('Unexpected request: ' + url);
      };
    });
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
    await popup.locator('#appView').waitFor({ state: 'visible' });
    const feed = await ctx.newPage();
    await feed.goto('https://x.com/home');
    await feed.locator('.jev-badge[data-state="loading"]').waitFor();
    const mode = value => popup.locator(`[data-name="mode"] [data-value="${value}"]`).click();
    await mode('fold'); await mode('label'); await mode('fold');
    await feed.waitForTimeout(800);
    assert.equal(await worker.evaluate(() => requests), 1);
    await worker.evaluate(() => finishCheck());
    await feed.locator('article.jev-fold').waitFor();
    for (let i = 0; i < 3; i++) {
      await mode('label');
      await feed.waitForFunction(() => !document.querySelector('article').classList.contains('jev-fold'));
      await mode('fold');
      await feed.locator('article.jev-fold').waitFor();
    }
    await feed.waitForTimeout(1000);
    assert.equal(await worker.evaluate(() => requests), 1);
    assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('account')).account.used), 1);
    // 刷新和另一标签页没有内容脚本内存，仍应命中后台持久缓存。
    await feed.reload();
    await feed.locator('article.jev-fold').waitFor();
    const secondFeed = await ctx.newPage();
    await secondFeed.goto('https://x.com/home');
    await secondFeed.locator('article.jev-fold').waitFor();
    assert.equal(await worker.evaluate(() => requests), 1);
    assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('account')).account.used), 1);
    assert.deepEqual(errors, []);
    console.log('PASS: toggling modes during and after classification keeps one request / one credit; mode changes, page reload and another tab reuse the result');
  } finally { await ctx.close(); await fs.rm(profile, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exit(1); });
