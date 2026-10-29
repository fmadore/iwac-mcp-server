// A loopback proxy that adds the bearer token to every request, for MCP test
// clients that cannot send headers (the official conformance suite). CI only:
// it listens on 127.0.0.1 and forwards to a local IWAC HTTP server, the way the
// IWAC-docker nginx does in production.
//
//   IWAC_MCP_BEARER_TOKEN=… node scripts/auth-proxy.mjs <listen-port> <target-port>
import http from "node:http";

const [listenPort, targetPort] = process.argv.slice(2).map(Number);
const token = process.env.IWAC_MCP_BEARER_TOKEN;
if (!listenPort || !targetPort || !token) {
  console.error("usage: IWAC_MCP_BEARER_TOKEN=… node scripts/auth-proxy.mjs <listen-port> <target-port>");
  process.exit(2);
}

http
  .createServer((req, res) => {
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: targetPort,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: `127.0.0.1:${targetPort}`, authorization: `Bearer ${token}` },
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(String(err.message));
    });
    req.pipe(upstream);
  })
  .listen(listenPort, "127.0.0.1", () => console.error(`[auth-proxy] 127.0.0.1:${listenPort} → 127.0.0.1:${targetPort}`));
