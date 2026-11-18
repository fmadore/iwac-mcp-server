import { activeQueries, queuedQueries } from "./db.js";
import { requestMetrics, stopSharedWork } from "./request.js";
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
// unauthenticated GET /health is exposed for the container health check, and
// an unauthenticated GET /mcp/server-card serves the public Server Card
// (SEP-2127, see serverCard.ts).
//
// TLS termination, rate limiting, and the public `/mcp` path mount are handled
// upstream by nginx — see docs/iwac-mcp-roadmap.md in the IWAC-docker repo.
// The SDK's localhostHostValidation/localhostOriginValidation guards are not
// suitable for this public 0.0.0.0 bind: they would reject nginx's legitimate
// public Host. Instead, requests that carry Origin are checked against the
// exact IWAC_MCP_ALLOWED_ORIGINS allowlist below, as required by the Streamable
// HTTP specification. Server-to-server clients normally omit Origin.
//
// CORS: passing the Origin check is not enough for a browser, which also needs
// the response to name the origin and needs a preflight answered. So for /mcp
// an allowed origin (allowlisted, loopback, or any with the `*` opt-in) gets:
// an `OPTIONS` preflight answered 204 BEFORE the bearer check (a preflight
// never carries Authorization), and `Access-Control-Allow-Origin`,
// `Vary: Origin` and `Access-Control-Expose-Headers` on every actual response,
// the SDK's and this file's own errors alike. A disallowed origin keeps its
// 403 with no CORS headers. `Access-Control-Allow-Credentials` is never sent:
// the endpoint authenticates by bearer token, never by cookie. If nginx in
// front adds CORS headers of its own, one of the two must stop, or browsers
// reject the duplicated `Access-Control-Allow-Origin`.
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { config, isLoopbackOrigin } from "./config.js";
import { warmEncoder } from "./onnxEncoder.js";
import {
  etagMatches,
  SERVER_CARD_MEDIA_TYPE,
  SERVER_CARD_PATH,
  type ServedServerCard,
  serverCardFromEnv,
} from "./serverCard.js";

/** Methods a browser may use on /mcp. POST carries every MCP message, and GET
 * is listed so a client probing for a 2025-era event stream reads the
 * handler's 405 instead of failing the preflight. DELETE ends a session, and
 * this stateless server never issues one. */
const CORS_ALLOW_METHODS = "POST, GET, OPTIONS";

/** Request headers the Streamable HTTP transport (2026-07-28) and the SDK's
 * client send. Listed rather than echoed from Access-Control-Request-Headers,
 * so the preflight states the contract instead of approving anything asked.
 * No tool declares an `x-mcp-header` parameter, so no `Mcp-Param-*` header
 * can be sent. */
const CORS_ALLOW_HEADERS =
  "Content-Type, Authorization, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Mcp-Method, Mcp-Name, Last-Event-ID";

/** Response headers a browser client must be able to read: the protocol and
 * session headers, and the 401 challenge an OAuth-aware client inspects. */
const CORS_EXPOSE_HEADERS = "Mcp-Protocol-Version, Mcp-Session-Id, WWW-Authenticate";

/** How long a browser may cache a preflight (Chromium caps it at 2 hours). */
const CORS_MAX_AGE_SECONDS = "7200";

/** Cap on request body size — MCP JSON-RPC payloads are tiny; larger is abuse. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** How long a SIGTERM waits for in-flight requests before exiting anyway. */
const SHUTDOWN_GRACE_MS = 8_000;

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

function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}

/** CORS for the Server Card, exactly as ext-server-card's docs/discovery.md
 * prescribes. Unlike /mcp it is `*` for every caller, allowlisted or not: the
 * card is the same public, read-only document for everyone, carries nothing a
 * token or session could change, and is meant to be fetched by any page that
 * wants to discover the server. If-None-Match is the one non-safelisted
 * request header (it makes a revalidation preflight), and ETag must be
 * exposed for a browser to send it back. */
const CARD_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET",
  "Access-Control-Allow-Headers": "Content-Type, If-None-Match",
  "Access-Control-Expose-Headers": "ETag",
} as const;

/** The card changes only with a release or a redeploy, so an hour (the spec's
 * own example) costs a client at most one stale hour, and the ETag makes the
 * revalidation after it a body-less 304. */
const CARD_CACHE_CONTROL = "public, max-age=3600";

/** Answer GET, HEAD and OPTIONS on the card path; anything else is a 405. */
function serveServerCard(req: http.IncomingMessage, res: http.ServerResponse, served: ServedServerCard): void {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...CARD_CORS_HEADERS, "Access-Control-Max-Age": CORS_MAX_AGE_SECONDS });
    res.end();
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "Use GET" }, { ...CARD_CORS_HEADERS, Allow: "GET, HEAD, OPTIONS" });
    return;
  }
  const headers = {
    ...CARD_CORS_HEADERS,
    "Cache-Control": CARD_CACHE_CONTROL,
    ETag: served.etag,
  };
  if (etagMatches(req.headers["if-none-match"], served.etag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, {
    ...headers,
    "Content-Type": SERVER_CARD_MEDIA_TYPE,
    "Content-Length": String(Buffer.byteLength(served.body)),
    "X-Content-Type-Options": "nosniff",
  });
  res.end(req.method === "HEAD" ? undefined : served.body);
}

export function startHttpServer(createServer: () => McpServer): void {
  const {
    httpPort: port,
    bearerToken: token,
    httpAllowedOrigins: allowedOrigins,
    httpAnyOrigin: anyOrigin,
    invalidHttpOrigins,
  } = config;
  if (invalidHttpOrigins.length > 0) {
    console.error(
      `[iwac] FATAL: IWAC_MCP_ALLOWED_ORIGINS contains invalid origins: ${invalidHttpOrigins.join(", ")}. ` +
        "Use comma-separated HTTP(S) origins without paths, queries, fragments, credentials, or wildcards, " +
        "or `*` on its own to allow every origin.",
    );
    process.exit(1);
  }
  // `*` lets any web page call the endpoint from a visitor's browser. Over the
  // public mirror that only exposes what is public anyway. Over the private
  // mirror it would let any page read restricted text through a visitor whose
  // requests reach the endpoint with the token added on the way (an nginx
  // that injects it), so the two never go together.
  if (anyOrigin && config.privateDataset) {
    console.error(
      "[iwac] FATAL: IWAC_MCP_ALLOWED_ORIGINS=* would let any web page read the restricted full text of " +
        `${config.datasetRepo} through a visitor's browser. List the trusted origins instead.`,
    );
    process.exit(1);
  }
  if (!token) {
    console.error(
      "[iwac] FATAL: HTTP mode requires a bearer token. Set IWAC_MCP_BEARER_TOKEN or mount a " +
        "secret at /run/secrets/iwac_mcp_token (override the path with IWAC_MCP_TOKEN_FILE). " +
        "Refusing to start an unauthenticated public endpoint.",
    );
    process.exit(1);
  }
  // Everyone who can reach this endpoint can read whatever it serves, and the
  // shared deployment is public. One stray IWAC_PRIVATE_DATASET in a compose
  // file must not publish the restricted full text, so it takes a second flag.
  if (config.privateDataset && !config.allowPrivateHttp) {
    console.error(
      `[iwac] FATAL: IWAC_PRIVATE_DATASET is set, which would serve the restricted full text of ` +
        `${config.datasetRepo} to every client of this endpoint. Set IWAC_ALLOW_PRIVATE_HTTP=true ` +
        "as well if that is intended.",
    );
    process.exit(1);
  }
  // Built once: every field is fixed for the life of the process. A malformed
  // IWAC_MCP_PUBLIC_URL would publish a broken endpoint to every client that
  // discovers the server, so it stops the start like the other URL settings.
  const { served: serverCard, invalidPublicUrl } = serverCardFromEnv();
  if (invalidPublicUrl !== undefined) {
    console.error(
      `[iwac] FATAL: IWAC_MCP_PUBLIC_URL is not a usable public endpoint: ${invalidPublicUrl}. ` +
        "Use the absolute http(s) URL clients connect to (for example https://islam.zmo.de/mcp), " +
        "without credentials, a query or a fragment, or leave it unset to publish a card without remotes.",
    );
    process.exit(1);
  }
  // Compare SHA-256 digests so the check is constant-time regardless of how
  // much of the token an attacker guessed (timingSafeEqual needs equal lengths).
  const expectedDigest = createHash("sha256").update(`Bearer ${token}`).digest();
  const authorized = (header: string | undefined): boolean =>
    typeof header === "string" && timingSafeEqual(createHash("sha256").update(header).digest(), expectedDigest);

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

    // The Server Card is public metadata, so it skips the bearer check (a
    // client reads it before it has any credentials) and, unlike /mcp, the
    // Origin allowlist too: the spec requires `Access-Control-Allow-Origin: *`
    // on it, and the DNS-rebinding risk the allowlist guards against does not
    // arise for a static document that is identical for every caller and
    // holds nothing beyond what the public MCP Registry entry already shows.
    if (path === SERVER_CARD_PATH) {
      serveServerCard(req, res, serverCard);
      return;
    }

    if (path !== "/mcp" && path !== "/mcp/" && path !== "/metrics") {
      sendJson(res, 404, rpcError(-32601, "Not found — POST JSON-RPC to /mcp"));
      return;
    }

    // Browsers always send Origin on cross-origin fetches. An absent header is
    // normal for server-to-server MCP clients; a present one must be explicitly
    // trusted, or be a loopback page (a browser sets Origin itself, so only a
    // page served from this machine can claim one; the AMIRA server and the MCP
    // conformance suite expect local development clients to connect). Never
    // reflect it or fall back to Host — either would defeat the DNS-rebinding
    // protection this check exists to provide.
    const origin = req.headers.origin;
    if (origin !== undefined && !anyOrigin && !allowedOrigins.has(origin) && !isLoopbackOrigin(origin)) {
      sendJson(res, 403, rpcError(-32000, "Forbidden: Origin is not allowed"), {
        Vary: "Origin",
      });
      return;
    }

    if (origin !== undefined && path !== "/metrics") {
      // Set before any response is written: sendJson and the SDK adapter both
      // pass an object to writeHead, which merges these in.
      res.setHeader("Access-Control-Allow-Origin", anyOrigin ? "*" : origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Expose-Headers", CORS_EXPOSE_HEADERS);
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Methods": CORS_ALLOW_METHODS,
          "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
          "Access-Control-Max-Age": CORS_MAX_AGE_SECONDS,
        });
        res.end();
        return;
      }
    }

    if (!authorized(req.headers.authorization)) {
      sendJson(res, 401, rpcError(-32001, "Unauthorized"), { "WWW-Authenticate": "Bearer" });
      return;
    }

    if (path === "/metrics") {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "Use GET" });
        return;
      }
      sendJson(res, 200, {
        active_queries: activeQueries(),
        queued_queries: queuedQueries(),
        requests: requestMetrics(),
      });
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
      } else if (err instanceof SyntaxError) {
        // JSON.parse messages may echo attacker-controlled request fragments;
        // return the stable JSON-RPC wording and keep those details out of the
        // response. The request body itself is enough for local diagnostics.
        sendJson(res, 400, rpcError(-32700, "Parse error"));
      } else {
        console.error("[iwac] HTTP request error:", err);
        sendJson(res, 500, rpcError(-32603, "Internal error"));
      }
    });
  });

  // Drain, then exit: stop accepting connections, let the requests already in
  // flight finish, and only then close the handler that owns their
  // per-request server instances. Exiting as soon as the handler closed, as
  // this used to, cut any response still being computed (a full-text search
  // can take seconds) on every `docker stop` and redeploy. Docker sends
  // SIGKILL 10 s after SIGTERM, so stop waiting a little before that.
  let draining = false;
  const drain = () => {
    if (draining) return;
    draining = true;
    setTimeout(() => {
      void stopSharedWork();
      process.exit(0);
    }, SHUTDOWN_GRACE_MS).unref();
    server.close(() => {
      void Promise.all([stopSharedWork(), mcpHandler.close()]).finally(() => process.exit(0));
    });
    server.closeIdleConnections();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, drain);

  server.listen(port, () => {
    console.error(
      `[iwac] IWAC MCP server running on http://0.0.0.0:${port}/mcp ` +
        `(dataset: ${config.datasetRepo}, cache: ${config.cacheDir}, semantic: ${config.semanticSearchEnabled})`,
    );
    // A shared endpoint should not make its first semantic search wait for the
    // encoder's one-time download; a desktop install fetches it only if used.
    if (config.semanticSearchEnabled && config.embeddingProvider === "onnx" && !config.offline) warmEncoder();
  });
}
