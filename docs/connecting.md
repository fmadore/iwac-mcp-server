# Connecting to the IWAC research assistant

The [Islam West Africa Collection (IWAC)](https://islam.zmo.de/s/westafrica/) is
available as a **Model Context Protocol (MCP) server** — a read-only research
interface that lets an AI assistant search and analyse the collection directly:
~12,000 newspaper articles, 1,500 Islamic publications, 4,700 authority records
(persons, places, organisations, events, subjects), 860+ academic references,
plus archival documents, audiovisual recordings and fieldwork photographs from
Benin, Burkina Faso, Côte d'Ivoire, Niger, Nigeria, and Togo.

There are two ways to connect, depending on which assistant you use:

- **[Claude Desktop](#claude-desktop)** — a one-click install. *Recommended for
  most users:* it is free, runs on your own machine, and includes the full
  toolset plus an optional research skill.
- **[ChatGPT](#chatgpt)** — connect to the hosted endpoint as a custom
  connector. Requires a paid ChatGPT plan.

Other MCP clients (Claude Code, IDE integrations, custom agents) can use the
same hosted Streamable-HTTP endpoint, `https://islam.zmo.de/mcp/`, with no
authentication.

Both connections are **read-only**. They never change the collection — they only
search and read it. All matching is accent- and case-insensitive, and every
result links back to the canonical record on `islam.zmo.de`.

---

## Claude Desktop

A one-click install. No Python, no command line — the bundle ships its own Node
runtime and database engine.

### 1. Install the server

1. Open the
   [**Releases** page](https://github.com/fmadore/iwac-mcp-server/releases) and
   download the bundle for your operating system:

   | Your OS                              | Download                       |
   | ------------------------------------ | ------------------------------ |
   | Windows (Intel/AMD or Snapdragon)    | `iwac-mcp-server-windows.mcpb` |
   | macOS (Apple Silicon or Intel)       | `iwac-mcp-server-macos.mcpb`   |

2. **Double-click** the downloaded `.mcpb` file. Claude Desktop opens an install
   dialog showing the extension's details.
   *Alternatively:* in Claude Desktop go to **Settings → Extensions** and drag
   the file onto the page (or **Advanced settings → Install Extension…** and
   select the file).
3. Review the details and click **Install**, then confirm.

There is no Linux bundle, because Claude Desktop itself is not available on Linux.

**First run:** the first time you use a tool, the server downloads ~250 MB of
data from Hugging Face into `~/.iwac-mcp/cache/` (you can change this folder in
the extension's settings). After that, queries are fast and fully local.

### Upgrading to a newer release

Install the new `.mcpb` the same way — but **quit Claude Desktop completely
first**, and reopen it afterwards.

This matters on Windows in particular. Claude Desktop loads the extension's
database engine (`duckdb.dll`) into its own process, and Windows will not let
an installer delete a DLL that is mapped into a running process. Installing
over a version that is still loaded fails with:

```
EPERM: operation not permitted, unlink '…\node_modules\@duckdb\…\duckdb.dll'
```

Closing the window is not enough — Claude Desktop keeps running in the
notification area. Quit it from the tray icon (or end the `claude.exe` tree in
Task Manager), check no `claude.exe` remains, then install.

If you already hit the error, the extension folder is left half-removed (its
`manifest.json` is gone but the DLL remains), so delete it before retrying:

```powershell
Remove-Item -Recurse -Force "$env:APPDATA\Claude\Claude Extensions\local.mcpb.*.iwac-mcp-server"
```

Your downloaded data is **not** affected — the cache lives in `~/.iwac-mcp/`,
outside the extension folder, so a reinstall does not re-download it.

### 2. Add the research skill — strongly recommended

The optional **`iwac-mcp` skill** teaches Claude *how* to use the tools well: a
structured research workflow, a francophone search strategy, source citations
with confidence grading, and awareness of the collection's gaps. With it, Claude
chooses the right tool and search terms on the first pass and returns a cited
synthesis instead of a raw data dump.

Download `iwac-mcp-skill.zip` from the same release, then in Claude Desktop open
**Customize → Skills → + → Create skill → Upload a skill** and select the zip.

This is the supported way to add the skill, and the one to use. An installed
skill is matched against your question automatically, before any tool runs.

<details>
<summary>Prototype: the server also serves the skill as <code>skill://</code> resources</summary>

Recent builds embed the skill and expose it as MCP resources:
`skill://iwac-mcp/SKILL.md`, its four `skill://iwac-mcp/references/…` files, and
a `skill://iwac-mcp` catalogue listing them with SHA-256 digests. A client that
has not installed the skill can read it from the server instead. Nothing is
loaded until something asks for it.

A host that implements the draft extension can also discover the same catalogue
through its `skills/list` / `skills/get` methods, which the server declares via
the `io.modelcontextprotocol/skills` capability.

**This is a prototype and may change or disappear.** It tracks
[SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640),
a draft proposal that has not been accepted. Nothing about it is guaranteed
between releases. Install the `.zip` above and treat this as a fallback, not a
feature.

</details>

### Optional: semantic search

Twenty-seven tools work out of the box. Three extra tools find articles,
publications and photographs by *meaning* rather than keywords — the photo
search is cross-modal, so you can describe what an image shows. They need a free
Google/Gemini API key and are **off by default**. To enable them, turn on
**Enable semantic search** in the extension's settings and paste a key from
[Google AI Studio](https://aistudio.google.com/apikey). Most users don't need this.

---

## ChatGPT

The IWAC server is also hosted as a remote endpoint that you can add to ChatGPT
as a **custom connector**:

```
https://islam.zmo.de/mcp/
```

**Requirements**

- A paid ChatGPT plan — **Plus, Pro, Business, Enterprise, or Edu** — using
  ChatGPT **on the web** (`chatgpt.com`).
- The connector is **read-only** and needs **no login and no API key**.

ChatGPT offers two ways to use a custom MCP server. Most people will want
**Developer mode**.

### Option A — Developer mode (full toolset)

Developer mode gives ChatGPT access to all of the IWAC research tools.

1. **Enable Developer mode.** Open **Settings → Apps & Connectors → Advanced
   settings** and switch on **Developer mode**.
   *(Depending on your account this section may be labelled simply "Apps" or
   "Connectors".)*
2. **Add the connector.** Back on **Apps & Connectors**, click **Create** (shown
   as **Create app** in some accounts) and fill in:
   - **Name:** `IWAC` (or "Islam West Africa Collection")
   - **MCP Server URL:** `https://islam.zmo.de/mcp/`
   - **Authentication:** **No authentication**
   - **Description** *(optional):* "Read-only search of the Islam West Africa
     Collection."
3. **Save.** ChatGPT connects to the server and lists its available tools.
4. **Use it in a chat.** In the message box, open the **+ (plus) menu →
   Developer mode** and tick the **IWAC** app. Then ask your question. For
   reliable results, name the connector explicitly — e.g. *"Using the IWAC
   connector, find press coverage of…"*.

Every IWAC tool is marked **read-only**, so ChatGPT will not ask you to confirm
"write" actions — there are none.

### Option B — Deep research

ChatGPT's **deep research** mode can use the same connector, but in that mode it
relies on just the two tools deep research supports: **`search`** (find relevant
items) and **`fetch`** (read one item in full). The IWAC server provides both,
returning titles and canonical `islam.zmo.de` links that deep research cites in
its report. Add the connector as in Option A, then select it as a source when you
start a deep research run.

### Getting the research workflow without the skill

The `.zip` skill is a Claude Desktop / Claude Code feature; there is nothing to
install in ChatGPT. Two things carry the same guidance to a connector:

- **Prompts.** The server publishes `iwac_research` and `iwac_overview`, which
  mirror the skill's workflow. Use these; they are the supported route.
- **`skill://` resources (prototype).** The server also exposes the skill itself
  as MCP resources. Whether you can reach them depends on the client's support
  for reading resources, and the interface is experimental. See the note under
  [Add the research skill](#2-add-the-research-skill--strongly-recommended).

Failing both, asking for "a cited synthesis, searching in French" gets you most
of the way.

---

## What you can ask

Once connected — in either app — try questions such as:

- "How did the Béninois press cover Tabaski (Aïd al-Adha)?"
- "Compare newspaper coverage of Islam across Côte d'Ivoire, Burkina Faso, and Benin."
- "Find academic references on Izala in Niger, in both French and English."
- "What is the overall sentiment of articles mentioning a given public figure, and how does it change over time?"
- "Summarise what the collection holds on the debates over the veil in schools in the 1990s."

With the research skill installed in Claude Desktop you can simply ask the
question — Claude plans the searches for you.

---

## Good to know

- **Read-only and public.** Both connections only ever read the collection, which
  is already openly published; they cannot change anything.
- **Languages.** Most newspaper sources are in French; academic references are in
  French and English. Ask in either language.
- **Always check the source.** Every result links to the original record on
  `islam.zmo.de`.
- **Coverage is uneven.** The collection varies by country, period, and topic;
  read counts as "what IWAC holds", not "what exists".
- **Only add connectors you trust.** This one is read-only and maintained by the
  collection's editor, but it is good general practice with any MCP server.

---

*Questions or problems? Open an issue at*
[*github.com/fmadore/iwac-mcp-server/issues*](https://github.com/fmadore/iwac-mcp-server/issues).
