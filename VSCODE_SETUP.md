# VS Code Setup Guide for IWAC MCP Server

## Installation Complete ✓ (with uv)

The project has been set up with `uv` - a fast Python package manager!
- Virtual environment: `.venv`
- All dependencies installed
- Python 3.12.10 configured

## VS Code Configuration

### 1. Select Python Interpreter

1. Open the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P` on Mac)
2. Type "Python: Select Interpreter"
3. Choose the interpreter from your `venv` folder:
   ```
   .\venv\Scripts\python.exe
   ```

### 2. Configure Environment Variables

1. Create a `.env` file in the project root (copy from `.env.example`):
   ```bash
   copy .env.example .env
   ```

2. Edit `.env` and add your Omeka S credentials:
   ```env
   OMEKA_BASE_URL=https://islam.zmo.de/api
   OMEKA_KEY_IDENTITY=your_actual_key_identity
   OMEKA_KEY_CREDENTIAL=your_actual_key_credential
   ```

### 3. Install VS Code Extensions (Recommended)

- **Python** (by Microsoft) - Already installed if you see the interpreter selector
- **Pylance** (by Microsoft) - Enhanced Python language support
- **Ruff** - Fast Python linter and formatter

### 4. VS Code Settings

Create or update `.vscode/settings.json`:

```json
{
  "python.defaultInterpreterPath": "${workspaceFolder}/venv/Scripts/python.exe",
  "python.terminal.activateEnvironment": true,
  "python.analysis.typeCheckingMode": "basic",
  "[python]": {
    "editor.defaultFormatter": "charliermarsh.ruff",
    "editor.formatOnSave": true,
    "editor.codeActionsOnSave": {
      "source.organizeImports": "explicit"
    }
  },
  "ruff.lineLength": 100
}
```

## Running the MCP Server

### Option 1: Using uv (Recommended)

Open the integrated terminal (`Ctrl+\`` or View > Terminal) and run:

```bash
# uv automatically uses the .venv
uv run python -m iwac_mcp.server
```

### Option 2: With activated virtual environment

```bash
# Activate the venv first (if not auto-activated)
.\.venv\Scripts\activate  # Windows
# or
source .venv/bin/activate  # macOS/Linux

# Then run
python -m iwac_mcp.server
```

### Option 2: With Claude Desktop

See the main README.md for Claude Desktop configuration.

### Option 3: Debug Configuration

Create `.vscode/launch.json` for debugging:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Python: MCP Server",
      "type": "debugpy",
      "request": "launch",
      "module": "iwac_mcp.server",
      "console": "integratedTerminal",
      "envFile": "${workspaceFolder}/.env"
    }
  ]
}
```

Then press `F5` to start debugging.

## Running Tests

In the VS Code terminal:

```bash
# With uv (recommended)
uv run pytest
uv run pytest -v
uv run pytest tests/test_tools.py

# Or activate venv first, then:
pytest
pytest -v
pytest tests/test_tools.py
```

## Code Formatting

```bash
# With uv
uv run ruff check .
uv run ruff check --fix .
uv run ruff format .

# Or with activated venv
ruff check .
ruff format .
```

## uv Commands (Fast & Convenient)

```bash
# Add a new dependency
uv add package-name

# Add a dev dependency
uv add --dev package-name

# Update dependencies
uv sync

# Run any command in the venv
uv run python script.py
uv run pytest

# Run the MCP server
uv run python -m iwac_mcp.server
```

### Why uv?
- ⚡ **10-100x faster** than pip
- 🔒 **Automatic lock file** (uv.lock)
- 🎯 **No activation needed** - just `uv run`
- 📦 **Better dependency resolution**

## Useful VS Code Shortcuts

- `Ctrl+Shift+P` - Command Palette
- `Ctrl+\`` - Toggle Terminal
- `F5` - Start Debugging
- `Shift+Alt+F` - Format Document
- `Ctrl+Shift+F` - Search in Files
- `F12` - Go to Definition
- `Alt+Shift+F12` - Find All References

## Project Structure in VS Code

```
iwac-mcp-server/
├── .vscode/               # VS Code settings (create this)
│   ├── settings.json      # Workspace settings
│   └── launch.json        # Debug configurations
├── src/iwac_mcp/          # Main package
│   ├── server.py          # MCP server tools
│   └── omeka_client.py    # Omeka S API client
├── tests/                 # Test files
├── venv/                  # Virtual environment (don't commit)
├── .env                   # Your credentials (don't commit)
├── .env.example           # Template for credentials
├── pyproject.toml         # Project configuration
└── README.md              # Main documentation
```

## Troubleshooting

### Virtual environment not activating in terminal?

Manually activate it:
```bash
# PowerShell
.\venv\Scripts\Activate.ps1

# Command Prompt
.\venv\Scripts\activate.bat

# Git Bash
source venv/Scripts/activate
```

### Import errors?

Make sure you've selected the correct Python interpreter (see Step 1).

### Can't find Python modules?

Reload the window: `Ctrl+Shift+P` → "Developer: Reload Window"

## Next Steps

1. ✅ Virtual environment created
2. ✅ Dependencies installed
3. ⏳ Create `.env` file with your credentials
4. ⏳ Select Python interpreter in VS Code
5. ⏳ Test the server with `python -m iwac_mcp.server`
6. ⏳ Run tests with `pytest`

Happy coding! 🚀
