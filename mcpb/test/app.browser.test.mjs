// Real Chromium complements the fast DOM harness: focus, iframe capabilities,
// narrow layouts and portable SVG rendering require a browser engine.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { withFixtureScope } from "./_fixture-client.mjs";

const BASE = {
  view: "temporal", subset: "articles", granularity: "year", filters: { keyword: "imam" },
  total_matches: 5, dated_count: 4, undated_count: 1, distribution: { 2000: 4 },
};
const READER = { view: "reader", id: "articles:101", title: "Source item", text: "Source text", url: "https://islam.zmo.de/source" };
const hostHtml = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}iframe{display:block;border:0;width:100%;height:1400px}</style></head><body>
<iframe id="app" title="IWAC research view" sandbox="allow-scripts allow-same-origin" src="/app"></iframe>
<script>
const frame=document.getElementById('app');
window.host={ready:false,pending:[],downloads:[],links:[],contexts:[],messages:[],displayRequests:[],displayPending:[],deny:{},displayMode:'inline',forceDisplayMode:null,deferDisplay:false,
  send(message){frame.contentWindow.postMessage(message,location.origin)},
  payload(payload){this.send({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:payload}})},
  answer(id,payload,isError=false){this.send({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:payload,...(isError?{isError:true}:{})}})},
  context(context){this.send({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:context})},
  cancel(reason){this.send({jsonrpc:'2.0',method:'ui/notifications/tool-cancelled',params:{reason}})}
};
window.addEventListener('message',event=>{
 if(event.source!==frame.contentWindow) return;
 const m=event.data,h=window.host;
 if(m.method==='ui/initialize'){
   const params=new URLSearchParams(location.search),minimal=params.has('minimal'),messageOnly=params.has('messageOnly'),structuredOnly=params.has('structuredOnly');
   const capabilities=minimal?{serverTools:{}}:{serverTools:{},downloadFile:{},openLinks:{},message:{text:{}},...(!messageOnly?{updateModelContext:structuredOnly?{structuredContent:{}}:{text:{}}}:{})};
   if(params.has('readOnly'))delete capabilities.serverTools;
   h.send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:m.params.protocolVersion,hostInfo:{name:'browser-test',version:'1'},hostCapabilities:capabilities,hostContext:{theme:'light',displayMode:'inline',availableDisplayModes:minimal?['inline']:['inline','fullscreen']}}});h.ready=true;
 }else if(m.method==='tools/call')h.pending.push(m);
 else if(m.method==='ui/download-file'){h.downloads.push(m.params);h.send({jsonrpc:'2.0',id:m.id,result:{isError:Boolean(h.deny.downloadFile)}})}
 else if(m.method==='ui/open-link'){h.links.push(m.params);h.send({jsonrpc:'2.0',id:m.id,result:{isError:Boolean(h.deny.openLinks)}})}
 else if(m.method==='ui/message'){h.messages.push(m.params);h.send({jsonrpc:'2.0',id:m.id,result:{isError:Boolean(h.deny.message)}})}
 else if(m.method==='ui/update-model-context'){
   h.contexts.push(m.params);
   h.send(h.deny.context?{jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'Context update declined'}}:{jsonrpc:'2.0',id:m.id,result:{}});
 }
 else if(m.method==='ui/request-display-mode'){
   h.displayRequests.push(m.params);
   if(h.deferDisplay){h.displayPending.push(m);return;}
   h.displayMode=h.forceDisplayMode??m.params.mode;
   h.send({jsonrpc:'2.0',id:m.id,result:{mode:h.displayMode}});
 }
});
</script></body></html>`;

await withFixtureScope(async (scope) => {
  const { client, close } = await scope.connect({ name: "browser-ui", stderr: "ignore" });
  const resource = await client.readResource({ uri: "ui://iwac/charts.html" });
  const html = resource.contents[0].text;
  await close();
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    // Exercise the app under its expected no-network, inline-script CSP.
    if (req.url === "/app") {
      res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:");
      res.end(html);
    } else res.end(hostHtml);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.IWAC_BROWSER_EXECUTABLE ? { executablePath: process.env.IWAC_BROWSER_EXECUTABLE } : {}),
    });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const url = `http://127.0.0.1:${server.address().port}`;
    const view = page.frameLocator("#app");
    const emit = async (payload) => {
      await page.evaluate((p) => window.host.payload(p), payload);
      await view.locator("h1").waitFor();
    };
    const lastCall = async () => {
      await page.waitForFunction(() => window.host.pending.length > 0);
      return page.evaluate(() => window.host.pending.shift());
    };
    const contextCount = () => page.evaluate(() => window.host.contexts.length);
    const lastContext = () => page.evaluate(() => window.host.contexts.at(-1));
    const flushFrames = () => view.locator("body").evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const expectContextAfter = async (previousCount) => {
      await page.waitForFunction((n) => window.host.contexts.length > n, previousCount);
      await flushFrames();
      const context = await lastContext();
      assert.ok(Buffer.byteLength(JSON.stringify(context)) < 14_000, "model context must stay compact");
      return context;
    };
    await page.goto(url);
    await page.waitForFunction(() => window.host?.ready);
    await emit(BASE);
    const initialContext = await expectContextAfter(0);
    assert.ok(JSON.stringify(initialContext).includes("imam"), JSON.stringify(initialContext));
    assert.equal(await page.evaluate(() => window.host.messages.length), 0, "context synchronization must not send a user message");

    // Honor the mode actually granted by the host, including denied expansion.
    await view.locator("#act-fullscreen").click();
    await page.waitForFunction(() => window.host.displayRequests.length === 1);
    await view.getByRole("button", { name: "Exit fullscreen", exact: true }).waitFor();
    await view.locator("#act-fullscreen").click();
    await view.getByRole("button", { name: "Fullscreen", exact: true }).waitFor();
    await page.evaluate(() => { window.host.forceDisplayMode = "inline"; });
    await view.locator("#act-fullscreen").click();
    await page.waitForFunction(() => window.host.displayRequests.length === 3);
    await view.getByRole("button", { name: "Fullscreen", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.host.displayRequests.at(-1).mode), "fullscreen");
    await page.evaluate(() => { window.host.forceDisplayMode = null; window.host.deferDisplay = true; });
    await view.locator("#act-fullscreen").click();
    await page.waitForFunction(() => window.host.displayPending.length === 1);
    // A newer host event (e.g. Escape) wins over the older request's late reply.
    await page.evaluate(() => window.host.context({ displayMode: "inline" }));
    await flushFrames();
    await page.evaluate(() => {
      const pending = window.host.displayPending.shift();
      window.host.send({jsonrpc:"2.0",id:pending.id,result:{mode:"fullscreen"}});
      window.host.deferDisplay = false;
    });
    await flushFrames();
    assert.equal(await view.locator("html").getAttribute("data-display-mode"), "inline");
    assert.equal(await view.locator("#act-fullscreen").textContent(), "Fullscreen");

    // Theme notifications change the drawing without duplicating research context.
    const beforeTheme = await contextCount();
    await page.evaluate(() => window.host.context({ theme: "dark" }));
    await view.locator('html[data-theme="dark"]').waitFor();
    await flushFrames();
    assert.equal(await contextCount(), beforeTheme);
    await page.evaluate(() => window.host.context({ theme: "light" }));
    await view.locator('html[data-theme="light"]').waitFor();

    await view.locator("#act-ask-selection").click();
    await page.waitForFunction(() => window.host.messages.length === 1);
    await view.locator("#act-ask-selection:enabled").waitFor();
    const message = await page.evaluate(() => window.host.messages[0]);
    assert.equal(message.role, "user");
    assert.ok(JSON.stringify(message).includes("imam"), "explicit question must retain its selection");

    // A long chart scrolls inside the chart area, not the entire mobile page.
    assert.ok(await view.locator("body").evaluate((body) => body.scrollWidth <= body.clientWidth + 1));
    const csv = view.locator("#act-csv");
    await csv.click();
    await page.waitForFunction(() => window.host.downloads.length === 1);
    await view.locator("#act-csv:enabled").waitFor();
    assert.equal(await csv.isEnabled(), true);
    assert.equal(await csv.textContent(), "Download CSV");
    await csv.click();
    await page.waitForFunction(() => window.host.downloads.length === 2);
    await page.evaluate(() => { window.host.deny.downloadFile = true; });
    await csv.click();
    await view.locator(".action-error").waitFor();
    assert.ok((await view.locator(".action-error").textContent()).length > 0, "resolved host refusal must be visible");
    await view.locator("#act-csv:enabled").waitFor();
    await page.evaluate(() => { window.host.deny.downloadFile = false; });

    // Navigate, preserve focus, then go Back while another request is pending.
    const beforeNavigation = await contextCount();
    await view.locator("#act-gran").click();
    const first = await lastCall();
    await page.evaluate(({ id, payload }) => window.host.answer(id, payload), { id: first.id, payload: { ...BASE, granularity: "month", distribution: { "2000-01": 4 } } });
    await view.locator("#act-back").waitFor();
    assert.ok(JSON.stringify(await expectContextAfter(beforeNavigation)).includes("month"));
    assert.equal(await view.locator("h1").evaluate((heading) => document.activeElement === heading), true);
    await view.locator("#act-group").click();
    const pending = await lastCall();
    assert.equal(await view.locator("#root").getAttribute("aria-busy"), "true");
    const beforeBack = await contextCount();
    await view.locator("#act-back").click();
    assert.ok(JSON.stringify(await expectContextAfter(beforeBack)).includes("year"));
    assert.equal(await view.locator("#root").getAttribute("aria-busy"), null);
    const beforeStale = await contextCount();
    await page.evaluate(({ id, payload }) => window.host.answer(id, payload), { id: pending.id, payload: { ...BASE, distribution: { 1900: 2 } } });
    await flushFrames();
    assert.equal(await contextCount(), beforeStale, "stale result must not update model context");
    assert.ok((await view.locator(".chart").textContent()).includes("2000"));

    await emit({ ...BASE, group_by: "country", distribution: undefined, distribution_by_group: { Benin: { 2000: 3 }, Togo: { 2000: 1 } } });
    await view.locator("#act-svg").click();
    await page.waitForFunction(() => window.host.downloads.length === 4);
    const svg = await page.evaluate(() => window.host.downloads.at(-1).contents[0].resource.text);
    const figure = await browser.newPage();
    await figure.goto(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    assert.equal(await figure.locator("parsererror").count(), 0,
      `export must parse as standalone XML: ${(await figure.locator("parsererror").allTextContents()).join(" ")}`);
    const visibleText = await figure.locator("text").allTextContents();
    assert.ok(visibleText.includes("Benin") && visibleText.includes("Togo"), "exported legend must be visible");
    assert.ok(visibleText.some((text) => text.includes("Selection: keyword: imam")));
    assert.ok(visibleText.some((text) => text.includes("carry no usable date")));
    assert.notEqual(await figure.locator("text").first().evaluate((el) => getComputedStyle(el).fill), "none");
    await figure.close();

    const beforeReader = await contextCount();
    await emit({ ...READER, text: "FULL_SOURCE_TEXT_MUST_NOT_ENTER_CONTEXT".repeat(1000) });
    const readerContext = JSON.stringify(await expectContextAfter(beforeReader));
    assert.ok(readerContext.includes("articles:101"));
    assert.ok(!readerContext.includes("FULL_SOURCE_TEXT_MUST_NOT_ENTER_CONTEXT"));
    await view.locator("#act-source").click();
    await page.waitForFunction(() => window.host.links.length === 1);
    await view.locator("#act-source:enabled").waitFor();
    assert.equal(await view.locator("#act-source").isEnabled(), true);
    await page.evaluate(() => { window.host.deny.openLinks = true; });
    await view.locator("#act-source").click();
    await view.locator(".action-error").waitFor();
    await view.locator("#act-source:enabled").waitFor();
    await page.evaluate(() => { window.host.deny.message = true; });
    await view.locator("#act-ask-selection").click();
    await page.waitForFunction(() => window.host.messages.length === 2);
    await view.locator(".action-error").waitFor();
    await view.locator("#act-ask-selection:enabled").waitFor();
    assert.ok((await view.locator(".action-error").textContent()).includes("Ask"));

    // View-local options synchronize, while failed requests retain prior context.
    const beforeCoverage = await contextCount();
    await emit({view:"coverage",subset:"articles",filters:{country:"Togo"},total_matches:3,source_field:"newspaper",
      rows:[{source:"Outlet",year:"2000",total:3,fulltext:2,embedded:1,scored:3}]});
    await expectContextAfter(beforeCoverage);
    const beforeOption = await contextCount();
    await view.locator("#act-metric").click();
    assert.ok(JSON.stringify(await expectContextAfter(beforeOption)).includes("embedded"));
    const beforeFailure = await contextCount();
    await view.locator("#act-read-items").click();
    const failure = await lastCall();
    await page.evaluate((id) => window.host.answer(id, {error:"Source unavailable"}, true), failure.id);
    await view.getByRole("alert").filter({hasText:"Source unavailable"}).waitFor();
    await flushFrames();
    assert.equal(await contextCount(), beforeFailure, "failed tool must not replace model context");
    await view.locator("#act-read-items").click();
    const cancelled = await lastCall();
    await page.evaluate(() => window.host.cancel("user action"));
    await view.getByRole("alert").filter({hasText:"Request cancelled"}).waitFor();
    assert.equal(await view.locator("#root").getAttribute("aria-busy"), null);
    assert.equal(await view.locator(".chart svg").count(), 1);
    await page.evaluate(({id,payload}) => window.host.answer(id,payload), {id:cancelled.id,payload:READER});
    await flushFrames();
    assert.equal(await contextCount(), beforeFailure, "cancelled request must not replace the retained selection context");

    // Structured-only context hosts receive only the modality they negotiated.
    await page.goto(`${url}?structuredOnly=1`);
    await page.waitForFunction(() => window.host?.ready);
    await emit(READER);
    const structured = await expectContextAfter(0);
    assert.ok(JSON.stringify(structured.structuredContent).includes("articles:101"));
    assert.equal(structured.content, undefined);
    // A rejected automatic update is visible; explicit questions still carry
    // their own selection rather than relying on stale host context.
    await page.evaluate(() => { window.host.deny.context = true; });
    const beforeDeclined = await contextCount();
    await emit(BASE);
    await expectContextAfter(beforeDeclined);
    await view.locator("#selection-context-status").filter({hasText:"Could not share"}).waitFor();
    await view.locator("#act-ask-selection").click();
    await page.waitForFunction(() => window.host.messages.length === 1);
    assert.ok(JSON.stringify(await page.evaluate(() => window.host.messages[0])).includes("imam"));

    // A message-only host still gets the current selection in the explicit question.
    await page.goto(`${url}?messageOnly=1`);
    await page.waitForFunction(() => window.host?.ready);
    await emit(READER);
    await view.locator("#act-ask-selection").click();
    await page.waitForFunction(() => window.host.messages.length === 1);
    assert.equal(await contextCount(), 0);
    assert.ok(JSON.stringify(await page.evaluate(() => window.host.messages[0])).includes("articles:101"));

    // Hosts without openLinks/downloadFile still offer a copyable canonical URL.
    await page.goto(`${url}?minimal=1`);
    await page.waitForFunction(() => window.host?.ready);
    await emit(READER);
    assert.equal(await view.locator("#act-source").count(), 0);
    assert.equal(await view.locator("#act-json").count(), 0);
    assert.equal(await view.locator("#act-fullscreen").count(), 0);
    assert.equal(await view.locator("#act-ask-selection").count(), 0);
    assert.equal(await contextCount(), 0);
    assert.equal(await page.evaluate(() => window.host.messages.length), 0);
    const sourceUrl = view.getByRole("textbox", { name: "Canonical source URL" });
    assert.equal(await sourceUrl.inputValue(), READER.url);
    await sourceUrl.focus();
    assert.equal(await sourceUrl.evaluate((input) => input.selectionEnd - input.selectionStart), READER.url.length);

    await page.goto(`${url}?minimal=1&readOnly=1`);
    await page.waitForFunction(() => window.host?.ready);
    await emit(BASE);
    assert.equal(await view.locator("#act-read-items").count(), 0);
    await view.locator("#act-gran").click();
    await view.getByRole("alert").filter({hasText:"This host cannot open further IWAC results"}).waitFor();
    assert.equal(await page.evaluate(() => window.host.pending.length), 0);
    assert.equal(await view.locator("#root").getAttribute("aria-busy"), null);
    assert.deepEqual(pageErrors, []);
    const unsupported = await browser.newPage();
    await unsupported.addInitScript(() => { window.DecompressionStream = undefined; });
    await unsupported.goto(url);
    const fallback = unsupported.frameLocator("#app").getByRole("alert");
    await fallback.waitFor();
    assert.ok((await fallback.textContent()).includes("text results remain available"));
    await unsupported.close();
    console.log("BROWSER APP CHECKS PASSED (Chromium, CSP, exports, fullscreen, context sync, messages, focus, capabilities)");
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
