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
  // stand-in for Reddit's blur component on the page.
  const ext = { context, fetched: [], partials: [], hoverCards: [], blockJson: false, fakeScores: false, redditBlur: false };
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
    const page = url.hostname.startsWith("old.") ? "old.html" : url.pathname.includes("/comments/") ? "post.html" : "feed.html";
    let body = readFileSync(join(FIXTURES, page), "utf8");
    if (ext.redditBlur) {
      const mock = readFileSync(join(FIXTURES, "mock-blurred-container.js"), "utf8");
      body = body.replace("</head>", `<script>${mock}</script></head>`);
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
