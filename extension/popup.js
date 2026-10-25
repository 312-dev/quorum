// The toolbar popup: reads and writes the settings in chrome.storage.sync
// (every open Reddit tab applies a change at once), tallies the cached post
// verdicts, and clears them.
const { SENSITIVITY, RULE_KEYS, loadSettings, subName } = globalThis.RAB_SETTINGS;
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
  const { min, rel } = SENSITIVITY[settings.sensitivity];
  document.getElementById("sensitivity-hint").innerHTML =
    `Flags once a callout has <b>+${min}</b> and ${Math.round(rel * 100)}% of the top comment's votes`;
  document.querySelector("[data-group='commentStyle']").classList.toggle("off", !settings.comments);
  showSubLists();
}

// The subreddit lists (banned, excluded): one form each, naming its setting
// and its verb ("Ban" gives "Unban r/x" on the chip's remove button).
const subLists = [...document.querySelectorAll("form.sub-list")];

function showSubLists() {
  for (const form of subLists) {
    const key = form.dataset.setting;
    form.querySelector(".chips").replaceChildren(
      ...settings[key].map((sub) => {
        const li = document.createElement("li");
        li.textContent = `r/${sub}`;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "×";
        remove.setAttribute("aria-label", `Un${form.dataset.verb.toLowerCase()} r/${sub}`);
        remove.addEventListener("click", () => save(key, settings[key].filter((s) => s !== sub)));
        li.append(remove);
        return li;
      })
    );
  }
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

// Each takes one or more names, links or "r/" forms, split by spaces or
// commas. Anything that is not a subreddit stays in the field with an error.
for (const form of subLists) {
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const key = form.dataset.setting;
    const input = form.querySelector("input");
    const parts = input.value.split(/[\s,]+/).filter(Boolean);
    const names = parts.map(subName);
    const bad = parts.filter((_, i) => !names[i]);
    input.value = bad.join(" ");
    form.querySelector(".note").textContent = bad.length ? `Not a subreddit name: ${bad[0]}` : "";
    const next = [...new Set([...settings[key], ...names.filter(Boolean)])].sort();
    if (next.length !== settings[key].length) save(key, next);
    input.focus();
  });
}

// The slider's readout and run follow the thumb; the setting is saved on release.
document.querySelector("input[name='dwell']").addEventListener("input", (e) => showDwell(e.target.value));

document.getElementById("clear").addEventListener("click", async (e) => {
  await clearKeys(["p:", "a:"]);
  showStats();
  e.target.textContent = "Cache cleared";
  setTimeout(() => (e.target.textContent = "Clear cache"), 1500);
});

// A change made elsewhere (a ban screen's Unban, another window's panel) is
// shown, and is the base for this panel's next save.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !changes.settings || !settings) return;
  settings = { ...settings, ...changes.settings.newValue };
  show();
});

loadSettings().then((s) => {
  settings = s;
  show();
  showStats();
});
