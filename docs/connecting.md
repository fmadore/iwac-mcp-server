# Connecting to the IWAC research assistant

The [Islam West Africa Collection (IWAC)](https://islam.zmo.de/s/westafrica/) is
available as a **Model Context Protocol (MCP) server** — a read-only research
interface that lets an AI assistant search and analyse the collection directly:
~12,000 newspaper articles, 1,500 Islamic publications, 4,700 authority records
(persons, places, organisations, events, subjects), 860+ academic references,
plus archival documents and audiovisual materials from Benin, Burkina Faso,
Côte d'Ivoire, Niger, Nigeria, and Togo.

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

### 2. Add the research skill — strongly recommended

The optional **`iwac-mcp` skill** teaches Claude *how* to use the tools well: a
structured research workflow, a francophone search strategy, source citations
with confidence grading, and awareness of the collection's gaps. With it, Claude
chooses the right tool and search terms on the first pass and returns a cited
synthesis instead of a raw data dump.

Download `iwac-mcp-skill.zip` from the same release, then in Claude Desktop open
**Customize → Skills → + → Create skill → Upload a skill** and select the zip.

### Optional: semantic search

Twenty-five tools work out of the box. Two extra tools find articles and
publications by *meaning* rather than keywords; they need a free Google/Gemini
API key and are **off by default**. To enable them, turn on **Enable semantic search** in the
extension's settings and paste a key from
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
