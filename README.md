# Reddit AI Blur

Chrome extension (MV3) that blurs Reddit posts whose comments call them out as AI or as bot /
karma-farming posts, using Reddit's own NSFW blur with the button relabelled `Potential AI`. Click it to reveal the post. Works in feeds
and on a post's own page. r/isthisAI is a good place to try it.

## Install

1. `chrome://extensions`, turn on **Developer mode**, **Load unpacked**, pick `extension/`.
2. Optional hot reload: `npm install`, then `npm run dev`. Saving any file under `extension/`
   reloads the extension and every open Reddit tab. Chrome can be open before or after the dev
   server starts; the worker retries every 30 s. Replacing the whole directory (a checkout, a
   copy) is fine too: the server waits for `manifest.json` to be back, then watches it afresh.

## How it decides

- A post's comments are fetched only after the post has stayed in the middle half of the screen
  for 2 s (`DWELL_MS`), so posts flicked past while scrolling cost nothing. At most 2 fetches run
  at a time, and a queued post that leaves the middle before its turn is dropped until it dwells
  again. Posts with 0 comments are never fetched. On a post's own page the post is checked at once.
- Comments come from `/comments/<id>.json` (top 100, depth 3). If Reddit answers that with its 403
  "blocked by network security" page, the tab switches to the comments-only HTML partial
  (`/svc/shreddit/comments/...`, top-sorted, about 25 comments). Reddit renders the partial's
  first thread and defers the rest inside a nested `<template>`; the parser reads both.
- A comment counts only if it matches a phrase in `extension/detect.js` ("is this AI", "AI slop",
  "looks like AI", "done with AI", or a reply that opens with the verdict, like "AI, look at the
  hands") **and** is reputable: not marked controversial, score visible, at least 5 points and at
  least 20% of the thread's top comment (`MIN_SCORE`, `REL_SCORE`). The HTML partial reports
  hidden scores as 1, so those never qualify.
- Bot callouts count the same way: "OP is a bot", "you are a karma farming bot", "this is a bot
  account", or a reply opening with "Bot." or "Karma farming.". Remarks about bots in general ("95%
  of this site is repost bots", "a karma farm bot fest") and bots describing themselves ("I am a
  bot", "...performed automatically") do not.
- Account signals: when a callout fails only the 20% bar, the extension reads the poster's account
  from Reddit's author hover card (`/svc/shreddit/user-hover-card/<name>`: cake day, post and
  comment karma; about 300 KB, so only then, cached per author for 7 days). An account under 90
  days old with post karma of at least 1,000 and 5 times its comment karma lowers the bar to 5% of
  the top comment (`isBotLikeAccount`, `BOT_REL_SCORE`); the 5-point floor and consensus still
  apply, and an account never blurs a post on its own. New Reddit only.
- Consensus: the callout must also outscore every visible, non-controversial comment saying the
  post is real ("Not AI", "Real.", "it's a real photo", but not "a real photo for reference"). A
  comment that says both counts as a denial.
- Verdicts are cached in `chrome.storage.local`, shared across tabs: flagged posts for 7 days, clean
  posts for 1 hour or until they gain 10 more comments. Installing, updating or reloading the
  extension clears them, so no post is judged by older rules. A cached verdict is applied as soon as the
  post comes near the screen, with no dwell, so a post flagged in the feed is already blurred when
  you open it.

Each post carries `data-rab-state` (`seen`, `pending`, `clean`, `ai`, `revealed`, `error`,
`queued-offscreen`) for debugging in DevTools.

## How it blurs

Like Reddit's NSFW posts, only the media or text is blurred; the title, flair and vote/comment row
stay readable. The contents of the post's media box (`[slot=post-media-container]`, which keeps its
own border) or text body go into the `revealed` slot of Reddit's own
`<shreddit-blurred-container reason="nsfw">`, so the blur, scrim, pill and click to reveal are
Reddit's; text posts get Reddit's 88px blurred strip (`is-richtext-content`). A post with neither is
wrapped whole. The extension only swaps the pill's text, from a `MutationObserver` on the
component's shadow root so Reddit's "View NSFW content" never paints. Old Reddit has no such
component, so `content.css` draws a plain overlay over the whole row using the component's
measured values (40px blur, `rgba(0,0,0,.8)` fill, `.6` scrim, 32px media pill).

## Tests

```sh
npm install && npx playwright install chromium
npm test
```

Playwright loads the unpacked extension into Chromium and serves Reddit pages and comment data from
`tests/fixtures/` through request interception, so runs never touch reddit.com. Covered: detection
phrases (AI and bot), the vote filter, consensus and the account test, including real r/isthisAI
threads and hover-card numbers (unit); the account lookup and when it is skipped; dwell-gated
fetching and fast scrolling; Reddit's blur component (against a stand-in in
`tests/fixtures/mock-blurred-container.js`) on media and text posts, in the feed and on a post's
own page; the fallback overlay; click to reveal; caching across reloads, tabs and pages; old
Reddit; the JSON-to-partial fallback, including deferred comments; hidden scores; and hot reload
end to end, including the cache being cleared (about 30 s, since it waits on the worker's
reconnect alarm). Setting `RAB_EXT=<dir>` runs the tests against another copy of the extension.

Two environment details the tests handle, in case you drive Chromium yourself:

- Under WSLg, a set `WAYLAND_DISPLAY` stops headless Chromium from producing frames, so
  `IntersectionObserver` and Playwright clicks hang. `playwright.config.js` unsets it.
- Chrome disables an unpacked extension that calls `chrome.runtime.reload()` unless Developer mode
  is on, which a fresh profile has off. The tests seed it on in the profile's `Preferences`.
