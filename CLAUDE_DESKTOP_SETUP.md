# Claude Desktop Setup Complete! ✅

## What I Did

Updated your Claude Desktop configuration file at:
`C:\Users\frede\AppData\Roaming\Claude\claude_desktop_config.json`

Added the IWAC MCP server with your credentials.

## Next Steps

### 1. Restart Claude Desktop

**Close and reopen the Claude Desktop app completely.**

### 2. Verify the Connection

After reopening Claude Desktop:

1. Look for the **🔌 icon** in the bottom-right corner of the chat window
2. Click it to see available MCP servers
3. You should see **"iwac"** listed with 7 tools:
   - `search_articles`
   - `get_article`
   - `search_index`
   - `get_index_entry`
   - `list_subjects`
   - `list_locations`
   - `get_collection_stats`

### 3. Test the Server

Try asking Claude in the Desktop app:

**Example queries:**

```
"What articles are in the IWAC collection? Show me statistics."

"Find articles about Cheikh Ibrahima Niass"

"Search for articles about mosques in Senegal"

"List the most common subjects in the collection"

"Show me articles from Fraternité Matin newspaper"

"What are the geographic locations covered in the collection?"
```

## Troubleshooting

### ❌ Server not showing up?

1. **Check the logs:**
   - Windows: `%APPDATA%\Claude\logs\mcp*.log`

2. **Verify uv is in PATH:**
   Open PowerShell and run:
   ```powershell
   uv --version
   ```

   If not found, add to PATH:
   ```powershell
   $env:Path = "C:\Users\frede\.local\bin;$env:Path"
   ```

3. **Test manually:**
   ```bash
   cd C:\Users\frede\GitHub\iwac-mcp-server
   uv run python -m iwac_mcp.server
   ```

### ❌ Connection errors?

Check that your `.env` file has the correct credentials:
```bash
C:\Users\frede\GitHub\iwac-mcp-server\.env
```

### ❌ Tools not working?

The server needs internet access to connect to `islam.zmo.de`.
Check your firewall settings.

## Configuration Details

**Server name:** `iwac`

**Command:** Uses `uv` to run the Python MCP server

**Working directory:** `C:\Users\frede\GitHub\iwac-mcp-server`

**Environment variables:** API credentials for Omeka S

## What Claude Can Do Now

Claude can now:
- ✅ Search 11,500+ newspaper articles about Islam in West Africa
- ✅ Browse index entries (persons, places, organizations, subjects, events)
- ✅ Get detailed article information including OCR text
- ✅ Filter by newspaper, location, subject, date range
- ✅ Get collection statistics

## Example Use Cases

1. **Research queries:**
   - "Find all articles mentioning [person/place/topic]"
   - "What did [newspaper] write about [subject]?"

2. **Data exploration:**
   - "What are the most discussed topics in the collection?"
   - "Which locations are most frequently mentioned?"

3. **Specific articles:**
   - "Show me the full text of article ID 12345"
   - "What articles were published in December 2018?"

## Success Indicators

You'll know it's working when:
- 🔌 The MCP icon shows "iwac" server as connected
- 📊 Claude can answer questions about the IWAC collection
- 🔍 Claude uses the MCP tools (you'll see tool calls in the response)

---

**Need help?** Check the logs or run the test script:
```bash
cd C:\Users\frede\GitHub\iwac-mcp-server
uv run python test_mcp_server.py
```
