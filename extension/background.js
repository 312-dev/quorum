// Clears cached verdicts on install, update and every reload, so no post is
// judged by rules older than the running code. Also dev hot reload: an
// unpacked install connects to dev/hot-reload-server.mjs; on a file change it
// reloads itself, then reloads open Reddit tabs so their content scripts are
// the new ones. A store build (has update_url) skips the hot reload.
const DEV = !("update_url" in chrome.runtime.getManifest());
const HOT_URL = "ws://127.0.0.1:8791";
const REDDIT_TABS = ["*://www.reddit.com/*", "*://old.reddit.com/*"];

let socket = null;

function connect() {
  if (!DEV || socket) return;
  socket = new WebSocket(HOT_URL);
  socket.onmessage = async ({ data }) => {
    if (data !== "reload") return; // the server's keepalive pings land here too
    // storage.session is wiped by the reload, so the flag goes in local.
    await chrome.storage.local.set({ reloadTabs: true });
    chrome.runtime.reload();
  };
  socket.onclose = () => {
    socket = null;
  };
}

async function reloadTabsAfterRestart() {
  const { reloadTabs } = await chrome.storage.local.get("reloadTabs");
  if (!reloadTabs) return;
  await chrome.storage.local.remove("reloadTabs");
  for (const tab of await chrome.tabs.query({ url: REDDIT_TABS })) chrome.tabs.reload(tab.id);
}

async function clearVerdicts() {
  const keys = Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith("p:"));
  if (keys.length) await chrome.storage.local.remove(keys);
}

// A reloaded MV3 worker is not started until an event needs it; onInstalled
// (reason "update") is that event. The cache is cleared before tabs reload so
// their new content scripts never load stale verdicts.
chrome.runtime.onInstalled.addListener(async () => {
  await clearVerdicts();
  if (DEV) await reloadTabsAfterRestart();
});

if (DEV) {
  connect();
  // The worker sleeps when idle and nothing else wakes it, so a server started
  // later is picked up on the next alarm (30 s is Chrome's minimum period).
  chrome.alarms.create("hot-reload", { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((a) => a.name === "hot-reload" && connect());
}
