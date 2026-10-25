# Quorum for Reddit

Community-verified AI and bot filter. A Chrome extension (MV3) that blurs Reddit posts whose comments call them out as AI or as bot /
karma-farming posts, using Reddit's own NSFW blur with the button relabelled `Potential AI`. Click it to reveal the post. Works in feeds
and on a post's own page. On a comments page it also hides comments that replies call out as
AI-written, behind Reddit's spoiler bar with a `Potential AI` badge beside the author. Subreddits
you ban drop out of every listing, and their own pages show Reddit's banned-community screen.
r/isthisAI is a good place to try it.

## Install

1. `chrome://extensions`, turn on **Developer mode**, **Load unpacked**, pick `extension/`.
2. Optional hot reload: `npm install`, then `npm run dev`. Saving any file under `extension/`
   reloads the extension and every open Reddit tab. Chrome can be open before or after the dev
   server starts; the worker retries every 30 s. Replacing the whole directory (a checkout, a
   copy) is fine too: the server waits for `manifest.json` to be back, then watches it afresh.

## Options

Click the toolbar icon. On/off options are vote switches (upvote for on, downvote for off), and the
rule under the name tallies the cached posts: flagged in orange, clean in periwinkle. Changes apply at once in every open Reddit tab and sync with your Chrome
profile (`chrome.storage.sync`, defaults in `extension/settings.js`):

| Option | Default | |
|---|---|---|
| Posts | on | Blur posts that comments call out |
| Comments | on | Hide comments that replies call out |
| Hide comments as | Spoiler | Spoiler, or Reddit's own collapse |
| Bot callouts | on | Count bot and karma-farming callouts and the account check, not just AI ones |
| Strictness | Normal | Lenient: 3 points and 10% of the top comment; Normal: 5 and 20%; Strict: 10 and 35% |
| Wait before checking a post | 2 s | The dwell below; 0 to 5 s |
| Ban subreddits | none | Type names, `r/` names or links, separated by spaces or commas; remove with a chip's × |

Changing Bot callouts or Strictness clears the cached verdicts so posts are judged again. The panel
also shows how many cached posts are flagged and clears the cache (verdicts and accounts).

## Banned subreddits

A banned subreddit's posts and suggestions are removed (`display: none`, never blurred) wherever
New Reddit lists them: feeds (`shreddit-post`, with the divider after it), the "Discover
communities" cards, a post page's related posts, and search results; on old Reddit, any
`.thing.link` of it. Removed posts are never fetched. Any page under `/r/<name>/` gets a copy of
the modal Reddit shows on a subreddit it has banned (`<guard-community-modal>`, which Reddit only
loads on such pages), with its blurred backdrop and light and dark colours, saying the ban is
yours, and an Unban button beside Browse Other Communities. `BAN_UNITS` in `content.js` lists
the units; the modal's measurements are in `content.css`.

## How it decides

- A post's comments are fetched only after the post has stayed in the middle half of the screen
  for 2 s (the Wait option), so posts flicked past while scrolling cost nothing. At most 2 fetches run
  at a time, and a queued post that leaves the middle before its turn is dropped until it dwells
  again. Posts with 0 comments are never fetched. On a post's own page the post is checked at once.
- Comments come from `/comments/<id>.json` (top 100, depth 3). If Reddit answers that with its 403
  "blocked by network security" page, the tab switches to the comments-only HTML partial
  (`/svc/shreddit/comments/...`, top-sorted, about 25 comments). Reddit renders the partial's
  first thread and defers the rest inside a nested `<template>`; the parser reads both.
- A comment counts only if it matches a phrase in `extension/detect.js` ("is this AI", "AI slop",
  "looks like AI", "done with AI", or a reply that opens with the verdict, like "AI, look at the
  hands") **and** is reputable: not marked controversial, score visible, at least 5 points and at
  least 20% of the thread's top comment (Normal strictness; `STRICTNESS` in `settings.js`). The HTML partial reports
  hidden scores as 1, so those never qualify.
- Bot callouts count the same way: "OP is a bot", "you are a karma farming bot", "this is a bot
  account", or a reply opening with "Bot." or "Karma farming.". Remarks about bots in general ("95%
  of this site is repost bots", "a karma farm bot fest") and bots describing themselves ("I am a
  bot", "...performed automatically") do not.
- Account signals: when a callout fails only the relative bar (20% at Normal), the extension reads the poster's account
  from Reddit's author hover card (`/svc/shreddit/user-hover-card/<name>`: cake day, post and
  comment karma; about 300 KB, so only then, cached per author for 7 days). An account under 90
  days old with post karma of at least 1,000 and 5 times its comment karma lowers the bar to 5% of
  the top comment (`isBotLikeAccount`, `BOT_REL_SCORE`); the points floor and consensus still
  apply, and an account never blurs a post on its own. New Reddit only; skipped when Bot callouts
  is off.
- Consensus: the callout must also outscore every visible, non-controversial comment saying the
  post is real ("Not AI", "Real.", "it's a real photo", but not "a real photo for reference"). A
  comment that says both counts as a denial.
- Verdicts are cached in `chrome.storage.local`, shared across tabs: flagged posts for 7 days, clean
  posts for 1 hour or until they gain 10 more comments. Installing, updating or reloading the
  extension clears them, so no post is judged by older rules. A cached verdict is applied as soon as the
  post comes near the screen, with no dwell, so a post flagged in the feed is already blurred when
  you open it.

Comments are judged from the page itself, so they cost no request. A comment is hidden when one of
its direct replies says it was written by AI ("reads like ChatGPT", "written by an LLM", "thanks
ChatGPT", "the em dashes give it away", "ignore all previous instructions") or, with Bot callouts
on, calls its author a bot. The reply must pass the same vote rules among its sibling replies, and
a better-voted "not a bot" or "I wrote this myself" cancels it. Replies under a comment on a
picture post that only judge the picture ("AI.", "looks like AI") do not count against the
comment. Judging reruns as more replies load.

Each post carries `data-rab-state` (`seen`, `pending`, `clean`, `ai`, `revealed`, `off`, `error`,
`queued-offscreen`) and each judged comment `data-rab-comment` (`clean`, `ai`, `revealed`) for
debugging in DevTools.

## How it blurs

Like Reddit's NSFW posts, only the media or text is blurred; the title, flair and vote/comment row
stay readable. The contents of the post's media box (`[slot=post-media-container]`, which keeps its
own border) or text body go into the `revealed` slot of Reddit's own
`<shreddit-blurred-container reason="nsfw">`, so the blur, scrim, pill and click to reveal are
Reddit's; text posts get Reddit's 88px blurred strip (`is-richtext-content`). A post with neither is
wrapped whole. The extension only swaps the pill's text, from a `MutationObserver` on the
component's shadow root so Reddit's "View NSFW content" never paints. Should the component be
missing, `content.css` draws a plain overlay using its measured values (40px blur,
`rgba(0,0,0,.8)` fill, `.6` scrim, 32px media pill).

Old Reddit never blurred anything: an NSFW post there gets a stock thumbnail, a red `NSFW` stamp,
and media that stays shut on its own page. So its blur is made of those parts. A periwinkle
`POTENTIAL AI` `.stamp` leads the button row, the thumbnail is blurred (Reddit's stock icons too, so
a blurred thumbnail always means flagged), and a click on it opens the media instead of following
the link. Opened media or text is blurred under a stamp-styled "click to show" label, and one click
lifts the blur from it and the thumbnail. Reddit rebuilds the expando whenever it opens, so the blur
hangs off a class on the post rather than off nodes inside it.

A comment is hidden with Reddit's `<shreddit-spoiler>`, one per paragraph (the component is inline,
so it cannot wrap block paragraphs), and revealing any of them reveals the rest. The badge uses the
classes Reddit gives user flair in the same row. With "Collapsed", the comment's `<details>` is
closed, the toggle Reddit's own collapse button flips, so the badge stays visible on the one-line
row. Old Reddit gets its native `.flair` for the badge and its own spoiler markup,
`span.md-spoiler-text`, which its stylesheet draws (`#4f4f4f`) and its script reveals with a "Reveal
spoiler" tooltip; revealing one reveals the rest. Where `<shreddit-spoiler>` is missing on New
Reddit, `content.css` draws its bar with measured values (`#131313`, 2px corners).

## Design

The panel follows "Split Vote", a small design language taken from the icon, written up at the top
of `extension/popup.css`: upvote orange means on, downvote periwinkle means off and marks AI, one
2.5px stroke weight, a 3px gap where one shape sits on another, and numbers in mono. Its fonts
(Unbounded, Instrument Sans, JetBrains Mono, Latin subset) ship in `extension/fonts/` with their
SIL Open Font Licences, so opening the panel makes no network request.

## Icon

`extension/icons/icon.svg` is the source: a question mark in Reddit's two vote colours, the
orange half curling up into an upvote, the periwinkle half running down into a downvote, with the
AI sparkle as its dot. `node dev/export-icons.mjs` renders the 16, 32, 48 and 128 px PNGs the
manifest uses (the 128 px one with the 16 px padding the Chrome Web Store asks for).

## Publishing

`npm run package` writes `dist/quorum-<version>.zip`, the Chrome Web Store upload: `extension/`
without the dev hot reload (the `dev:start`/`dev:end` block in `background.js`) and without the
`alarms` permission only that block uses. `store/listing.md` holds every listing and privacy field
ready to paste, `store/*.png` the screenshots and promo images, and `PRIVACY.md` the privacy
policy the listing links to. Bump the manifest `version` for every upload.

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
Reddit's stamp, blurred thumbnail and media, and thumbnail click; comment callouts (unit), and
comment spoilers (against `tests/fixtures/mock-spoiler.js` and the fallback), badges, collapse and
old Reddit comments with its own spoiler; the popup's options applying live; banned subreddits across every listing unit and the ban screen; the JSON-to-partial fallback, including deferred comments; hidden scores; and hot reload
end to end, including the cache being cleared (about 30 s, since it waits on the worker's
reconnect alarm). Setting `RAB_EXT=<dir>` runs the tests against another copy of the extension; `RAB_EXT=$PWD/dist/build npx playwright test --grep-invert "hot reload"` checks the store build.

Two environment details the tests handle, in case you drive Chromium yourself:

- Under WSLg, a set `WAYLAND_DISPLAY` stops headless Chromium from producing frames, so
  `IntersectionObserver` and Playwright clicks hang. `playwright.config.js` unsets it.
- Chrome disables an unpacked extension that calls `chrome.runtime.reload()` unless Developer mode
  is on, which a fresh profile has off. The tests seed it on in the profile's `Preferences`.
