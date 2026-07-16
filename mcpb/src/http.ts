// Remote Streamable HTTP transport for the IWAC MCP server.
//
// Activated by `node server/index.js --http`; the stdio transport in index.ts
// stays the default for Claude Desktop. Stateless JSON mode (sessionIdGenerator:
// undefined, enableJsonResponse: true) — a fresh McpServer + transport per
// request, so there is no per-session state to leak on a public, read-only
// server. A bearer token (config.bearerToken) gates every /mcp request; an
// unauthenticated GET /health is exposed for the container health check.
//
// TLS termination, rate limiting, and the public `/mcp` path mount are handled
// upstream by nginx — see docs/iwac-mcp-roadmap.md in the IWAC-docker repo.
import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "./config.js";

/** Cap on request body size — MCP JSON-RPC payloads are tiny; larger is abuse. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Tagged error so the catch-all can answer 413 instead of a generic parse error. */
class BodyTooLargeError extends Error {
  constructor() {
    super("Request body too large");
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", function onData(chunk: Buffer) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop consuming (backpressure bounds memory) but do NOT destroy the
        // socket here — the response side still has to deliver the 413; the
        // `Connection: close` on that response tears the connection down.
        req.removeListener("data", onData);
        req.pause();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** JSON-RPC error envelope (id null — these are pre-dispatch transport errors). */
function rpcError(code: number, message: string) {
  return { jsonrpc: "2.0" as const, error: { code, message }, id: null };
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}

export function startHttpServer(createServer: () => McpServer): void {
  const { httpPort: port, bearerToken: token } = config;
  if (!token) {
    console.error(
      "[iwac] FATAL: HTTP mode requires a bearer token. Set IWAC_MCP_BEARER_TOKEN or mount a " +
        "secret at /run/secrets/iwac_mcp_token (override the path with IWAC_MCP_TOKEN_FILE). " +
        "Refusing to start an unauthenticated public endpoint.",
    );
    process.exit(1);
  }
  // Compare SHA-256 digests so the check is constant-time regardless of how
  // much of the token an attacker guessed (timingSafeEqual needs equal lengths).
  const expectedDigest = createHash("sha256").update(`Bearer ${token}`).digest();
  const authorized = (header: string | undefined): boolean =>
    typeof header === "string" &&
    timingSafeEqual(createHash("sha256").update(header).digest(), expectedDigest);

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0];

    // Unauthenticated health check for the container/orchestrator.
    if (req.method === "GET" && (path === "/health" || path === "/healthz")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    if (path !== "/mcp" && path !== "/mcp/") {
      sendJson(res, 404, rpcError(-32601, "Not found — POST JSON-RPC to /mcp"));
      return;
    }

    if (!authorized(req.headers.authorization)) {
      sendJson(res, 401, rpcError(-32001, "Unauthorized"), { "WWW-Authenticate": "Bearer" });
      return;
    }

    let body: unknown;
    if (req.method === "POST") {
      const raw = await readBody(req);
      body = raw.length ? JSON.parse(raw) : undefined;
    }

    // Stateless: one server + transport per request (no session id).
    const mcp = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) {
        // Mid-write failure: nothing coherent can be sent — close the socket
        // instead of leaving the client hanging until its own timeout.
        res.destroy();
      } else if (err instanceof BodyTooLargeError) {
        sendJson(res, 413, rpcError(-32600, "Request body too large"), { Connection: "close" });
      } else {
        sendJson(res, 400, rpcError(-32700, `Parse error: ${(err as Error).message}`));
      }
    });
  });

  server.listen(port, () => {
    console.error(
      `[iwac] IWAC MCP server running on http://0.0.0.0:${port}/mcp ` +
        `(cache: ${config.cacheDir}, semantic: ${config.semanticSearchEnabled})`,
    );
  });
}
