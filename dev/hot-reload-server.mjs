// Watches the extension directory and tells the unpacked extension to reload.
// Usage: npm run dev [-- <extension dir>]   (default: ./extension)
import { existsSync, readdirSync, statSync, watch } from "node:fs";
import { join, resolve } from "node:path";
import { WebSocketServer } from "ws";

const dir = resolve(process.argv[2] || new URL("../extension", import.meta.url).pathname);
const manifest = join(dir, "manifest.json");
const port = +(process.env.HOT_PORT || 8791);
const wss = new WebSocketServer({ host: "127.0.0.1", port });

wss.on("connection", () => console.log(`[hot] extension connected (${wss.clients.size})`));

// Pings every 20 s keep the MV3 service worker alive while connected.
setInterval(() => wss.clients.forEach((c) => c.send("ping")), 20e3).unref();

function reload(why) {
  console.log(`[hot] ${why}, reloading`);
  wss.clients.forEach((c) => c.send("reload"));
}

// One non-recursive watcher per directory. Node's recursive watcher on Linux
// stops reporting in-place writes to a file once an editor has saved it by
// rename (write a temp file, rename it over), which most editors do.
// Watchers are bound to inodes, so after every change the directory tree is
// re-read and re-watched, and a replaced root (rm -rf then copy, a git
// checkout) is noticed by its inode changing. Chrome is never told to reload
// while manifest.json is missing, since a reload that finds no manifest drops
// the extension.
let watchers = [];
let rootIno = null;
let timer;

function dirs(root) {
  return [root, ...readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => dirs(join(root, d.name)))];
}

function watchTree() {
  watchers.forEach((w) => w.close());
  rootIno = statSync(dir).ino;
  watchers = dirs(dir).map((d) =>
    watch(d, (_event, file) => {
      clearTimeout(timer);
      timer = setTimeout(() => changed(file), 150);
    }).on("error", () => {})
  );
}

function changed(file) {
  if (!existsSync(manifest)) return void setTimeout(() => changed(file), 300);
  const replaced = statSync(dir).ino !== rootIno;
  watchTree();
  reload(replaced ? `${dir} replaced` : `${file} changed`);
}

function start() {
  if (!existsSync(manifest)) return void setTimeout(start, 300);
  watchTree();
}

start();
console.log(`[hot] watching ${dir} on ws://127.0.0.1:${port}`);
