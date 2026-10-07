/**
 * Minimal static file server for the viewer.
 *
 * Zero dependencies on purpose: the whole project runs on Node's standard library
 * plus a compile step for the browser bundle, so there is nothing to keep patched.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "../../../public");
const PORT = Number(process.env.PORT ?? 4321);

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (request, response) => {
  const requested = (request.url ?? "/").split("?")[0]!;
  const relative = requested === "/" ? "/index.html" : requested;

  // Resolve then confirm containment, so a crafted path cannot escape ROOT.
  const target = resolve(join(ROOT, normalize(relative)));
  if (target !== ROOT && !target.startsWith(ROOT + "/")) {
    response.writeHead(403).end("forbidden");
    return;
  }

  try {
    const body = await readFile(target);
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain" }).end(`not found: ${relative}`);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`viewer: http://127.0.0.1:${PORT}`);
  console.log("  W/up arrow  throttle      S/down  brake");
  console.log("  A D         steer         R       reset    Space  handbrake test");
});
