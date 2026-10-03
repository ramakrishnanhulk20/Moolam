// Bundles the workflow's decoder, fingerprints and rule into dist/networkRuleEntry.js, the file
// src/networkRule.ts loads in the compiled service. Run by `npm run build` after tsc.
//
// tsc cannot do this: the workflow's files sit outside this package, and its own imports have no
// file extensions, which Node's module loader refuses. esbuild reads the same sources the tests
// and tsx read and writes one file that has no imports left to resolve.

import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function bundleNetworkRule(outfile = path.join(packageRoot, "dist", "networkRuleEntry.js")) {
  await build({
    entryPoints: [path.join(packageRoot, "src", "networkRuleEntry.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "warning",
  });
  return outfile;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`wrote ${path.relative(packageRoot, await bundleNetworkRule(process.argv[2]))}`);
}
