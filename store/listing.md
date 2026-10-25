# Chrome Web Store listing

Submitted 2026-10-24 as item `aodlcenmoieibegbgdcjhaefbibddahc` under publisher **312.dev LLC**
(trader account, verified through the 312.DEV LLC payments profile; contact `ope@312.dev`),
version 0.3.0, set to publish automatically once review passes. Category: Social Networking.
Dashboard: https://chrome.google.com/webstore/devconsole/b87e7ec3-6107-4af9-a622-8c6b7a7ce61b/aodlcenmoieibegbgdcjhaefbibddahc/edit

Everything the developer dashboard asks for, ready to paste. Build the upload with
`npm run package` (writes `dist/quorum-<version>.zip`); images are in this folder.

## Store listing tab

**Name** (from the manifest, 53 of 75 characters)

    Quorum for Reddit: Community-Verified AI & Bot Filter

**Summary** (the manifest description, 120 of 132 characters)

    Hides Reddit posts and comments that well-upvoted comments call out as AI or bots, behind Reddit's own blur and spoiler.

**Description**

    Reddit's comments usually figure it out first. Someone spots the six-fingered hand, the ChatGPT
    phrasing or the karma-farming account, and the thread upvotes them. Quorum acts on that verdict
    for you: when a well-upvoted comment calls a post out as AI or a bot, the post is blurred with a
    "Potential AI" label before you scroll past it. Tap to see it anyway.

    Not a detector. Quorum never guesses from the pixels. It only acts when the community has reached
    a quorum: a callout needs real upvotes, a fair share of the top comment's score, and must
    outscore anyone saying "it's real". Controversial comments don't count.

    WHAT IT DOES
    • Blurs the media of posts the comments call out, in your feed and on the post itself
    • Hides comments that replies call out as AI-written ("this reads like ChatGPT"), behind a
      spoiler bar with a "Potential AI" badge by the author
    • Catches bot and karma-farming callouts ("OP is a bot"), and gives weight to them when the
      poster's account looks like a fresh karma farm
    • Works on new and old Reddit

    YOU SET THE BAR
    • Turn post blurring and comment hiding on or off
    • Spoiler or collapse for hidden comments
    • Lenient, normal or strict vote thresholds
    • How long a post must stay on screen before it's checked, so fast scrolling costs nothing
    • Ban subreddits: their posts and suggestions vanish from feeds, search and the sidebar, and
      visiting one shows a ban screen

    PRIVATE BY DESIGN
    Everything runs in your browser. No account, no server, no analytics. Quorum reads Reddit's
    comments from Reddit itself and keeps its verdicts on your device. Open source:
    https://github.com/312-dev/quorum

    Quorum is an independent project, not made by or affiliated with Reddit.

**Category:** Social Networking

**Language:** English

**Graphics**

| Asset | File | Required |
|---|---|---|
| Store icon, 128x128 | `extension/icons/icon-128.png` | yes |
| Screenshots, 1280x800 | `store/screenshot-1.png` to `store/screenshot-5.png` | at least one |
| Small promo tile, 440x280 | `store/promo-small.png` | no, but listings without one rank lower |
| Marquee, 1400x560 | `store/promo-marquee.png` | no; only for featuring |

**Homepage URL:** https://github.com/312-dev/quorum
**Support URL:** https://github.com/312-dev/quorum/issues

## Privacy practices tab

**Single purpose**

    Hides Reddit posts and comments that other Reddit commenters have called out as AI-generated or
    as bots, based on how well those callouts are upvoted.

**Permission justifications**

| Permission | Justification |
|---|---|
| `storage` | Caches each post's verdict and the user's options locally, so posts are not re-checked on every visit and settings persist. |
| Host: `*://www.reddit.com/*`, `*://old.reddit.com/*` | The content script runs only on Reddit to find posts and comments, and fetches a post's comments from reddit.com to read whether commenters call it out. No other sites are accessed. |

**Remote code:** No, I am not using remote code. (All scripts and fonts are packaged.)

**Data usage disclosures.** The extension reads Reddit page content and fetches Reddit comments,
and caches post IDs and short quotes locally. Nothing is transmitted off the device except normal
requests to reddit.com. Tick:

- **Website content** (it reads Reddit posts and comments to decide what to hide)

Leave every other category unticked (no personally identifiable, health, financial,
authentication, personal communication, location, web history or user activity data is
collected). Tick all three certifications: not sold to third parties, not used for purposes
unrelated to the single purpose, not used for creditworthiness or lending.

**Privacy policy URL:** https://github.com/312-dev/quorum/blob/main/PRIVACY.md

## Before submitting

- A developer account (one-time US$5 registration) with a verified contact email.
- The name and description use "Reddit". Reddit's Developer Terms (§5.3) require prior written
  consent to use its trademarks in an app's name or materials; ask licensing@reddit.com, or drop
  "for Reddit" from the name, before publishing.
- Bump `version` in `extension/manifest.json` for every upload; the store rejects a version it has
  already seen.
