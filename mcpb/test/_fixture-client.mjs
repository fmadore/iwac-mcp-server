import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Run a test with offline clients that are closed even when an assertion throws. */
export async function withFixtureScope(run) {
  const sessions = new Set();
  const scope = {
    async connect({ name, cacheDir = "fixtures", clientOptions, stderr = "inherit" }) {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(root, "server", "index.js")],
        stderr,
        env: {
          ...process.env,
          IWAC_CACHE_DIR: path.isAbsolute(cacheDir) ? cacheDir : path.join(root, "test", cacheDir),
          IWAC_OFFLINE: "1",
          IWAC_SEMANTIC_SEARCH_ENABLED: "false",
        },
      });
      const client = new Client({ name, version: "0.0.0" }, clientOptions);
      let closing;
      const session = {
        client,
        close() {
          closing ??= (async () => {
            try {
              await client.close();
            } finally {
              await transport.close();
              sessions.delete(session);
            }
          })();
          return closing;
        },
      };
      sessions.add(session);
      // Register before connecting: failed handshakes also need cleanup.
      await client.connect(transport);
      return session;
    },
  };
  let value;
  const errors = [];
  try {
    value = await run(scope);
  } catch (err) {
    errors.push(err);
  } finally {
    const results = await Promise.allSettled([...sessions].reverse().map((session) => session.close()));
    errors.push(...results.filter((r) => r.status === "rejected").map((r) => r.reason));
  }
  // Preserve the test failure, including when cleanup also failed.
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Fixture test or cleanup failed");
  return value;
}
