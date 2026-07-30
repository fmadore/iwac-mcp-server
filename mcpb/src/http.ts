// Remote Streamable HTTP transport for the IWAC MCP server.
//
// Activated by `node server/index.js --http`; the stdio transport in index.ts
// stays the default for Claude Desktop. `createMcpHandler` is the 2026-07-28
// HTTP entry point: it builds a fresh McpServer per request out of the factory,
// so there is still no per-session state to leak on a public, read-only server,
// and its default `legacy: "stateless"` posture keeps answering 2025-era
// clients from that same factory. (Hand-wiring a StreamableHTTPServerTransport,
// as this did under SDK v1, serves the legacy era only.) `responseMode: "json"`
// asks for an unstreamed reply, and the modern era honours it — but the SDK
// threads the option into its modern path only, so the legacy fallback it
// builds alongside always frames the reply as a single SSE event. A 2025-era
// client therefore gets `text/event-stream` where SDK v1's
// `enableJsonResponse: true` gave it a bare `application/json` body. The
// payload is identical either way and a spec-compliant client sends
// `Accept: application/json, text/event-stream` and reads both, so nothing
// breaks — but it is worth knowing if anything upstream ever buffers event
// streams. (For the same reason GET /mcp now answers 405 rather than opening
// a stream, which is spec-legal and which the official client handles.)
//
// A bearer token (config.bearerToken) gates every /mcp request; an
// unauthenticated GET /health is exposed for the container health check.
//
// TLS termination, rate limiting, and the public `/mcp` path mount are handled
// upstream by nginx — see docs/iwac-mcp-roadmap.md in the IWAC-docker repo.
// The SDK's localhostHostValidation/localhostOriginValidation guards are
// deliberately NOT mounted: they defend a loopback bind against DNS rebinding,
// and this process binds 0.0.0.0 behind nginx, where they would reject every
// legitimate public Host header.
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
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

  // One handler for the process; it builds a server per request from the factory.
  const mcpHandler = createMcpHandler(createServer, {
    responseMode: "json",
    onerror: (err) => console.error("[iwac] mcp handler error:", err),
  });
  const nodeHandler = toNodeHandler(mcpHandler, {
    onerror: (err) => console.error("[iwac] node adapter error:", err),
  });

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

    // Read and cap the body here rather than letting the adapter drain the
    // stream, so an oversized payload still gets a 413 instead of being
    // buffered whole. The parsed value is handed to the adapter as its
    // pre-parsed third argument, exactly as an Express body parser would.
    let body: unknown;
    if (req.method === "POST") {
      const raw = await readBody(req);
      body = raw.length ? JSON.parse(raw) : undefined;
    }

    await nodeHandler(req, res, body);
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

  // The handler owns the in-flight per-request instances now, so it has to be
  // closed alongside the listener for the container to stop cleanly.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.close();
      void mcpHandler.close().finally(() => process.exit(0));
    });
  }

  server.listen(port, () => {
    console.error(
      `[iwac] IWAC MCP server running on http://0.0.0.0:${port}/mcp ` +
        `(cache: ${config.cacheDir}, semantic: ${config.semanticSearchEnabled})`,
    );
  });
}
