/**
 * Bundles the browser client.
 * License: Apache-2.0
 *
 * The playground signs payments in the visitor's browser with the same stock
 * packages the conformance harness uses from Node - `@x402/core`,
 * `@x402/stellar` and `@stellar/stellar-sdk`, at the versions pinned in
 * package.json. Nothing about the protocol is reimplemented here.
 *
 * The two `define`s are not optional. `@stellar/stellar-sdk` resolves to its
 * browser build, which reads `process.env.NODE_DEBUG` at module scope; without
 * a definition the bundle throws `process is not defined` on first import.
 */

import { build, context } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: ["web/main.ts"],
  outfile: "public/bundle.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022", "chrome111", "firefox111", "safari16"],
  sourcemap: true,
  minify: !watch,
  logLevel: "info",
  define: {
    "process.env.NODE_DEBUG": "false",
    "process.env.NODE_ENV": watch ? '"development"' : '"production"',
    global: "globalThis",
  },
};

/**
 * Copies the static shell alongside the bundle.
 *
 * index.html and styles.css are hand-written and need no transform, so they are
 * copied rather than run through the bundler.
 */
async function copyStatic() {
  await mkdir("public", { recursive: true });
  await copyFile("web/index.html", "public/index.html");
  await copyFile("web/styles.css", "public/styles.css");
}

await copyStatic();

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  // esbuild only watches what the bundle imports, so the static shell needs
  // its own watcher or edits to index.html/styles.css never reach public/.
  const { watch: watchFs } = await import("node:fs");
  for (const file of ["web/index.html", "web/styles.css"]) {
    watchFs(file, () => void copyStatic());
  }
  process.stdout.write("[build-web] watching web/\n");
} else {
  await build(options);
}
