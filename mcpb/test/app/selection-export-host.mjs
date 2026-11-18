// Interactivity, continued: pair matrices and scope-preserving selectors,
// coverage drill-down, stale loading state, downloads and citation exports
// with provenance, SVG exports, host context and display modes. Called in
// order by test/app.test.mjs, after interactions.mjs.
import { parseHTML } from "linkedom";

export async function selectionExportHostChecks({ fail, dom, rootEl, elements, outbound, documentElement, deliver, take, flush, renderPayload, BASE, press, answer }) {
  // Pair matrices use their selected field and common pair base, and selectors
  // preserve the full research scope through the server's top-level filters.
  {
    const payload = {view:"sentiment", model:"all", models:["alpha","beta","gamma"], total_articles:5,
      filters:{country:"Benin",date_from:"2000",exact:{spatial:["Cotonou"]}},
      by_model:{alpha:{polarity_distribution:{Positif:3}},beta:{polarity_distribution:{Neutre:3}},gamma:{polarity_distribution:{Positif:2}}},
      agreement_matrix:{rows:"alpha",cols:"beta",field:"centrality",counts:{Central:{Marginal:2}},common_scored:2,excluded_articles:3,agreement_percent:0,kappa:0,weighted_n:2,notes:["Quadratic ordinal weights."]}};
    await renderPayload(payload);
    if(!rootEl.innerHTML.includes("2 articles have recognized centrality labels") || !rootEl.innerHTML.includes("Weighted κ: undefined"))
      fail("pair matrix omitted its population or undefined statistic");
    outbound.length=0;
    rootEl.querySelector('.pair-controls')?.dispatchEvent(new dom.window.Event("submit",{cancelable:true}));await flush();
    const pair = take((m)=>m.method==="tools/call");
    if(pair?.params.arguments.country!=="Benin" || pair.params.arguments.date_from!=="2000" ||
      pair.params.arguments.exact?.spatial?.[0]!=="Cotonou" || pair.params.arguments.selection ||
      pair.params.arguments.agreement_field!=="centrality" || pair.params.arguments.compare_models?.join(",")!=="alpha,beta")
      fail("pair selector changed the chosen pair, field or top-level scope");
    if(pair) await answer(pair,payload);
    outbound.length=0;
    rootEl.querySelector('[data-key="Central"][data-key2="Marginal"]')?.dispatchEvent(new dom.window.Event("click"));await flush();
    const drill = take((m)=>m.method==="tools/call");
    const exact = drill?.params.arguments.selection?.exact;
    if(exact?.["centrality:alpha"]?.[0]!=="Central" || exact?.["centrality:beta"]?.[0]!=="Marginal" || exact?.scored_by || exact?.spatial?.[0]!=="Cotonou")
      fail("pair cell used the wrong field, widened scope or required other models");
    if(drill) await answer(drill,BASE);
    await renderPayload({...payload,agreement_matrix:{...payload.agreement_matrix,common_scored:0,agreement_percent:undefined,kappa:undefined,counts:{}}});
    if(!rootEl.innerHTML.includes("Pair agreement: undefined (no shared labels)")) fail("no shared pair labels rendered as zero agreement");
  }

  {
    const markup = await renderPayload({view:"comparison",subset:"articles",filters:{},total_matches:3,overlap:0,rows:[],
      selections:[{label:"A",filters:{country:"Benin"},total:2},{label:"B",filters:{country:"Togo"},total:1}],
      temporal:{normalize_by:"corpus",omitted_years:0,note:"Corpus coverage is not historical prevalence.",rows:[
        {selection:"A",year:"2000",count:2,denominator:10,share:0.2},{selection:"B",year:"2000",count:1,denominator:10,share:0.1}]}});
    if(!markup.includes("Yearly counts and denominators") || !markup.includes("historical prevalence") || !rootEl.querySelector("svg"))
      fail("comparison timeline omitted denominators or interpretation note");
  }

  // Coverage drill-down must reproduce a whole pipe-joined country category.
  {
    await renderPayload({
      view: "coverage", subset: "references", filters: {}, source_field: "country",
      source_exact_field: "country_raw", total_matches: 1,
      rows: [{ source: "Niger|Nigeria", year: "2015", total: 1, fulltext: 1 }],
    });
    outbound.length = 0;
    rootEl.querySelector('[data-key="Niger|Nigeria"]')?.dispatchEvent(new dom.window.Event("click"));
    await flush();
    const call = take((m) => m.method === "tools/call");
    if (call?.params.arguments.selection?.exact?.country_raw?.[0] !== "Niger|Nigeria")
      fail("coverage drill-down did not preserve raw multi-country category");
    if (call) await answer(call, BASE);
    const pending = await press("act-gran");
    if (rootEl.getAttribute("aria-busy") !== "true") fail("pending navigation has no busy state");
    elements.get("act-back")?.click();
    await flush();
    if (rootEl.hasAttribute("aria-busy")) fail("Back retained stale busy state");
    if (pending) await answer(pending, BASE);
    if (!rootEl.innerHTML.includes("Source coverage over time")) fail("invalidated response overrode Back");
    if (rootEl.innerHTML.includes("Show embedded")) fail("unavailable coverage metric is still offered");
  }

  // An unsolicited new result also invalidates in-flight loading state.
  {
    await renderPayload(BASE);
    const pending = await press("act-gran");
    await renderPayload({ ...BASE, distribution: { 2020: 5 } });
    if (rootEl.hasAttribute("aria-busy")) fail("new host result retained stale busy state");
    if (pending) await answer(pending, { ...BASE, distribution: { 1990: 5 } });
    if (!rootEl.innerHTML.includes("2020") || rootEl.innerHTML.includes("1990")) fail("old request replaced host result");
  }

  {
    await renderPayload({view:"records", mode:"concordance", subset:"articles", filters:{keyword:"imam"}, total_matches:1,
      rows:[{id:"articles:1", title:"Source", excerpts:["An imam spoke."], matched_terms:["imam"], match_count:1,
        contexts:[{term:"imam",match:"imam",left:"An ",right:" spoke.",start:3,end:7,offset_unit:"utf16"}]}]});
    const csvCall = await press("act-csv", "ui/download-file");
    if (csvCall) {
      const csv = csvCall.params.contents[0]?.resource?.text ?? "";
      if (!csv.includes("excerpts,matched_terms,match_count,contexts") || !csv.includes("An imam spoke.") || !csv.includes("offset_unit"))
        fail("concordance CSV lost its contexts, terms or offsets");
      deliver({jsonrpc:"2.0",id:csvCall.id,result:{}}); await flush();
    }
    await renderPayload({view:"reader", id:"articles:1",title:"Source",text:"Text",url:"https://islam.zmo.de/source"});
    const open = await press("act-source", "ui/open-link");
    if(open){deliver({jsonrpc:"2.0",id:open.id,result:{}});await flush();}
    if(elements.get("act-source")?.disabled || elements.get("act-source")?.textContent !== "Open canonical source")
      fail("successful source opening left its button busy");
    if(rootEl.querySelector(".source-url")?.getAttribute("value") !== "https://islam.zmo.de/source")
      fail("reader lost selectable source URL fallback");
  }

  // Downloads preserve the provenance of the displayed page, and citation
  // formats keep the manifest containing canonical IDs and dataset identities.
  {
    await renderPayload(BASE, null, {snapshot_id:"test-snapshot"});
    const download = await press("act-csv", "ui/download-file");
    if(download){
      const files = download.params.contents;
      const sidecar = files.find((f)=>f.resource.uri.endsWith(".provenance.json"));
      const metadata = JSON.parse(sidecar?.resource.text ?? "{}");
      if(metadata.provenance?.snapshot_id!=="test-snapshot" || metadata.filters?.keyword!=="laïcité") fail("CSV lost provenance/selection sidecar");
      deliver({jsonrpc:"2.0",id:download.id,result:{}});await flush();
    }
    const manifest={records:[{id:"articles:1",url:"https://islam.zmo.de/item/1"}],provenance:{snapshot_id:"citation-snapshot"}};
    await renderPayload({view:"records",mode:"csl_json",subset:"articles",filters:{},rows:[],total_matches:0,
      export:{format:"csl_json",filename:"iwac-citations.json",mime_type:"application/vnd.citationstyles.csl+json",content:"[]",manifest}});
    const citation = await press("act-export", "ui/download-file");
    if(citation){
      const sidecar = citation.params.contents.find((f)=>f.resource.uri.endsWith(".manifest.json"));
      if(JSON.stringify(JSON.parse(sidecar?.resource.text ?? "{}"))!==JSON.stringify(manifest)) fail("citation download lost its selection manifest");
      deliver({jsonrpc:"2.0",id:citation.id,result:{}});await flush();
      if(elements.get("act-export")?.disabled) fail("citation export cannot be repeated");
    }
  }

  // SVG exports retain the visible legend, selected scope and methodological caveats.
  {
    await renderPayload({view:"temporal",subset:"articles",granularity:"year",group_by:"country",filters:{keyword:"scope-test"},
      total_matches:5,dated_count:4,undated_count:1,distribution_by_group:{Benin:{2000:3},Togo:{2000:1}}});
    const call = await press("act-svg", "ui/download-file");
    if(call){
      const svg = call.params.contents[0]?.resource?.text ?? "";
      if(!svg.includes("<style>") || !svg.includes(".tick")) fail("SVG export lost its real bundled stylesheet");
      if(!svg.includes("Selection: keyword: scope-test") || !svg.includes("carry no usable date")) fail("SVG export dropped scope/caveat");
      const parsed = parseHTML(svg).document;
      const visibleText = [...parsed.querySelectorAll("text")].map(x=>x.textContent);
      if(!visibleText.includes("Benin") || !visibleText.includes("Togo")) fail("SVG export has no visible series legend");
      deliver({jsonrpc:"2.0",id:call.id,result:{}});await flush();
      if(elements.get("act-svg")?.disabled) fail("SVG export action cannot be repeated");
    }
  }

  {
    await renderPayload({view:"places",subset:"articles",filters:{},total_matches:101,items_with_place:101,
      places:[{place:"Small",count:1,lat:6,lng:2},{place:"Large",count:100,lat:7,lng:3}]});
    const small = Number(rootEl.querySelector('[data-key="spatial:Small"]')?.getAttribute("r"));
    const large = Number(rootEl.querySelector('[data-key="spatial:Large"]')?.getAttribute("r"));
    if(Math.abs(small * small / (large * large) - 0.01) > 0.00001) fail("map bubble area is not proportional to counts");
  }

  {
    await renderPayload(BASE);
    const call = await press("act-gran");
    if(call){
      deliver({jsonrpc:"2.0",id:call.id,result:{isError:true,content:[{type:"text",text:"Permission unavailable"}]}});
      await flush();await flush();
      if(!rootEl.innerHTML.includes("Permission unavailable") || !rootEl.querySelector("svg")) fail("plain-text tool error lost its message or chart");
      if(rootEl.hasAttribute("aria-busy")) fail("failed tool left its busy state set");
    }
  }

  // A later tool input (a reused frame) must not wipe a rendered chart, and the
  // result that follows clears the busy state.
  {
    const markup = await renderPayload(BASE);
    if (rootEl.hasAttribute("aria-busy")) fail("a tool result left the pending busy state set");
    deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { subset: "documents" } } });
    await flush();
    if (rootEl.innerHTML !== markup || rootEl.hasAttribute("aria-busy")) fail("tool input replaced an already rendered chart");
  }

  // Host context beyond the theme: insets and container height become CSS
  // properties without a re-render, so scroll position and focus survive.
  {
    await renderPayload(BASE);
    const before = rootEl.querySelector("h1");
    deliver({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: {
      safeAreaInsets: { top: 44, right: 0, bottom: 34, left: 0 }, containerDimensions: { maxHeight: 700, width: 390 },
    } });
    await flush();
    const style = documentElement.style;
    if (style.getPropertyValue("--safe-top") !== "44px" || style.getPropertyValue("--safe-bottom") !== "34px")
      fail("safe-area insets were not applied as CSS properties");
    if (style.getPropertyValue("--fit-h") !== "500px")
      fail(`container height was not applied (--fit-h=${style.getPropertyValue("--fit-h")})`);
    if (rootEl.querySelector("h1") !== before) fail("a layout-only context change re-rendered the chart");
    deliver({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { containerDimensions: { height: 100, width: 390 } } });
    await flush();
    if (style.getPropertyValue("--fit-h") !== "160px") fail("a tiny container shrank scroll areas below their floor");
  }

  // Display modes. Claude reports its side panel as fullscreen, so a frame the
  // HOST put there gets no "Exit fullscreen" toggle; only the app's own
  // expansion can be undone from inside it.
  {
    const context = (params) => {
      deliver({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params });
      return flush();
    };
    const label = () => elements.get("act-fullscreen")?.textContent ?? null;
    await renderPayload(BASE);
    await context({ availableDisplayModes: ["inline", "fullscreen"], displayMode: "fullscreen" });
    if (label() !== null) fail(`host-initiated fullscreen offered "${label()}"`);
    await context({ displayMode: "inline" });
    if (label() !== "Fullscreen") fail(`inline frame offered ${label()} instead of Fullscreen`);

    const request = await press("act-fullscreen", "ui/request-display-mode");
    if (request) {
      deliver({ jsonrpc: "2.0", id: request.id, result: { mode: "fullscreen" } });
      await flush();
      await flush();
      if (label() !== "Exit fullscreen") fail(`granted fullscreen offered ${label()} instead of Exit fullscreen`);
      // An echo of the same mode (or any unrelated context) keeps the grant.
      await context({ displayMode: "fullscreen", theme: "dark" });
      if (label() !== "Exit fullscreen") fail("an echoed fullscreen context dropped the app's own grant");
      const exit = await press("act-fullscreen", "ui/request-display-mode");
      if (exit && exit.params.mode !== "inline") fail("Exit fullscreen did not request inline");
      if (exit) {
        deliver({ jsonrpc: "2.0", id: exit.id, result: { mode: "inline" } });
        await flush();
        await flush();
      }
    }
    // A host announcing the grant through context before answering still
    // grants OUR request; its late reply is then ignored.
    const second = await press("act-fullscreen", "ui/request-display-mode");
    if (second) {
      await context({ displayMode: "fullscreen" });
      if (label() !== "Exit fullscreen") fail("a grant announced via host context lost the Exit toggle");
      deliver({ jsonrpc: "2.0", id: second.id, result: { mode: "fullscreen" } });
      await flush();
      await flush();
      if (label() !== "Exit fullscreen") fail("the late reply after a context grant changed the toggle");
    }
    // Leaving through host chrome (Escape) and coming back via the host is
    // host-initiated again.
    await context({ displayMode: "inline" });
    await context({ displayMode: "fullscreen" });
    if (label() !== null) fail("re-entering fullscreen via the host restored the app's Exit toggle");
    await context({ displayMode: "inline" });
  }
}
