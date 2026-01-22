# Quick Start with uv ⚡

The IWAC MCP Server is now set up with **uv** - the fastest Python package manager!

## ✅ Already Done

- ✓ `uv` installed (v0.9.26)
- ✓ Virtual environment created at `.venv`
- ✓ All dependencies installed
- ✓ Lock file created (`uv.lock`)

## 🚀 Quick Commands

### Run the MCP Server

```bash
uv run python -m iwac_mcp.server
```

### Run Tests

```bash
uv run pytest
uv run pytest -v  # verbose
```

### Code Formatting

```bash
uv run ruff check .
uv run ruff format .
```

## 📝 Before First Run

1. **Create `.env` file:**
   ```bash
   copy .env.example .env  # Windows
   # or
   cp .env.example .env    # macOS/Linux
   ```

2. **Edit `.env` with your credentials:**
   ```env
   OMEKA_BASE_URL=https://islam.zmo.de/api
   OMEKA_KEY_IDENTITY=your_key_identity_here
   OMEKA_KEY_CREDENTIAL=your_key_credential_here
   ```

3. **Test it works:**
   ```bash
   uv run python -m iwac_mcp.server
   ```

## 🔧 Common uv Commands

```bash
# Add a new dependency
uv add httpx

# Add a dev dependency
uv add --dev ruff

# Update all dependencies
uv sync

# Remove a dependency
uv remove package-name

# Run any Python command
uv run python script.py

# Run any installed tool
uv run pytest
uv run ruff
```

## 💡 Why uv is Better

- **10-100x faster** than pip for installation
- **No activation needed** - just use `uv run`
- **Automatic lock file** for reproducible builds
- **Better caching** - reuses downloads across projects
- **Integrated** - manages both Python and packages

## 🎯 VS Code Integration

VS Code is configured to use `.venv/Scripts/python.exe`.

**Select the interpreter:**
1. Press `Ctrl+Shift+P`
2. Type "Python: Select Interpreter"
3. Choose `.venv\Scripts\python.exe`

**Run/Debug:**
- Press `F5` to debug the MCP server
- Or use the integrated terminal with `uv run` commands

## 📚 Next Steps

1. Configure your Omeka S credentials in `.env`
2. Test the server: `uv run python -m iwac_mcp.server`
3. Run tests: `uv run pytest`
4. Configure Claude Desktop (see README.md)
5. Start querying the IWAC collection!

## 🆘 Troubleshooting

**Can't find uv?**
Add to PATH:
```bash
$env:Path = "C:\Users\frede\.local\bin;$env:Path"  # PowerShell
```

**Need to reinstall?**
```bash
uv sync --reinstall
```

**Clear cache?**
```bash
uv cache clean
```

---

📖 For more details, see:
- `README.md` - Full documentation
- `VSCODE_SETUP.md` - VS Code specific setup
- [uv documentation](https://docs.astral.sh/uv/)
