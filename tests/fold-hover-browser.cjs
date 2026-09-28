// 隔离页面模拟 X 悬停时重写 class，验证折叠状态只能由点击改变。
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://x.com/**', route => route.fulfill({ contentType: 'text/html', body: '<article data-testid="tweet" style="width:600px"><div><a href="/author/status/123"><time>now</time></a><div data-testid="tweetText" style="height:200px">Try our product today and get a special promotional offer.</div></div></article>' }));
    await page.goto('https://x.com/home');
    await page.evaluate(() => {
      window.chrome = {
        runtime: { id: 'test', onMessage: { addListener(fn) { window.deliver = fn; } }, sendMessage(message, callback) {
          if (message.type === 'getSettings') callback({ mode: 'fold', authenticated: true, dataConsent: true, keywords: [] });
          else if (message.type === 'classify') callback({ ok: true, result: { isAd: true, prob: 0.95, kind: 'hard_sell', kindProbs: { hard_sell: 0.95, organic: 0.05 } } });
          else callback?.({ ok: true });
        } },
        i18n: { getMessage: key => key }
      };
      const post = document.querySelector('article');
      post.addEventListener('mouseenter', () => { post.className = 'x-hover'; });
      post.addEventListener('mouseleave', () => { post.className = 'x-post'; });
    });
    await page.addStyleTag({ path: path.join(__dirname, '../content.css') });
    await page.addScriptTag({ path: path.join(__dirname, '../content.js') });
    const veil = page.locator('.jev-veil');
    const body = page.locator('[data-testid="tweetText"]');
    await veil.waitFor({ state: 'visible' });
    assert.equal(await body.isVisible(), false);
    await page.locator('article').hover();
    assert.equal(await body.isVisible(), false, '悬停重写 class 后必须保持折叠');
    await page.mouse.move(800, 500);
    assert.equal(await body.isVisible(), false, '移出鼠标仍保持折叠');
    await veil.locator('.jev-veil-action').click();
    assert.equal(await body.isVisible(), true, '点击展开才显示正文');
    await page.mouse.move(800, 500);
    await body.hover();
    assert.equal(await body.isVisible(), true, '用户展开后重写 class 不能重新折叠');
    await page.locator('.jev-badge').click();
    await veil.waitFor({ state: 'visible' });
    assert.equal(await body.isVisible(), false, '角标仍可重新折叠');
    await page.mouse.move(800, 500);
    await page.locator('article').hover();
    assert.equal(await body.isVisible(), false);
    await veil.focus();
    await page.keyboard.press('Enter');
    assert.equal(await body.isVisible(), true, '键盘激活展开按钮仍有效');
    await page.evaluate(() => window.deliver({ type: 'settingsChanged', settings: { mode: 'label', authenticated: false, keywords: [] } }));
    assert.equal(await page.locator('[data-jev-fold]').count(), 0, '重置后清理独立折叠属性');
    assert.equal(await page.locator('[data-jev-revealed]').count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS: hover/class replacement, explicit expand, refold, keyboard and reset');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
