// The toolbar popup: reads and writes the settings in chrome.storage.sync
// (every open Reddit tab applies a change at once), tallies the cached post
// verdicts, and clears them.
const { STRICTNESS, RULE_KEYS, loadSettings } = globalThis.RAB_SETTINGS;
let settings;

// Reddit-weight arrows for the vote switch: a wide head on a short stem.
const ARROWS = {
  up: '<svg class="up" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 L20 12.5 H15.5 V19 H8.5 V12.5 H4 Z"/></svg>',
  down: '<svg class="down" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20 L20 11.5 H15.5 V5 H8.5 V11.5 H4 Z"/></svg>',
};
for (const vote of document.querySelectorAll(".vote")) {
  vote.innerHTML = `${ARROWS.up}<span class="state"></span>${ARROWS.down}`;
}

function show() {
  for (const vote of document.querySelectorAll(".vote")) {
    const on = !!settings[vote.dataset.setting];
    vote.setAttribute("aria-checked", on);
    vote.querySelector(".state").textContent = on ? "ON" : "OFF";
  }
  for (const input of document.querySelectorAll("input[name]")) {
    if (input.type === "radio") input.checked = input.value === settings[input.name];
    else input.value = settings[input.name];
  }
  showDwell(settings.dwell);
  const { min, rel } = STRICTNESS[settings.strictness];
  document.getElementById("strictness-hint").innerHTML =
    `Needs <b>+${min}</b> and ${Math.round(rel * 100)}% of the top comment`;
  document.querySelector("[data-group='commentStyle']").classList.toggle("off", !settings.comments);
}

function showDwell(value) {
  document.getElementById("dwell-out").textContent = `${(+value).toFixed(1)} s`;
  const range = document.querySelector("input[name='dwell']");
  range.style.setProperty("--pct", `${(value / range.max) * 100}%`);
}

async function showStats() {
  const all = await chrome.storage.local.get(null);
  const posts = Object.entries(all).filter(([k]) => k.startsWith("p:"));
  const flagged = posts.filter(([, e]) => e.v).length;
  document.getElementById("flagged").textContent = flagged;
  document.getElementById("checked").textContent = posts.length;
  const split = document.getElementById("split");
  split.classList.toggle("live", posts.length > 0);
  split.style.setProperty("--flagged", posts.length ? flagged : 1);
  split.style.setProperty("--clean", posts.length ? posts.length - flagged : 1);
}

async function clearKeys(prefixes) {
  const keys = Object.keys(await chrome.storage.local.get(null)).filter((k) => prefixes.some((p) => k.startsWith(p)));
  if (keys.length) await chrome.storage.local.remove(keys);
}

async function save(name, value) {
  // Verdicts reached under the old rules are dropped before tabs hear of the
  // change, so none is shown under the new ones.
  if (RULE_KEYS.includes(name)) await clearKeys(["p:"]);
  settings = { ...settings, [name]: value };
  await chrome.storage.sync.set({ settings });
  show();
  showStats();
}

for (const vote of document.querySelectorAll(".vote")) {
  vote.addEventListener("click", () => save(vote.dataset.setting, !settings[vote.dataset.setting]));
}

document.body.addEventListener("change", (e) => {
  const input = e.target;
  if (!input.name) return;
  save(input.name, input.type === "range" ? +input.value : input.value);
});

// The slider's readout and run follow the thumb; the setting is saved on release.
document.querySelector("input[name='dwell']").addEventListener("input", (e) => showDwell(e.target.value));

document.getElementById("clear").addEventListener("click", async (e) => {
  await clearKeys(["p:", "a:"]);
  showStats();
  e.target.textContent = "Cache cleared";
  setTimeout(() => (e.target.textContent = "Clear cache"), 1500);
});

loadSettings().then((s) => {
  settings = s;
  show();
  showStats();
});
