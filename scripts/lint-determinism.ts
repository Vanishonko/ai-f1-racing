/**
 * Determinism guard for the simulation core.
 *
 * The sim's determinism is what makes replays reproducible from `(seed, genome)`
 * — which in turn is what keeps checkpoints and race recordings tiny, and what
 * lets training and the viewer share one implementation. It depends on avoiding
 * operations whose results are not guaranteed bit-identical across engines.
 *
 * This script fails the build if a forbidden operation appears in the core.
 *
 * Usage: node scripts/lint-determinism.ts
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Files subject to the contract. */
const CORE_DIRS = ["packages/engine/src"];

/**
 * Math functions whose results are not guaranteed bit-identical across
 * JavaScript engines and CPU architectures.
 *
 * `hypot` is included because implementations may rescale internally to avoid
 * overflow; use `len()` from math2d.ts instead.
 */
const FORBIDDEN = [
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "atan2",
  "sinh",
  "cosh",
  "tanh",
  "exp",
  "expm1",
  "log",
  "log2",
  "log10",
  "log1p",
  "pow",
  "hypot",
  "cbrt",
];

/** Also forbidden: non-seeded randomness, which would break replay. */
const FORBIDDEN_OTHER: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /Math\.random\s*\(/g, reason: "Math.random() — use the seeded PRNG" },
  { pattern: /\bDate\.now\s*\(/g, reason: "Date.now() — the sim has no wall clock" },
  { pattern: /performance\.now\s*\(/g, reason: "performance.now() — the sim has no wall clock" },
];

interface Violation {
  file: string;
  line: number;
  text: string;
  reason: string;
}

/**
 * Blanks out comments while PRESERVING line structure, so reported line numbers
 * match the original file. Newlines inside comments are kept precisely so the
 * offsets do not shift.
 *
 * Comments must be stripped because the documentation in this codebase
 * deliberately discusses the banned functions by name, and a naive grep would
 * flag its own explanations.
 */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (match) => " ".repeat(match.length));

const collectFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(full)));
    } else if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
};

const violations: Violation[] = [];
const mathPattern = new RegExp(`Math\\.(${FORBIDDEN.join("|")})\\s*\\(`, "g");

/** Returns the 1-based line number of a character offset. */
const lineOf = (source: string, index: number): number =>
  source.slice(0, index).split("\n").length;

for (const dir of CORE_DIRS) {
  for (const file of await collectFiles(dir)) {
    const raw = await readFile(file, "utf8");
    const code = stripComments(raw);
    const rawLines = raw.split("\n");

    for (const match of code.matchAll(mathPattern)) {
      const line = lineOf(code, match.index ?? 0);
      violations.push({
        file,
        line,
        text: (rawLines[line - 1] ?? "").trim(),
        reason: `Math.${match[1]}() is not bit-identical across engines`,
      });
    }

    for (const { pattern, reason } of FORBIDDEN_OTHER) {
      for (const match of code.matchAll(pattern)) {
        const line = lineOf(code, match.index ?? 0);
        violations.push({
          file,
          line,
          text: (rawLines[line - 1] ?? "").trim(),
          reason,
        });
      }
    }
  }
}

if (violations.length === 0) {
  console.log("determinism: clean — no forbidden operations in the sim core");
  process.exit(0);
}

console.error(`determinism: ${violations.length} violation(s) found\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}`);
  console.error(`    ${v.text}`);
  console.error(`    -> ${v.reason}\n`);
}
console.error(
  "Trigonometry the sim needs must be baked into lookup tables at track load\n" +
    "and interpolated linearly. See docs/DESIGN.md.",
);
process.exit(1);
