/**
 * Bundles the simulation engine for the browser.
 *
 * The engine source uses explicit `.ts` import specifiers so that Node can run it
 * directly with no build step during development and training. Browsers will not
 * fetch `.ts`, so this transpiles each file to ESM JavaScript and rewrites the
 * specifiers to match.
 *
 * Deliberately simple. The point is that the browser and the trainer execute the
 * SAME engine source, so what you drive in the viewer is exactly what the
 * evolutionary search is optimising against — no second implementation to drift.
 */

import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);

/** Recursively lists emitted JavaScript files. */
const collect = async (dir: string): Promise<string[]> => {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await collect(full)));
    else if (entry.name.endsWith(".js")) found.push(full);
  }
  return found;
};
const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const ENGINE_SRC = join(ROOT, "packages/engine/src");
const VIEWER_SRC = join(ROOT, "packages/viewer/src");
const ENGINE_OUT = join(ROOT, "public/engine");
const VIEWER_OUT = join(ROOT, "public/viewer");

await rm(ENGINE_OUT, { recursive: true, force: true });
await rm(VIEWER_OUT, { recursive: true, force: true });
await mkdir(ENGINE_OUT, { recursive: true });
await mkdir(VIEWER_OUT, { recursive: true });

// Transpile to ESM into a temporary directory first, then rewrite specifiers.
const staging = join(ROOT, ".build-engine");
await rm(staging, { recursive: true, force: true });

/**
 * Transpiles one directory of TypeScript into ESM JavaScript for the browser.
 *
 * The viewer is typechecked alongside the engine rather than kept as loose
 * JavaScript in `public/`, so a typo in the rendering code fails the same gate as
 * a typo in the physics.
 */
const transpile = async (src: string, out: string): Promise<string[]> => {
  const stage = join(ROOT, ".build-stage");
  await rm(stage, { recursive: true, force: true });

  const files = (await readdir(src)).filter((f) => f.endsWith(".ts"));
  await run(
    join(ROOT, "node_modules/.bin/tsc"),
    [
      "--target", "ES2022",
      "--module", "ESNext",
      "--moduleResolution", "bundler",
      "--outDir", stage,
      "--allowImportingTsExtensions", "false",
      "--rewriteRelativeImportExtensions", "true",
      "--verbatimModuleSyntax", "false",
      "--erasableSyntaxOnly", "false",
      "--isolatedModules", "false",
      "--skipLibCheck", "true",
      "--ignoreConfig",
      ...files.map((f) => join(src, f)),
    ],
    { cwd: ROOT },
  );

  // Rewrite any surviving `.ts` specifiers; the browser will not fetch them.
  // Emitted files are flattened and copied across, which is safe because every
  // module in a build is uniquely named.
  const emitted = await collect(stage);
  if (emitted.length === 0) throw new Error(`tsc emitted nothing for ${src}`);
  for (const path of emitted) {
    const file = path.slice(path.lastIndexOf("/") + 1);
    const source = await readFile(path, "utf8");
    let rewritten = source.replace(/(from\s+["'][^"']+)\.ts(["'])/g, "$1.js$2");
    // The viewer resolves engine modules by relative path so the typechecker can
    // find them; the browser needs them under /engine/.
    if (out === VIEWER_OUT) {
      rewritten = rewritten.replace(/(from\s+["'])(?:\.\.\/)+engine\/src\//g, "$1/engine/");
    }
    await writeFile(path, rewritten);
    await cp(path, join(out, file));
  }

  await rm(stage, { recursive: true, force: true });
  return (await readdir(out)).filter((f) => f.endsWith(".js"));
};

const engineModules = await transpile(ENGINE_SRC, ENGINE_OUT);
const viewerModules = await transpile(VIEWER_SRC, VIEWER_OUT);

/**
 * Publishes trained drivers so the viewer can fetch them.
 *
 * Checkpoints live outside `public/` because they are produced by training rather than by the
 * build, and they can be large. Copying them in is what turns a finished run into something
 * watchable: the viewer fetches `/checkpoints/<circuit>.json` and drives from it.
 *
 * A missing directory is normal — nothing has been trained yet — and is not an error.
 */
const CHECKPOINTS = join(ROOT, "checkpoints");
const CHECKPOINT_OUT = join(ROOT, "public/checkpoints");
let published = 0;
try {
  await mkdir(CHECKPOINT_OUT, { recursive: true });
  for (const entry of await readdir(CHECKPOINTS, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    // Status files are published too, so the viewer can show a run in progress.
    const destination = join(CHECKPOINT_OUT, entry.name);
    await cp(join(CHECKPOINTS, entry.name), destination);
    if (!entry.name.endsWith(".status.json")) published++;
  }
} catch {
  // No checkpoints yet. The viewer reports that per circuit rather than failing.
}

console.log(`engine: ${engineModules.length} modules -> public/engine/`);
console.log(`viewer: ${viewerModules.length} modules -> public/viewer/`);
console.log(`drivers: ${published} checkpoint(s) -> public/checkpoints/`);
