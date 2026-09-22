// A stand-in for the verify service's re-check queue, for a dry run before the real routes exist
// or when working offline. It answers the three runner routes and nothing else, holds its list in
// memory, and prints every call so a dry run shows what the runner asked for.
//
//   node deploy/queue-stub.mjs 4099 dry-run-token 0x<passport id> ...
//
// Never run this anywhere a real runner token is in use: it accepts one token and stores nothing.
import { createServer } from "node:http";

const [port = "4099", token = "dry-run-token", ...pending] = process.argv.slice(2);
const running = new Set();

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://localhost:${port}`);
  const authorized = request.headers.authorization === `Bearer ${token}`;
  const send = (status, body) => {
    console.log(`stub: ${request.method} ${url.pathname} -> ${status}`);
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
  };

  if (!authorized) {
    send(401, { error: "bad-token" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/recheck/queue") {
    send(200, {
      requests: pending
        .filter((id) => !running.has(id))
        .map((id) => ({ passportId: id, requestedAt: new Date().toISOString(), requestedBy: "public" })),
    });
    return;
  }

  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    const parsed = body === "" ? {} : JSON.parse(body);
    if (request.method === "POST" && url.pathname === "/recheck/claim") {
      if (!pending.includes(parsed.passportId)) {
        send(404, { error: "no-request" });
        return;
      }
      running.add(parsed.passportId);
      send(200, { passportId: parsed.passportId, status: "running" });
      return;
    }
    if (request.method === "POST" && url.pathname === "/recheck/done") {
      console.log(`stub: done ${JSON.stringify(parsed)}`);
      send(200, { passportId: parsed.passportId, status: parsed.reason === undefined ? "done" : "failed" });
      return;
    }
    send(404, { error: "no-route" });
  });
});

server.listen(Number(port), "127.0.0.1", () => {
  console.log(`stub: listening on http://127.0.0.1:${port}, ${pending.length} request(s) queued`);
});
