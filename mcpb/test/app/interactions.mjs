// Interactivity on the shared app instance: actions issue the tools/call they
// claim with the filters carried forward, view options switch without a round
// trip, CSV export, and regressions driven through real SVG marks (keyboard
// activation, drill-down, source reading, stale calls). Called in order by
// test/app.test.mjs.

export async function interactionChecks({ fail, dom, rootEl, elements, outbound, deliver, take, flush, renderPayload, BASE, press, answer }) {
  await renderPayload(BASE);

  {
    const call = await press("act-gran");
    if (call) {
      if (call.params.name !== "get_temporal_distribution") fail(`clicked the wrong tool: ${call.params.name}`);
      if (call.params.arguments.granularity !== "month") fail("granularity toggle did not switch to month");
      if (call.params.arguments.country !== "Togo") fail("granularity toggle dropped the country filter");
      if (call.params.arguments.keyword !== "laïcité") fail("granularity toggle dropped the keyword filter");
      await answer(call, { ...BASE, granularity: "month", distribution: { "2003-04": 5 } });
      if (!rootEl.innerHTML.includes("articles per month")) fail("the re-call result did not re-render");
    }
  }

  await renderPayload(BASE);

  {
    const call = await press("act-group");
    if (call && call.params.arguments.group_by !== "country")
      fail("group_by toggle did not request a country grouping");
    // A rejected re-call must keep the chart on screen rather than blanking it:
    // a group_by the subset cannot serve should not cost the user their place.
    if (call) {
      await answer(call, { error: "group_by 'country' is not available for subset 'documents'" }, true);
      const markup = rootEl.innerHTML;
      if (!markup.includes("not available")) fail("a rejected re-call did not surface its error");
      if (!markup.includes("<svg")) fail("a rejected re-call blanked the chart instead of keeping it");
    }
  }

  // A view option switches the rendering with NO server round trip: the network
  // is a second reading of the co-occurrence payload already on screen.
  {
    await renderPayload({
      view: "cooccurrence",
      subset: "articles",
      field: "subject",
      filters: {},
      total_matches: 12287,
      values: [
        { value: "Prière", count: 2139 },
        { value: "Hadj", count: 1917 },
        { value: "Paix", count: 1894 },
      ],
      matrix: [
        [2139, 354, 796],
        [354, 1917, 214],
        [796, 214, 1894],
      ],
      top_pairs: [{ a: "Prière", b: "Paix", count: 796 }],
    });
    if (rootEl.innerHTML.includes("Co-mention network")) fail("the matrix should be the default rendering");

    outbound.length = 0;
    elements.get("act-layout")?.click();
    await flush();
    if (take((m) => m.method === "tools/call")) fail("switching layout must not call the server");
    const markup = rootEl.innerHTML;
    if (!markup.includes("Co-mention network")) fail("the layout toggle did not switch to the network");
    if ((markup.match(/<circle/g) ?? []).length !== 3) fail("expected one node per value");
    if (!markup.includes("NOT a layout of")) fail("the network must disclose that it covers only the top values");

    // And back again, so the option is a toggle rather than a one-way door.
    elements.get("act-layout")?.click();
    await flush();
    if (rootEl.innerHTML.includes("Co-mention network")) fail("the layout toggle did not switch back");
  }

  // A different view must not inherit the previous one's options.
  await renderPayload(BASE);
  if (rootEl.innerHTML.includes("Co-mention network")) fail("view options leaked across a view change");

  // The CSV action only appears when the host advertised downloadFile — which
  // this harness did.
  {
    const call = await press("act-csv", "ui/download-file");
    if (call) {
      const text = call.params.contents[0]?.resource?.text ?? "";
      if (!text.startsWith("year,count")) fail(`CSV header is ${JSON.stringify(text.slice(0, 40))}`);
      if (!text.includes("2003,5")) fail("CSV is missing a data row");
      deliver({ jsonrpc: "2.0", id: call.id, result: {} });
      await flush();
      if (elements.get("act-csv")?.disabled || elements.get("act-csv")?.textContent !== "Download CSV")
        fail("successful CSV download left its action disabled or busy");
      const repeat = await press("act-csv", "ui/download-file");
      if (repeat) { deliver({ jsonrpc: "2.0", id: repeat.id, result: {} }); await flush(); }
    }
  }

  // The regressions below drive real SVG marks through the bundled app and
  // inspect the host protocol, including keyboard activation and stale calls.
  {
    const filters = {
      country: "Benin",
      date_from: "2000",
      keyword: "imam",
      exact: { language: ["Français"] },
      min_prob: 0.6,
    };
    await renderPayload({
      view: "topics",
      subset: "articles",
      filters,
      total_matches: 4,
      classified: 4,
      topics: [
        { topic_id: 7, label: "imam - mosquée - prière - a", count: 2 },
        { topic_id: 8, label: "imam - mosquée - prière - b", count: 2 },
      ],
    });
    const mark = rootEl.querySelector('[data-key="8"]');
    if (mark?.getAttribute("tabindex") !== "0") fail("topic mark missing or inaccessible");
    outbound.length = 0;
    const key = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
    key.key = "Enter";
    mark?.dispatchEvent(key);
    await flush();
    const call = take((m) => m.method === "tools/call");
    if (
      call?.params.arguments.exact?.topic_id?.[0] !== "8" ||
      call.params.arguments.keyword !== "imam" ||
      call.params.arguments.country !== "Benin" ||
      call.params.arguments.date_from !== "2000" ||
      call.params.arguments.exact?.min_prob?.[0] !== "0.6"
    )
      fail("topic activation lost its exact ID or parent scope");
    if (call) await answer(call, BASE);
    elements.get("act-back")?.click();
    await flush();
    if (!rootEl.querySelector('[data-key="8"]')) fail("Back lost the source chart");
  }
  {
    await renderPayload({
      view: "cooccurrence",
      subset: "articles",
      field: "spatial",
      filters: { country: "Benin", date_from: "2000" },
      values: [
        { value: "Lomé", count: 2 },
        { value: "Cotonou", count: 2 },
      ],
      matrix: [
        [2, 1],
        [1, 2],
      ],
    });
    outbound.length = 0;
    rootEl.querySelector('[data-key="Lomé"][data-key2="Cotonou"]')?.dispatchEvent(new dom.window.Event("click"));
    await flush();
    const call = take((m) => m.method === "tools/call");
    if (
      !call ||
      JSON.stringify(call.params.arguments.exact?.spatial) !== JSON.stringify(["Lomé", "Cotonou"]) ||
      call.params.arguments.country !== "Benin"
    )
      fail("co-occurrence did not intersect both exact values");
    if (call) await answer(call, BASE);
  }
  {
    await renderPayload({
      view: "lunar",
      subset: "images",
      filters: { country: "Togo" },
      total_matches: 6,
      distribution_by_group: { Togo: { "09": 4 }, Benin: { "09": 2 } },
      group_by: "country",
    });
    if (!rootEl.innerHTML.includes("6 placed") || rootEl.innerHTML.includes("No items"))
      fail("grouped lunar data disappeared");
    const call = await press("act-peak");
    if (
      call?.params.name !== "explore_corpus" ||
      call.params.arguments.subset !== "images" ||
      call.params.arguments.selection?.country !== "Togo"
    )
      fail("lunar peak lost subset or filters");
    if (call)
      await answer(call, {
        view: "records",
        mode: "items",
        subset: "images",
        filters: { country: "Togo" },
        total_matches: 1,
        rows: [{ id: "images:701", title: "Mosquée", url: "https://islam.zmo.de/s/afrique_ouest/item/701" }],
      });
    outbound.length = 0;
    rootEl.querySelector('[data-id="images:701"]')?.click();
    await flush();
    const read = take((m) => m.method === "tools/call");
    if (read?.params.name !== "fetch") fail("source list cannot open a reader");
    if (read)
      await answer(read, {
        id: "images:701",
        title: "Mosquée",
        text: "<script>not executable</script>",
        url: "https://islam.zmo.de/s/afrique_ouest/item/701",
        metadata: {},
      });
    if (!rootEl.querySelector(".source-text") || rootEl.querySelector("script"))
      fail("reader did not safely render source text");
  }
  {
    await renderPayload(BASE);
    const earlier = await press("act-gran"),
      later = await press("act-group");
    if (earlier && later) {
      await answer(later, { ...BASE, distribution: { 2004: 3 } });
      await answer(earlier, { ...BASE, distribution: { 1999: 9 } });
      if (!rootEl.innerHTML.includes("2004") || rootEl.innerHTML.includes("1999"))
        fail("stale response overwrote newer navigation");
    }
  }
  {
    await renderPayload({
      view: "coverage",
      subset: "articles",
      filters: { keyword: "islam" },
      source_field: "newspaper",
      total_matches: 3,
      rows: [{ source: "Le Pays", year: "2003", total: 3, fulltext: 2, embedded: 2, scored: 3 }],
    });
    const cell = rootEl.querySelector('[data-key="Le Pays"][data-key2="2003"]');
    outbound.length = 0;
    cell?.dispatchEvent(new dom.window.Event("click"));
    await flush();
    const call = take((m) => m.method === "tools/call");
    if (
      call?.params.arguments.selection?.exact?.newspaper?.[0] !== "Le Pays" ||
      call.params.arguments.selection.keyword !== "islam"
    )
      fail("coverage cell lost the selection");
    if (call) await answer(call, { error: "simulated unavailable source" }, true);
    if (!rootEl.querySelector("svg") || !rootEl.innerHTML.includes("simulated unavailable"))
      fail("failed source reading removed its chart");
  }

  {
    for (const [view, rowsKey, countKey, subset] of [["newspapers","newspapers","article_count","articles"],["periodicals","periodicals","issue_count","publications"]]) {
      await renderPayload({view,country_filter:"Benin",[rowsKey]:[{newspaper:"Same title",country:"Benin",[countKey]:3,earliest_year:2000,latest_year:2003}]});
      outbound.length=0; rootEl.querySelector(".hit[data-key]")?.dispatchEvent(new dom.window.Event("click")); await flush();
      const call=take(m=>m.method==="tools/call");
      if (call?.params.arguments.subset!==subset || call.params.arguments.country!=="Benin" || call.params.arguments.exact?.newspaper?.[0]!=="Same title") fail(`${view} lost exact outlet/country scope`);
      if (call) await answer(call,BASE);
    }
    await renderPayload({...BASE,filters:{exact:{spatial:["Cotonou","Lomé"]}}});
    if(rootEl.innerHTML.includes("[object Object]") || !rootEl.innerHTML.includes("Cotonou AND Lomé")) fail("exact filters are not readable in chips");
    const svg=await press("act-svg","ui/download-file");
    if(svg){const text=svg.params.contents[0].resource.text;if(!text.includes('xmlns="http://www.w3.org/2000/svg"') || !text.includes("<style>")) fail("SVG export is not standalone");deliver({jsonrpc:"2.0",id:svg.id,result:{}});await flush();}
  }
}
