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
window.host={ready:false,pending:[],downloads:[],links:[],
  send(message){frame.contentWindow.postMessage(message,location.origin)},
  payload(payload){this.send({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:payload}})},
  answer(id,payload){this.send({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:payload}})}
};
window.addEventListener('message',event=>{
 if(event.source!==frame.contentWindow) return;
 const m=event.data,h=window.host;
 if(m.method==='ui/initialize'){
   const minimal=new URLSearchParams(location.search).has('minimal');
   h.send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:m.params.protocolVersion,hostInfo:{name:'browser-test',version:'1'},hostCapabilities:minimal?{serverTools:{}}:{serverTools:{},downloadFile:{},openLinks:{}},hostContext:{theme:'light'}}});h.ready=true;
 }else if(m.method==='tools/call')h.pending.push(m);
 else if(m.method==='ui/download-file'){h.downloads.push(m.params);h.send({jsonrpc:'2.0',id:m.id,result:{}})}
 else if(m.method==='ui/open-link'){h.links.push(m.params);h.send({jsonrpc:'2.0',id:m.id,result:{}})}
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
    await page.goto(url);
    await page.waitForFunction(() => window.host?.ready);
    await emit(BASE);

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

    // Navigate, preserve focus, then go Back while another request is pending.
    await view.locator("#act-gran").click();
    const first = await lastCall();
    await page.evaluate(({ id, payload }) => window.host.answer(id, payload), { id: first.id, payload: { ...BASE, granularity: "month", distribution: { "2000-01": 4 } } });
    await view.locator("#act-back").waitFor();
    assert.equal(await view.locator("h1").evaluate((heading) => document.activeElement === heading), true);
    await view.locator("#act-group").click();
    const pending = await lastCall();
    assert.equal(await view.locator("#root").getAttribute("aria-busy"), "true");
    await view.locator("#act-back").click();
    assert.equal(await view.locator("#root").getAttribute("aria-busy"), null);
    await page.evaluate(({ id, payload }) => window.host.answer(id, payload), { id: pending.id, payload: { ...BASE, distribution: { 1900: 2 } } });
    assert.ok((await view.locator(".chart").textContent()).includes("2000"));

    await emit({ ...BASE, group_by: "country", distribution: undefined, distribution_by_group: { Benin: { 2000: 3 }, Togo: { 2000: 1 } } });
    await view.locator("#act-svg").click();
    await page.waitForFunction(() => window.host.downloads.length === 3);
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

    await emit(READER);
    await view.locator("#act-source").click();
    await page.waitForFunction(() => window.host.links.length === 1);
    await view.locator("#act-source:enabled").waitFor();
    assert.equal(await view.locator("#act-source").isEnabled(), true);

    // Hosts without openLinks/downloadFile still offer a copyable canonical URL.
    await page.goto(`${url}?minimal=1`);
    await page.waitForFunction(() => window.host?.ready);
    await emit(READER);
    assert.equal(await view.locator("#act-source").count(), 0);
    assert.equal(await view.locator("#act-json").count(), 0);
    const sourceUrl = view.getByRole("textbox", { name: "Canonical source URL" });
    assert.equal(await sourceUrl.inputValue(), READER.url);
    await sourceUrl.focus();
    assert.equal(await sourceUrl.evaluate((input) => input.selectionEnd - input.selectionStart), READER.url.length);
    assert.deepEqual(pageErrors, []);
    const unsupported = await browser.newPage();
    await unsupported.addInitScript(() => { window.DecompressionStream = undefined; });
    await unsupported.goto(url);
    const fallback = unsupported.frameLocator("#app").getByRole("alert");
    await fallback.waitFor();
    assert.ok((await fallback.textContent()).includes("text results remain available"));
    await unsupported.close();
    console.log("BROWSER APP CHECKS PASSED (Chromium, narrow iframe, CSP, exports, focus, capabilities)");
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
