// Options shared by the content script and the toolbar popup. Settings live in
// chrome.storage.sync under "settings"; anything missing takes its default.
// Loaded as a plain script in both places, so it must stay dependency-free.
(function (root) {
  const DEFAULTS = {
    posts: true, // blur posts that comments call out
    comments: true, // hide comments that replies call out
    commentStyle: "spoiler", // "spoiler" or "collapse"
    bots: true, // count bot and karma-farming callouts, not just AI ones
    strictness: "normal", // key of STRICTNESS
    dwell: 2, // seconds a post rests mid-screen before its comments are fetched
    bannedSubs: [], // lowercase subreddit names, without "r/", kept out of feeds
    exemptSubs: [], // the same, for subreddits never checked or blurred
  };

  // How well-voted a callout must be: at least `min` points and `rel` of the
  // best comment it is compared with.
  const STRICTNESS = {
    lenient: { min: 3, rel: 0.1 },
    normal: { min: 5, rel: 0.2 },
    strict: { min: 10, rel: 0.35 },
  };

  // Settings that change which posts are flagged; changing one clears the
  // cached post verdicts.
  const RULE_KEYS = ["bots", "strictness"];

  async function loadSettings() {
    const { settings } = await chrome.storage.sync.get("settings");
    return { ...DEFAULTS, ...settings };
  }

  // The lowercase subreddit name in "r/Pics", "pics", "/r/pics/" or a
  // reddit.com link to anything under it; null if there is none.
  function subName(text) {
    const s = String(text || "").trim();
    const m = s.match(/(?:^|\/)r\/([a-z0-9_]{2,21})(?:[/?#]|$)/i) || s.match(/^([a-z0-9_]{2,21})$/i);
    return m ? m[1].toLowerCase() : null;
  }

  root.RAB_SETTINGS = { DEFAULTS, STRICTNESS, RULE_KEYS, loadSettings, subName };
})(globalThis);
