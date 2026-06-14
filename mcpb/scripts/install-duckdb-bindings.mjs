// Ensure every supported-platform DuckDB binding is present in node_modules so the
// per-OS .mcpb bundles can be packed offline. Claude Desktop is macOS/Windows only,
// so only those four bindings (darwin/win32 × x64/arm64) are fetched — see
// optionalDependencies in package.json. Linux is intentionally not shipped.
import { ensureBindings, supportedBindings } from "./duckdb-bindings.mjs";

const names = Object.keys(supportedBindings());
if (names.length === 0) {
  console.error("no @duckdb/node-bindings-* in optionalDependencies");
  process.exit(1);
}

ensureBindings(names);
console.error(
  `ensured ${names.length} platform bindings: ` +
    names.map((n) => n.replace("@duckdb/node-bindings-", "")).join(", "),
);
