// 隔离浏览器加载真实扩展，拦截全部业务请求，验证明确同意前不会自动上传。
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
(async () => {
 const profile = await fs.mkdtemp('/tmp/promosift-consent-');
 const ext = require('node:path').resolve(__dirname, '..');
 const ctx = await chromium.launchPersistentContext(profile, {channel:'chromium',headless:true, args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`], viewport:{width:360,height:600}});
 try {
 const errors=[];ctx.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
 await ctx.route('https://x.com/**',r=>r.fulfill({contentType:'text/html',body:'<html><body><article data-testid="tweet"><div data-testid="User-Name"><a>Author</a><a>@author</a></div><a href="/author/status/123"><time>now</time></a><div data-testid="tweetText">An example post about a quiet walk outside with friends today.</div></article></body></html>'}));
 const worker=ctx.serviceWorkers()[0]||await ctx.waitForEvent('serviceworker');
 const id=new URL(worker.url()).host;
 await worker.evaluate(async()=>{
  await storageReady;
  globalThis.checkRequests=[];
  const original=fetch;
  globalThis.fetch=async(url,init)=>{
   if(String(url).startsWith('chrome-extension:'))return original(url,init);
   const account={id:'consent-test',email:'test@example.com',credits:500,used:0};
   if(String(url).endsWith('/v1/classify')){checkRequests.push(JSON.parse(init.body));return Response.json({ok:true,account,result:{prob:0.2,kind:'organic',kindProbs:{organic:1}},topics:{},ai:null});}
   if(String(url).endsWith('/auth/google/status'))return Response.json({ok:true,available:false});
   if(String(url).endsWith('/v1/me'))return Response.json({ok:true,account});
   if(String(url).endsWith('/v1/check-in'))return Response.json({ok:true,account,checkIn:{claimed:false,amount:50}});
   throw Error('Unexpected request: '+url);
  };
 });
 await worker.evaluate(() => chrome.storage.local.set({ lastLoginEmail: "recent@example.com" }));
 const popup=await ctx.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);
 await popup.locator('#dataConsentNotice').waitFor({state:'visible'});
 assert(await popup.locator('#loginView').isVisible());
 assert.equal(await popup.locator('#email').inputValue(), 'recent@example.com');
 await popup.locator('#email').fill('different@example.com');
 assert.equal(await popup.locator('#email').inputValue(), 'different@example.com');
 await popup.reload();
 await popup.locator('#dataConsentNotice').waitFor({state:'visible'});
 assert.equal(await popup.locator('#email').inputValue(), 'recent@example.com');
 assert(!(await popup.locator('#acceptDataConsent').isChecked()));
 assert(await popup.locator('#googleLogin img').evaluate(el=>el.complete&&el.naturalWidth>0));
 await popup.screenshot({path:'/tmp/promosift-google-extension.png'});
 assert(await popup.locator('#googleLogin').isDisabled());
 assert(await popup.locator('#requestCode').isDisabled());
 await popup.locator('#requestCodeForm').evaluate(el=>el.dispatchEvent(new Event('submit',{cancelable:true})));
 assert.equal(await popup.evaluate(()=>document.body.dataset.loginState),'idle');
 await popup.locator('#acceptDataConsent').check();
 await popup.waitForFunction(()=>!document.querySelector('#googleLogin').disabled);
 assert(!(await popup.locator('#requestCode').isDisabled()));
 await popup.reload();
 await popup.waitForFunction(()=>!document.querySelector('#googleLogin').disabled);
 assert(await popup.locator('#acceptDataConsent').isChecked());
 await popup.locator('#googleLogin').click();
 await popup.waitForFunction(()=>!document.querySelector('#googleLogin').disabled);
 assert(await popup.locator('#loginView').isVisible());
 assert(await popup.locator('#acceptDataConsent').isChecked());
 await popup.locator('#acceptDataConsent').uncheck();
 await popup.waitForFunction(()=>!document.querySelector('#acceptDataConsent').disabled);
 assert(await popup.locator('#googleLogin').isDisabled());
 assert(await popup.locator('#requestCode').isDisabled());
 await popup.screenshot({path:'/tmp/promosift-consent-compact.png'});
 assert.match(await popup.locator('#dataConsentNotice').innerText(),/author|作者/i);
 assert.equal(await popup.locator('#dataConsentNotice a').getAttribute('href'),'https://promosift.app/privacy.html');
 for(const state of ['sent','error','expired']){
  await popup.evaluate(state=>document.body.dataset.loginState=state,state);
  assert(await popup.locator('#dataConsentNotice').isVisible());
 }
 await worker.evaluate(async()=>{
  const config=await (await fetch(chrome.runtime.getURL('config.json'))).json();
  await chrome.storage.local.set({auth:{token:'local-test',apiBase:config.apiBase,expiresAt:Date.now()+600000},account:{id:'consent-test',email:'test@example.com',credits:500,used:0}});
 });
 await popup.reload();await popup.locator('#appView').waitFor({state:'visible'});
 assert(await popup.locator('#dataConsentNotice').isHidden());
 const feed=await ctx.newPage();await feed.goto('https://x.com/home');
 await feed.waitForTimeout(1500);
 assert.equal(await worker.evaluate(()=>checkRequests.length),0);
 // 模拟旧会话退出，回到登录页主动勾选，再恢复隔离测试会话。
 const savedAuth=await worker.evaluate(()=>chrome.storage.local.get('auth'));
 await worker.evaluate(()=>chrome.storage.local.remove('auth'));
 await popup.reload();await popup.locator('#dataConsentNotice').waitFor({state:'visible'});
 await popup.locator('#acceptDataConsent').check();
 await popup.waitForFunction(()=>!document.querySelector('#googleLogin').disabled);
 await worker.evaluate(auth=>chrome.storage.local.set(auth),savedAuth);
 await feed.waitForFunction(()=>document.querySelector('.jev-badge[data-state="ok"]'));
 assert.equal(await worker.evaluate(()=>checkRequests.length),1);
 await popup.reload();await popup.locator('#appView').waitFor({state:'visible'});
 assert(await popup.locator('#dataConsentNotice').isHidden());
 assert(await popup.locator('#acceptDataConsent').isChecked());
 await worker.evaluate(()=>chrome.storage.local.remove('auth'));
 await popup.reload();await popup.locator('#dataConsentNotice').waitFor({state:'visible'});
 assert(await popup.locator('#acceptDataConsent').isChecked());
 await popup.locator('#acceptDataConsent').uncheck();
 await popup.waitForFunction(()=>!document.querySelector('#acceptDataConsent').disabled);
 await feed.reload();await feed.waitForTimeout(1500);
 assert.equal(await worker.evaluate(()=>checkRequests.length),1);
 await popup.reload();
 assert(!(await popup.locator('#acceptDataConsent').isChecked()));
 assert.deepEqual(errors,[]);
 console.log('PASS: logged-out steps, existing-session consent gate, no automatic upload before agreement, actual click enables check, consent persists, no page errors');
 } finally {await ctx.close();await fs.rm(profile,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exit(1)});
