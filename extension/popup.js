// The toolbar popup: reads and writes the settings in chrome.storage.sync
// (every open Reddit tab applies a change at once), shows how many cached
// post verdicts there are, and clears them.
const { STRICTNESS, RULE_KEYS, loadSettings } = globalThis.RAB_SETTINGS;
const form = document.body;
let settings;

function show() {
  for (const input of form.querySelectorAll("input[name]")) {
    const value = settings[input.name];
    if (input.type === "checkbox") input.checked = value;
    else if (input.type === "radio") input.checked = input.value === value;
    else input.value = value;
  }
  document.getElementById("dwell-out").textContent = `${settings.dwell} s`;
  const { min, rel } = STRICTNESS[settings.strictness];
  document.getElementById("strictness-hint").textContent =
    `A callout needs ${min}+ points and ${Math.round(rel * 100)}% of the top comment's score`;
  form.querySelector("[data-group='commentStyle']").classList.toggle("off", !settings.comments);
}

async function showStats() {
  const all = await chrome.storage.local.get(null);
  const posts = Object.entries(all).filter(([k]) => k.startsWith("p:"));
  const flagged = posts.filter(([, e]) => e.v).length;
  document.getElementById("stats").textContent = `${flagged} flagged of ${posts.length} checked posts`;
}

async function clearKeys(prefixes) {
  const keys = Object.keys(await chrome.storage.local.get(null)).filter((k) => prefixes.some((p) => k.startsWith(p)));
  if (keys.length) await chrome.storage.local.remove(keys);
}

form.addEventListener("change", async (e) => {
  const input = e.target;
  if (!input.name) return;
  const value = input.type === "checkbox" ? input.checked : input.type === "range" ? +input.value : input.value;
  const next = { ...settings, [input.name]: value };
  // Verdicts reached under the old rules are dropped before tabs hear of the
  // change, so none is shown under the new ones.
  if (RULE_KEYS.includes(input.name)) await clearKeys(["p:"]);
  settings = next;
  await chrome.storage.sync.set({ settings });
  show();
  showStats();
});

// The slider's readout follows the thumb; the setting is saved on release.
form.querySelector("input[name='dwell']").addEventListener("input", (e) => {
  document.getElementById("dwell-out").textContent = `${e.target.value} s`;
});

document.getElementById("clear").addEventListener("click", async () => {
  await clearKeys(["p:", "a:"]);
  showStats();
});

loadSettings().then((s) => {
  settings = s;
  show();
  showStats();
});
