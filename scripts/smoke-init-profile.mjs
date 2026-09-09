// smoke-init-profile.mjs — pre-initialize a throwaway dsh profile for
// smoke-plugin.sh: manifest + pnpm-workspace.yaml with an override per packed
// tarball (so repo-internal peer chains resolve against the local files while
// the rc.1 packages are not yet published to npm).
//
// usage: node smoke-init-profile.mjs <profile-dir> <tarball...>
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const [prof, ...specs] = process.argv.slice(2);
mkdirSync(prof, { recursive: true });

const overrides = {};
const miss = [];
for (const abs of specs) {
  let name = "";
  try {
    name = JSON.parse(execFileSync("tar", ["-xOf", abs, "package/package.json"], { encoding: "utf8" })).name || "";
  } catch {
    miss.push(abs);
  }
  if (name) overrides[name] = "file:" + abs;
}

const manifest = {
  name: "dsh-profile-smoke",
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"], patchReload: "live" } },
};
writeFileSync(`${prof}/package.json`, JSON.stringify(manifest, null, 2) + "\n");

let yaml = "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n";
const keys = Object.keys(overrides);
if (keys.length) {
  yaml += "overrides:\n";
  for (const k of keys) yaml += `  "${k}": "${overrides[k]}"\n`;
}
writeFileSync(`${prof}/pnpm-workspace.yaml`, yaml);

if (miss.length) {
  console.error("WARN: could not read package name from: " + miss.join(", "));
  process.exit(1);
}
