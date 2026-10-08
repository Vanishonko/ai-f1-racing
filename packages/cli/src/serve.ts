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

/**
 * Training output is served straight from where the trainer writes it, not from a copy.
 *
 * The earlier design had the build copy checkpoints into `public/`, which made the served copies a
 * SNAPSHOT taken at build time. A training run overwrites its checkpoint and its status file
 * continuously, so the viewer showed a driver from the last build and the live panel never appeared
 * at all — the status file it polls had never been copied. That is a whole class of staleness bug
 * with one fix: serve the real directory.
 *
 * Checkpoints are produced by training, are large, and change while the server runs. They are
 * exactly the kind of thing that should never have been copied into a build output in the first
 * place.
 */
const CHECKPOINTS = resolve(HERE, "../../../checkpoints");

/** Static directories, most specific first. */
const MOUNTS: ReadonlyArray<{ prefix: string; directory: string }> = [
  { prefix: "/checkpoints/", directory: CHECKPOINTS },
  { prefix: "/", directory: ROOT },
];
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

  const mount = MOUNTS.find((entry) => relative.startsWith(entry.prefix));
  if (!mount) {
    response.writeHead(404, { "content-type": "text/plain" }).end(`not found: ${relative}`);
    return;
  }
  const within = relative.slice(mount.prefix.length - 1);

  // Resolve then confirm containment, so a crafted path cannot escape the served directory.
  const target = resolve(join(mount.directory, normalize(within)));
  if (target !== mount.directory && !target.startsWith(mount.directory + "/")) {
    response.writeHead(403).end("forbidden");
    return;
  }

  try {
    const body = await readFile(target);
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream",
      // Nothing is cached: a training run rewrites its status file many times a second and the
      // viewer polls it, so a cached response would show a run that has already moved on.
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
