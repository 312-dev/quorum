# Quorum for Reddit: Privacy Policy

Last updated: 2026-10-25

Quorum is a browser extension that hides Reddit posts and comments that other commenters call out
as AI-generated or as bots. It does its work entirely in your browser. It has no server, no
account, no analytics and no tracking, and it never sends anything to its developer or to any
third party.

## What it reads

- **Reddit pages you open** on www.reddit.com and old.reddit.com, to find posts and comments.
- **Reddit comment data** for posts that stay on your screen for a moment, fetched from
  reddit.com itself (the same requests Reddit's own page makes), to see whether well-upvoted
  comments call a post out.
- **Public profile facts** (account age, post and comment karma) of a post's author, from Reddit's
  own profile card, only when a bot callout is borderline.

## What it stores, and where

Everything below stays on your device in Chrome's extension storage:

| Data | Why | Kept for |
|---|---|---|
| Post IDs with the verdict, the deciding comment's score and a short quote of it | so a post is not checked again on every visit | 7 days for flagged posts, 1 hour for clean ones |
| Author account age and karma | so an author's profile card is not fetched repeatedly | 7 days |
| Your options (on/off switches, strictness, wait time, banned subreddits) | to remember your choices | until you change them |

Your options are saved with `chrome.storage.sync`, so if you use Chrome Sync, Google syncs them
between your own browsers like any other extension setting. Nothing else is synced.

Use **Clear cache** in the extension's panel to delete the stored verdicts and account facts at
any time. Removing the extension deletes all of its data.

## What it sends

Nothing leaves your browser except the requests to reddit.com described above, which go to Reddit
under your own browser session, exactly as when you browse Reddit yourself. No data is sold,
shared, or used for advertising, credit or any purpose other than hiding called-out content for
you.

## Contact

Questions or concerns: open an issue at https://github.com/312-dev/quorum/issues.
