// End-to-end: loads the unpacked extension into Chromium and serves Reddit
// pages and comment JSON from fixtures through request interception, so runs
// are deterministic and never touch the real site.
import { test as base, expect, chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const FIXTURES = join(ROOT, "tests/fixtures");

// Each comment: [body, score, replies?, flags?] where flags may set
// controversiality or score_hidden.
const COMMENTS = {
  ai1: [["Gorgeous!", 300], ["is this AI? the clouds look weird", 180, [["Yes, look at the horizon", 40]]]],
  clean1: [["What a good boy", 90], ["Name?", 20, [["Biscuit", 15]]]],
  loose: [["nice", 30], ["meh", 12, [["this is clearly AI lol", 25]]]],
  lowvote: [["Stunning shot", 500], ["is this AI?", 4], ["looks like AI", 120]],
  controversial: [["Love it", 50], ["AI slop, reported", 400, [], { controversiality: 1 }], ["is this ai", 30, [], { score_hidden: true }]],
  far: [["first", 10], ["AI slop, reported", 200]],
  text1: [["this is clearly AI", 50], ["lovely", 10]],
  // A weak bot callout: +60 is under 20% of +1000 but over 5%.
  farmed: [["great shot", 1000], ["OP is a bot, check the history", 60]],
  veteran: [["great shot", 1000], ["OP is a bot, check the history", 60]],
  oldai: [["Made with Midjourney, you can tell", 77]],
  oldclean: [["Great post", 9]],
};

// Builds Reddit's [post listing, comment listing] response shape.
function listing(id) {
  const toNode = ([body, score, replies = [], flags = {}]) => ({
    kind: "t1",
    data: {
      body,
      score,
      controversiality: 0,
      score_hidden: false,
      ...flags,
      replies: replies.length
        ? { kind: "Listing", data: { children: replies.map(toNode) } }
        : "",
    },
  });
  return [
    { kind: "Listing", data: { children: [{ kind: "t3", data: { id } }] } },
    { kind: "Listing", data: { children: (COMMENTS[id] || []).map(toNode) } },
  ];
}

async function launch(extDir) {
  // Chrome disables an unpacked extension that reloads itself unless Developer
  // mode is on (DISABLE_UNSUPPORTED_DEVELOPER_EXTENSION), and a fresh profile
  // has it off. A real "Load unpacked" install always has it on.
  const profile = mkdtempSync(join(tmpdir(), "rab-profile-"));
  mkdirSync(join(profile, "Default"));
  writeFileSync(
    join(profile, "Default/Preferences"),
    JSON.stringify({ extensions: { ui: { developer_mode: true } } })
  );
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  // Tests flip these: blockJson answers the JSON API with 403 as Reddit does
  // for suspected bots; fakeScores serves every partial comment at score 1, as
  // the partial does while comment scores are hidden; redditBlur defines a
  // stand-in for Reddit's blur component on the page, redditSpoiler one for
  // its spoiler.
  const ext = {
    context, fetched: [], partials: [], hoverCards: [],
    blockJson: false, fakeScores: false, redditBlur: false, redditSpoiler: false,
  };
  // Chromium can still be writing into the profile as close() resolves, so a
  // plain delete races it (ENOTEMPTY); rmSync's retries cover that.
  ext.close = async () => {
    await context.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  await context.route(/^https:\/\/(www|old)\.reddit\.com\//, (route) => {
    const url = new URL(route.request().url());
    const json = url.pathname.match(/^\/comments\/(\w+)\.json$/);
    if (json) {
      ext.fetched.push(json[1]);
      if (ext.blockJson) return route.fulfill({ status: 403, contentType: "text/html", body: "blocked by network security" });
      return route.fulfill({ json: listing(json[1]) });
    }
    const card = url.pathname.match(/^\/svc\/shreddit\/user-hover-card\/(\w+)$/);
    if (card) {
      ext.hoverCards.push(card[1]);
      return route.fulfill({ contentType: "text/html", body: hoverCardHtml(ACCOUNTS[card[1]]) });
    }
    const partial = url.pathname.match(/^\/svc\/shreddit\/comments\/r\/test\/t3_(\w+)$/);
    if (partial) {
      ext.partials.push(partial[1]);
      return route.fulfill({ contentType: "text/html", body: partialHtml(partial[1], ext.fakeScores) });
    }
    const old = url.hostname.startsWith("old.");
    let body;
    if (url.pathname.includes("/comments/thread1/")) body = (old ? oldThreadHtml : threadHtml)(THREAD);
    else {
      const page = old ? "old.html" : url.pathname.includes("/comments/") ? "post.html" : "feed.html";
      body = readFileSync(join(FIXTURES, page), "utf8");
    }
    const mocks = [ext.redditBlur && "mock-blurred-container.js", ext.redditSpoiler && "mock-spoiler.js"].filter(Boolean);
    for (const mock of mocks) {
      body = body.replace("</head>", `<script>${readFileSync(join(FIXTURES, mock), "utf8")}</script></head>`);
    }
    return route.fulfill({ contentType: "text/html", body });
  });
  if (!context.serviceWorkers()[0]) await context.waitForEvent("serviceworker");
  return ext;
}

// Authors' hover cards. New_Farmer1234 has the shape of a real account seen on
// 2026-10-23: weeks old, 7,962 post karma against 822 comment karma.
const DAY = 864e5;
const ACCOUNTS = {
  New_Farmer1234: { age: 70 * DAY, post: "7,962", comment: "822" },
  OldTimer: { age: 2000 * DAY, post: "7,523", comment: "3,434" },
};

// Reddit's hover card, reduced to what the extension reads.
function hoverCardHtml(a) {
  const created = new Date(Date.now() - a.age).toISOString();
  return `<template><div data-testid="user-hover-card"><time data-testid="cake-day" datetime="${created}"></time><span data-testid="karma-number">${a.post}</span> Post karma<span data-testid="karma-number">${a.comment}</span> Comment karma</div></template>`;
}

// The comments partial: nested <shreddit-comment> elements with the body in
// a slot="comment" div. As on Reddit, the first thread is rendered and the
// rest are deferred inside a nested <template>. The script tag checks the
// partial is parsed inertly.
function partialHtml(id, fakeScores) {
  const render = ([body, score, replies = []]) =>
    `<shreddit-comment score="${fakeScores ? 1 : score}"><div slot="comment"><p>${body}</p></div>${replies.map(render).join("")}</shreddit-comment>`;
  const [first, ...rest] = (COMMENTS[id] || []).map(render);
  return `<script>document.title = "partial script ran"</script><shreddit-comment-tree>${first || ""}</shreddit-comment-tree><section aria-label="Comments"><template>${rest.join("")}</template></section>`;
}

// A comment thread: [id, score, body html, replies]. c1's replies call it out
// as ChatGPT-written; c2's reply asks about the picture, not the comment; c3's
// callout is under the vote floor; c4's is outvoted by a denial; c5 is
// called a bot.
const THREAD = [
  ["c1", 900, "<p>Great question. There are three reasons.</p><p>First, see <a href='https://example.com/x'>this link</a>.</p>", [
    ["r1", 300, "<p>This reads like ChatGPT</p>"],
    ["r2", 50, "<p>agreed</p>"],
  ]],
  ["c2", 400, "<p>My dog does this too</p>", [["r3", 200, "<p>is this AI?</p>"]]],
  ["c3", 400, "<p>Totally normal comment</p>", [["r4", 3, "<p>written by ChatGPT lol</p>"], ["r5", 10, "<p>nice</p>"]]],
  ["c4", 300, "<p>I was there</p>", [["r6", 60, "<p>you're a bot</p>"], ["r7", 80, "<p>Not a bot, I know him</p>"]]],
  ["c5", 200, "<p>Upvote if you agree</p>", [["r8", 40, "<p>you are a karma farming bot</p>"]]],
];

// New Reddit's comment markup, reduced to what the extension reads: the
// comment's attributes, its meta row with the author, and its body in a
// slot="comment" div, with replies nested inside its <details>.
function threadHtml(thread) {
  const render = ([id, score, body, replies = []], parent) => `
    <shreddit-comment thingid="t1_${id}" ${parent ? `parentid="t1_${parent}"` : ""} author="user_${id}" score="${score}">
      <details open><summary><div slot="commentMeta"><span class="author-hovercard-trigger"><div class="author-name-meta"><a class="author">user_${id}</a></div></span><span> • 1h ago</span></div></summary>
      <div slot="comment">${body}</div>
      ${replies.map((r) => render(r, id)).join("")}
      </details>
    </shreddit-comment>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>thread fixture</title></head><body><main>${thread.map((c) => render(c)).join("")}</main></body></html>`;
}

// Old Reddit's: nested .thing.comment, the score's number in the title of
// .score.unvoted, the body in .usertext-body .md, replies under .child.
function oldThreadHtml(thread) {
  const render = ([id, score, body, replies = []]) => `
    <div class="thing comment noncollapsed" data-fullname="t1_${id}">
      <div class="entry"><p class="tagline"><a class="author">user_${id}</a> <span class="score unvoted" title="${score}">${score} points</span></p>
      <form class="usertext"><div class="usertext-body"><div class="md">${body}</div></div></form></div>
      <div class="child"><div class="sitetable listing">${replies.map(render).join("")}</div></div>
    </div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>old thread fixture</title><style>.collapsed > .child, .collapsed .usertext { display: none }</style></head><body><div class="commentarea"><div class="sitetable nestedlisting">${thread.map(render).join("")}</div></div></body></html>`;
}

const test = base.extend({
  ext: async ({}, use) => {
    const ext = await launch(process.env.RAB_EXT || join(ROOT, "extension"));
    await use(ext);
    await ext.close();
  },
});

const post = (page, id) => page.locator(`#t3_${id}, [data-fullname="t3_${id}"]`);
const state = (page, id) => post(page, id).getAttribute("data-rab-state");
// Centres the post: fetching waits for posts in the middle of the screen.
const scrollTo = (page, id) => post(page, id).evaluate((e) => e.scrollIntoView({ block: "center" }));

test("flags in-view posts whose comments call out AI, leaves others alone", async ({ ext }) => {
  const page = await ext.context.newPage();
  await page.goto("https://www.reddit.com/r/test/");

  await expect.poll(() => state(page, "ai1")).toBe("ai");
  await scrollTo(page, "clean1");
  await expect.poll(() => state(page, "clean1")).toBe("clean");
  // Nothing that has not rested mid-screen is fetched.
  expect(ext.fetched).not.toContain("lowvote");
  expect(ext.fetched).not.toContain("far");

  await scrollTo(page, "zero");
  await expect.poll(() => state(page, "zero")).toBe("clean");
  await scrollTo(page, "loose");
  await expect.poll(() => state(page, "loose")).toBe("ai"); // match in a nested reply
  await scrollTo(page, "lowvote");
  // lowvote: "is this AI?" at +4 is under the bar, but "looks like AI" at +120
  // clears 20% of the +500 top comment (100), so it is still flagged by that one.
  await expect.poll(() => state(page, "lowvote")).toBe("ai");
  await expect(page.locator("article:has(#t3_lowvote) > .rab-overlay")).toHaveAttribute("title", /\+120/);
  // controversial: the +400 callout is daggered and the other hides its score.
  await scrollTo(page, "controversial");
  await expect.poll(() => state(page, "controversial")).toBe("clean");

  await scrollTo(page, "ai1");
  const overlay = page.locator("article:has(#t3_ai1) > .rab-overlay");
  await expect(overlay).toContainText("Potential AI");
  await expect(overlay.locator("button")).toHaveAttribute("aria-label", "Potential AI, click to reveal");
  await expect(overlay).toHaveAttribute("title", /\(\+180\) "is this AI/i);
  expect(await page.locator("#t3_ai1").evaluate((e) => getComputedStyle(e).filter)).toContain("blur");
  await expect(page.locator("article:has(#t3_clean1) > .rab-overlay")).toHaveCount(0);
  await expect(page.locator(".rab-wrap:has(#t3_loose) > .rab-overlay")).toHaveCount(1);

  // Zero-comment posts are never fetched; the far post waits until scrolled to.
  expect(ext.fetched).not.toContain("zero");
  expect(ext.fetched).not.toContain("far");

  await scrollTo(page, "far");
  await expect.poll(() => state(page, "far")).toBe("ai");
  expect(ext.fetched.filter((id) => id === "ai1")).toHaveLength(1);

  await page.screenshot({ path: join(ROOT, "test-results/feed-flagged.png") });
});

test("fetches only posts that rest mid-screen for 2 s; fast scrolling fetches nothing", async ({ ext }) => {
  const page = await ext.context.newPage();
  await page.goto("https://www.reddit.com/r/test/");
  for (const id of ["clean1", "zero", "loose", "lowvote", "controversial", "text1", "far"]) {
    await scrollTo(page, id);
    await page.waitForTimeout(300);
  }
  await scrollTo(page, "ai1");
  await page.waitForTimeout(1500);
  expect(ext.fetched).toEqual([]);
  await expect.poll(() => ext.fetched).toEqual(["ai1"]);
  await expect.poll(() => state(page, "ai1")).toBe("ai");
});

test("a karma-farming poster lowers the bar for a bot callout; an old account does not", async ({ ext }) => {
  const page = await ext.context.newPage();
  await page.goto("https://www.reddit.com/r/test/");
  await expect.poll(() => state(page, "ai1")).toBe("ai");
  expect(ext.hoverCards).toEqual([]); // a clear verdict needs no account lookup
  await scrollTo(page, "farmed");
  await expect.poll(() => state(page, "farmed")).toBe("ai");
  await expect(page.locator("article:has(#t3_farmed) > .rab-overlay")).toHaveAttribute("title", /OP is a bot" · new karma-farming account/);
  await scrollTo(page, "veteran");
  await expect.poll(() => state(page, "veteran")).toBe("clean");
  expect(ext.hoverCards).toEqual(["New_Farmer1234", "OldTimer"]);
});

test("click to reveal unblurs the post without navigating", async ({ ext }) => {
  const page = await ext.context.newPage();
  await page.goto("https://www.reddit.com/r/test/");
  const overlay = page.locator("article:has(#t3_ai1) > .rab-overlay");
  await overlay.click();
  await expect(overlay).toHaveCount(0);
  await expect.poll(() => state(page, "ai1")).toBe("revealed");
  await expect
    .poll(() => page.locator("#t3_ai1").evaluate((e) => getComputedStyle(e).filter))
    .toBe("none");
  expect(page.url()).toBe("https://www.reddit.com/r/test/");
});

test("verdicts are cached across reloads and tabs", async ({ ext }) => {
  const page = await ext.context.newPage();
  await page.goto("https://www.reddit.com/r/test/");
  await expect.poll(() => state(page, "ai1")).toBe("ai");
  await scrollTo(page, "clean1");
  await expect.poll(() => state(page, "clean1")).toBe("clean");
  await expect.poll(() => state(page, "ai1")).toBe("ai");
  const before = ext.fetched.length;

  await page.reload();
  await expect.poll(() => state(page, "ai1")).toBe("ai");
  await expect.poll(() => state(page, "clean1")).toBe("clean");

  const tab2 = await ext.context.newPage();
  await tab2.goto("https://www.reddit.com/r/test/");
  await expect.poll(() => state(tab2, "ai1")).toBe("ai");

  expect(ext.fetched.length).toBe(before);
});

test("works on old reddit", async ({ ext }) => {
  const page = await ext.context.newPage();
  await page.goto("https://old.reddit.com/r/test/");
  await expect.poll(() => state(page, "oldai")).toBe("ai");
  await expect.poll(() => state(page, "oldclean")).toBe("clean");
  await expect(page.locator('[data-fullname="t3_oldai"] > .rab-overlay')).toContainText("Potential AI");
  await expect(page.locator('[data-fullname="t3_oldclean"] > .rab-overlay')).toHaveCount(0);
});

test("uses Reddit's own blur component when the page defines it", async ({ ext }) => {
  ext.redditBlur = true;
  const page = await ext.context.newPage();
  // Record every label the button shows at paint time, to catch a flash of
  // Reddit's "View NSFW content" before the relabel.
  await page.addInitScript(() => {
    window.__labels = [];
    const tick = () => {
      document.querySelectorAll("shreddit-blurred-container").forEach((b) => {
        const t = b.shadowRoot?.querySelector("button")?.textContent.trim();
        if (t && window.__labels.at(-1) !== t) window.__labels.push(t);
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.goto("https://www.reddit.com/r/test/");
  await expect.poll(() => state(page, "ai1")).toBe("ai");

  // Only the media box's contents are blurred, as on Reddit's NSFW posts: the
  // box keeps its border, and the title stays outside the blur.
  const box = page.locator("#t3_ai1 > [slot=post-media-container] > shreddit-blurred-container.rab-blur");
  await expect(box).toHaveAttribute("reason", "nsfw");
  await expect(box).toHaveAttribute("title", /\(\+180\) "is this AI/i);
  await expect(box.locator("> div[slot=revealed] > .media")).toHaveText("sunset.jpg");
  await expect(page.locator("#t3_ai1 > a[slot=title]")).toHaveCount(1);
  await expect(page.locator("article > shreddit-blurred-container")).toHaveCount(0);
  await expect(box.locator("button")).toHaveText("Potential AI");
  await expect(box.locator("button")).toHaveAttribute("aria-label", "Potential AI, click to reveal");
  await expect(page.locator(".rab-overlay")).toHaveCount(0); // no fallback overlay alongside
  expect(await page.evaluate(() => window.__labels)).toEqual(["Potential AI"]);

  await box.locator("button").click();
  await expect.poll(() => state(page, "ai1")).toBe("revealed");
  await expect(box.locator("button")).toHaveCount(0);
  expect(page.url()).toBe("https://www.reddit.com/r/test/");
  // Coming back into view must not undo the reveal or its state.
  await scrollTo(page, "far");
  await scrollTo(page, "ai1");
  // Let the observers re-run render() before checking it kept the reveal.
  await page.waitForTimeout(600);
  expect(await state(page, "ai1")).toBe("revealed");
  await expect(box).not.toHaveAttribute("blurred", "");

  // A text post gets Reddit's 88px blurred text strip inside its body.
  await scrollTo(page, "text1");
  await expect.poll(() => state(page, "text1")).toBe("ai");
  const textBox = page.locator("#t3_text1 [slot=text-body] > [slot=text-body] > shreddit-blurred-container.rab-blur");
  await expect(textBox).toHaveAttribute("is-richtext-content", "");
  await expect(textBox.locator("> div[slot=revealed] > p")).toHaveText("Roses are red");
});

test("blurs the post on its own page too, without waiting for a dwell", async ({ ext }) => {
  ext.redditBlur = true;
  const page = await ext.context.newPage();
  await page.goto("https://www.reddit.com/r/test/comments/ai1/x/");
  // Well inside the 2 s feed dwell.
  await expect.poll(() => state(page, "ai1"), { timeout: 1500 }).toBe("ai");
  const box = page.locator("#t3_ai1 > [slot=post-media-container] > shreddit-blurred-container.rab-blur");
  await expect(box.locator("button")).toHaveText("Potential AI");
  await expect(page.locator("#t3_ai1 > h1[slot=title]")).toHaveCount(1);
  await expect(page.locator("main > shreddit-comment")).toHaveCount(1); // comments stay readable
});

test("a verdict cached from the feed blurs the post page with no new request", async ({ ext }) => {
  ext.redditBlur = true;
  const feed = await ext.context.newPage();
  await feed.goto("https://www.reddit.com/r/test/");
  await expect.poll(() => state(feed, "ai1")).toBe("ai");
  const before = ext.fetched.length;
  const page = await ext.context.newPage();
  await page.goto("https://www.reddit.com/r/test/comments/ai1/x/");
  await expect.poll(() => state(page, "ai1"), { timeout: 1500 }).toBe("ai");
  expect(ext.fetched.length).toBe(before);
});

test("falls back to the HTML partial when Reddit blocks the JSON API", async ({ ext }) => {
  ext.blockJson = true;
  const page = await ext.context.newPage();
  await page.goto("https://www.reddit.com/r/test/");
  await expect.poll(() => state(page, "ai1")).toBe("ai");
  await scrollTo(page, "clean1");
  await expect.poll(() => state(page, "clean1")).toBe("clean");
  await expect(page.locator("article:has(#t3_ai1) > .rab-overlay")).toHaveAttribute("title", /\(\+180\) "is this AI/i);
  // The first 403 switches the session over (the two concurrent requests
  // already in flight may both 403); later posts go straight to the partial.
  const jsonTries = ext.fetched.length;
  expect(jsonTries).toBeLessThanOrEqual(2);
  await scrollTo(page, "loose");
  await expect.poll(() => state(page, "loose")).toBe("ai");
  expect(ext.fetched).toHaveLength(jsonTries);
  expect(ext.partials).toEqual(expect.arrayContaining(["ai1", "clean1", "loose"]));
  expect(await page.title()).not.toBe("partial script ran");
});

test("fallback never blurs on hidden scores (served as score 1)", async ({ ext }) => {
  ext.blockJson = true;
  ext.fakeScores = true;
  const page = await ext.context.newPage();
  await page.goto("https://www.reddit.com/r/test/");
  await expect.poll(() => state(page, "ai1")).toBe("clean");
  await expect(page.locator(".rab-overlay")).toHaveCount(0);
});

test("hot reload: editing a file reloads the extension and open Reddit tabs", async () => {
  test.setTimeout(90e3);
  // Work on a copy so the test can edit files, on its own port so a running
  // `npm run dev` does not interfere.
  const dir = mkdtempSync(join(tmpdir(), "rab-hot-"));
  cpSync(process.env.RAB_EXT || join(ROOT, "extension"), dir, { recursive: true });
  const bg = join(dir, "background.js");
  writeFileSync(bg, readFileSync(bg, "utf8").replace("127.0.0.1:8791", "127.0.0.1:8799"));

  // Browser first, server second: the worker's first connect fails, so this
  // also proves the alarm picks up a dev server started after Chrome.
  const ext = await launch(dir);
  const { context } = ext;
  const server = spawn(process.execPath, [join(ROOT, "dev/hot-reload-server.mjs"), dir], {
    env: { ...process.env, HOT_PORT: "8799" },
  });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  try {
    const page = await context.newPage();
    await page.goto("https://www.reddit.com/r/test/");
    await expect.poll(() => state(page, "ai1")).toBe("ai");
    await expect.poll(() => log, { timeout: 45e3, intervals: [500] }).toContain("extension connected");

    const pill = page.locator("article:has(#t3_ai1) .rab-pill");
    const reloaded = page.waitForEvent("load", { timeout: 20e3 });
    appendFileSync(join(dir, "content.css"), "\n.rab-pill { outline: 3px solid rgb(1, 2, 3); }\n");
    await reloaded;

    await expect.poll(() => pill.evaluate((e) => getComputedStyle(e).outlineColor).catch(() => "")).toBe("rgb(1, 2, 3)");
    // The reload cleared cached verdicts, so the post is judged again by the
    // new code rather than served from the cache.
    await expect.poll(() => ext.fetched.filter((id) => id === "ai1").length).toBe(2);
  } finally {
    await ext.close();
    server.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

const comment = (page, id) => page.locator(`[thingid="t1_${id}"], [data-fullname="t1_${id}"]`).first();
const commentState = (page, id) => comment(page, id).getAttribute("data-rab-comment");

// The popup, opened as a page of the extension.
async function openPopup(ext) {
  const id = ext.context.serviceWorkers()[0].url().split("/")[2];
  const popup = await ext.context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await expect(popup.locator("#stats")).toContainText("checked");
  return popup;
}

test("hides comments that replies call out as AI-written, with Reddit's spoiler and a badge", async ({ ext }) => {
  ext.redditSpoiler = true;
  const page = await ext.context.newPage();
  await page.goto("https://www.reddit.com/r/test/comments/thread1/x/");
  await expect.poll(() => commentState(page, "c1")).toBe("ai");
  for (const id of ["c2", "c3", "c4"]) expect(await commentState(page, id)).toBe("clean");
  expect(await commentState(page, "c5")).toBe("ai"); // bot callouts count by default

  // The badge sits right after the author's name, with the reply as its title.
  const meta = comment(page, "c1").locator("[slot=commentMeta]").first();
  const badge = meta.locator(".author-hovercard-trigger + .rab-badge");
  await expect(badge).toHaveText("Potential AI");
  await expect(badge).toHaveAttribute("title", /\(\+300\) "This reads like ChatGPT"/);
  await expect(page.locator(".rab-badge")).toHaveCount(2);

  // Each paragraph gets its own spoiler; the replies stay readable.
  const body = comment(page, "c1").locator("[slot=comment]").first();
  const spoilers = body.locator("shreddit-spoiler.rab-spoiler");
  await expect(spoilers).toHaveCount(2);
  await expect(spoilers.first()).toHaveAttribute("embed-obscured", "");
  await expect(comment(page, "r1").locator("shreddit-spoiler")).toHaveCount(0);

  // Revealing one paragraph reveals the whole comment.
  await spoilers.first().click();
  await expect.poll(() => commentState(page, "c1")).toBe("revealed");
  await expect(spoilers.nth(1)).not.toHaveAttribute("embed-obscured", "");
  expect(page.url()).toContain("/thread1/");
});

test("comment fallback spoiler: a bar that hides links until revealed", async ({ ext }) => {
  const page = await ext.context.newPage();
  await page.goto("https://www.reddit.com/r/test/comments/thread1/x/");
  await expect.poll(() => commentState(page, "c1")).toBe("ai");
  const spoilers = comment(page, "c1").locator("[slot=comment]").first().locator("span.rab-spoiler");
  await expect(spoilers).toHaveCount(2);
  expect(await spoilers.first().locator(".rab-spoiler-inner").evaluate((e) => getComputedStyle(e).opacity)).toBe("0");
  await spoilers.nth(1).locator("a").click(); // swallowed: reveals instead of following
  await expect.poll(() => commentState(page, "c1")).toBe("revealed");
  expect(page.url()).toContain("/thread1/");
  await expect(spoilers.first()).toHaveClass(/rab-revealed/);
  expect(await spoilers.first().locator(".rab-spoiler-inner").evaluate((e) => getComputedStyle(e).opacity)).toBe("1");
});

test("popup: collapse style, bot callouts off, comments off; each applies live", async ({ ext }) => {
  const page = await ext.context.newPage();
  await page.goto("https://www.reddit.com/r/test/comments/thread1/x/");
  await expect.poll(() => commentState(page, "c1")).toBe("ai");
  const popup = await openPopup(ext);

  await popup.getByText("Collapsed", { exact: true }).click();
  const details = comment(page, "c1").locator(":scope > details");
  await expect.poll(() => details.evaluate((d) => d.open)).toBe(false);
  await expect(comment(page, "c1").locator(".rab-spoiler")).toHaveCount(0);
  await expect(comment(page, "c1").locator(".rab-badge")).toHaveText("Potential AI");

  await popup.locator("[data-setting=bots]").click();
  await expect.poll(() => commentState(page, "c5")).toBe("clean");
  expect(await commentState(page, "c1")).toBe("ai"); // the AI callout still counts

  await popup.locator("[data-setting=comments]").click();
  await expect(page.locator(".rab-badge")).toHaveCount(0);
  await expect.poll(() => details.evaluate((d) => d.open)).toBe(true);
  await expect(popup.locator("[data-group=commentStyle]")).toHaveClass(/off/);

  // Switching back on changes nothing in the page, yet the comments are
  // judged again. The wait outlasts the 250 ms scan that lifting the badges
  // queued, so that scan cannot be what re-judges them.
  await page.waitForTimeout(600);
  expect(await commentState(page, "c1")).toBeNull();
  await popup.locator("[data-setting=comments]").click();
  await expect.poll(() => commentState(page, "c1")).toBe("ai");
  await expect(comment(page, "c1").locator(".rab-badge")).toHaveCount(1);
});

test("old reddit comments get the flair badge and the fallback spoiler", async ({ ext }) => {
  const page = await ext.context.newPage();
  await page.goto("https://old.reddit.com/r/test/comments/thread1/x/");
  await expect.poll(() => commentState(page, "c1")).toBe("ai");
  for (const id of ["c2", "c3", "c4"]) expect(await commentState(page, id)).toBe("clean");
  await expect(comment(page, "c1").locator(":scope > .entry .tagline .author + .flair.rab-badge")).toHaveText("Potential AI");
  await expect(comment(page, "c1").locator(":scope > .entry .md span.rab-spoiler")).toHaveCount(2);
});

test("popup: posts off lifts the blur, on restores it from cache; strictness re-judges", async ({ ext }) => {
  const page = await ext.context.newPage();
  await page.goto("https://www.reddit.com/r/test/");
  await expect.poll(() => state(page, "ai1")).toBe("ai");
  await scrollTo(page, "lowvote");
  await expect.poll(() => state(page, "lowvote")).toBe("ai");
  const popup = await openPopup(ext);
  await expect(popup.locator("#flagged")).toHaveText("2");
  await expect(popup.locator("#checked")).toHaveText("2");

  await popup.locator("[data-setting=posts]").click();
  await expect(popup.locator("[data-setting=posts]")).toHaveAttribute("aria-checked", "false");
  await expect(page.locator(".rab-overlay")).toHaveCount(0);
  await expect.poll(() => state(page, "lowvote")).toBe("off");
  expect(await page.locator("#t3_ai1").evaluate((e) => getComputedStyle(e).filter)).toBe("none");
  // A verdict written meanwhile (by another tab, or a fetch already in
  // flight) does not blur either.
  await popup.evaluate(() => chrome.storage.local.set({ "p:lowvote": { v: 1, m: "x", t: Date.now(), n: 9 } }));
  await page.waitForTimeout(300);
  expect(await state(page, "lowvote")).toBe("off");
  await expect(page.locator(".rab-overlay")).toHaveCount(0);

  const before = ext.fetched.length;
  await popup.locator("[data-setting=posts]").click();
  await expect.poll(() => state(page, "ai1")).toBe("ai");
  expect(ext.fetched.length).toBe(before);

  // Strict needs 35% of the top comment: lowvote's +120 against +500 fails.
  await popup.getByText("Strict", { exact: true }).click();
  await expect(popup.locator("#strictness-hint")).toHaveText("Needs +10 and 35% of the top comment");
  await expect.poll(() => state(page, "lowvote")).toBe("clean");
  expect(ext.fetched.length).toBeGreaterThan(before);

  await popup.locator("#clear").click();
  await expect(popup.locator("#flagged")).toHaveText("0");
  await expect(popup.locator("#checked")).toHaveText("0");
  await expect(popup.locator("#clear")).toHaveText("Cache cleared");
});
