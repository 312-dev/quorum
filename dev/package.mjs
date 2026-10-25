// Builds the Chrome Web Store upload: dist/quorum-<version>.zip, from
// extension/ minus the dev hot reload (the block between the dev:start and
// dev:end markers in background.js) and the alarms permission only it uses.
// Run: npm run package
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "extension");
const OUT = join(ROOT, "dist");
const BUILD = join(OUT, "build");

rmSync(BUILD, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(SRC, BUILD, { recursive: true });

const bgPath = join(BUILD, "background.js");
const bg = readFileSync(bgPath, "utf8");
const stripped = bg.replace(/\n\/\/ dev:start[\s\S]*?\/\/ dev:end\n/, "\n");
if (stripped === bg) throw new Error("dev:start/dev:end markers not found in background.js");
writeFileSync(bgPath, stripped);

const manifestPath = join(BUILD, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.permissions = manifest.permissions.filter((p) => p !== "alarms");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

const zip = join(OUT, `quorum-${manifest.version}.zip`);
rmSync(zip, { force: true });
// Python's zipfile, since zip(1) is not always installed.
execFileSync("python3", ["-c", `
import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for d, _, files in sorted(os.walk(src)):
        for f in sorted(files):
            p = os.path.join(d, f)
            z.write(p, os.path.relpath(p, src))
`, BUILD, zip]);
console.log(`${zip}\npermissions: ${manifest.permissions.join(", ")}`);
