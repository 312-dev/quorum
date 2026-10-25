// Watches feed posts as they scroll, fetches the comments of each post that
// rests in the middle of the screen, and blurs its media behind Reddit's own
// NSFW blur, relabelled "Potential AI", when a well-upvoted, non-controversial
// comment calls it out as AI (rules in detect.js). Verdicts are cached in
// chrome.storage.local so a post is fetched at most once per TTL across every
// tab. On a comments page, a comment whose replies call it out as AI-written
// is hidden behind Reddit's spoiler (or collapsed) and badged "Potential AI".
// Options come from the toolbar popup (settings.js) and apply live.
(() => {
  const { pickReputableMention, findAiMention, findCommentMention, isCommentDenial, isBotLikeAccount, BOT_REL_SCORE } =
    globalThis.RAB_DETECT;
  const { DEFAULTS, STRICTNESS, RULE_KEYS, loadSettings } = globalThis.RAB_SETTINGS;
  let settings = { ...DEFAULTS };

  const IS_OLD = location.hostname.startsWith("old.");
  const SELECTOR = IS_OLD ? ".thing.link[data-fullname^='t3_']" : "shreddit-post[id^='t3_']";
  const POS_TTL = 7 * 24 * 3600e3; // a flagged post stays flagged for a week
  const NEG_TTL = 60 * 60e3; // a clean post is rechecked after an hour...
  const NEG_GROWTH = 10; // ...or once it has gained this many comments
  const FAIL_BACKOFF = 60e3;
  const MAX_CONCURRENT = 2;
  const JSON_URL = (id) =>
    `${location.origin}/comments/${id}.json?limit=100&depth=3&sort=top&raw_json=1`;
  // The comments-only HTML partial New Reddit lazy-loads under a post. Used
  // when Reddit answers the JSON API with its 403 "blocked by network
  // security" page, which it does for clients it suspects of automation.
  const PARTIAL_URL = (id, sub) =>
    `${location.origin}/svc/shreddit/comments/${sub}/t3_${id}?render-mode=partial&sort=top`;
  let useJson = true; // flips to the partial for the rest of the page session
  // Reddit's author hover card: the account's cake day and post and comment
  // karma. About 300 KB, so it is fetched only when it could change a verdict
  // and cached per author for ACCOUNT_TTL.
  const HOVER_CARD_URL = (name) =>
    `${location.origin}/svc/shreddit/user-hover-card/${encodeURIComponent(name)}`;
  const ACCOUNT_TTL = 7 * 24 * 3600e3;
  const accounts = new Map(); // author -> { created, postKarma, commentKarma, t }

  const mem = new Map(); // id -> { v: 0|1, m: snippet, src, read, t: ms, n: commentCount }
  const els = new Map(); // id -> post element
  const focused = new Set(); // ids in the middle half of the screen
  const dwellTimers = new Map();
  const inflight = new Set();
  const failedAt = new Map();
  const revealed = new Set();
  const undos = new Map(); // id -> removes the post's blur
  const queue = [];
  let active = 0;
  let pausedUntil = 0;

  function postInfo(el) {
    if (IS_OLD) {
      return { id: el.dataset.fullname.slice(3), comments: +el.dataset.numComments || 0 };
    }
    return {
      id: el.id.slice(3),
      comments: +el.getAttribute("comment-count") || 0,
      sub: el.getAttribute("subreddit-prefixed-name") || el.getAttribute("permalink")?.split("/").slice(1, 3).join("/"),
      author: el.getAttribute("author"),
    };
  }

  function isFresh(entry, comments) {
    if (!entry) return false;
    const age = Date.now() - entry.t;
    if (entry.v) return age < POS_TTL;
    return age < NEG_TTL && comments < entry.n + NEG_GROWTH;
  }

  // One read of the whole cache at startup is cheaper than a storage round trip
  // per post; expired entries are dropped on the way in.
  const cacheReady = chrome.storage.local.get(null).then((all) => {
    const stale = [];
    const now = Date.now();
    for (const [k, e] of Object.entries(all)) {
      if (k.startsWith("a:")) {
        if (now - e.t > ACCOUNT_TTL) stale.push(k);
        else accounts.set(k.slice(2), e);
        continue;
      }
      if (!k.startsWith("p:")) continue;
      if (now - e.t > (e.v ? POS_TTL : NEG_TTL * 24)) stale.push(k);
      else mem.set(k.slice(2), e);
    }
    if (stale.length) chrome.storage.local.remove(stale);
  });
  const ready = Promise.all([cacheReady, loadSettings().then((s) => (settings = s))]);

  // The vote bar and phrase test for posts under the current settings.
  const postRules = () => ({ ...STRICTNESS[settings.strictness], find: (t) => findAiMention(t, settings) });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const [k, { newValue }] of Object.entries(changes)) {
      if (!k.startsWith("p:")) continue;
      const id = k.slice(2);
      if (!newValue) {
        mem.delete(id); // cleared from the popup
        continue;
      }
      mem.set(id, newValue);
      if (els.has(id)) render(id);
    }
  });

  // A change in the popup reaches every open tab, and every blur is lifted
  // and re-applied under the new settings. On a rule change the popup clears
  // the stored verdicts first; their removal (above) drops them here too, so
  // the posts are judged again.
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "sync" || !changes.settings) return;
    await ready;
    const prev = settings;
    settings = { ...DEFAULTS, ...changes.settings.newValue };
    const changed = (k) => prev[k] !== settings[k];
    if (["posts", ...RULE_KEYS].some(changed)) {
      for (const id of [...undos.keys()]) unflag(id);
      for (const id of els.keys()) {
        if (focused.has(id)) check(id);
        else showCached(id);
      }
    }
    if (["comments", "commentStyle", ...RULE_KEYS].some(changed)) {
      for (const id of [...commentUndos.keys()]) unhideComment(id);
      judged.clear();
      scanComments();
    }
  });

  function setState(id, state) {
    els.get(id)?.setAttribute("data-rab-state", state);
  }

  // Applies a cached verdict, which costs no request. Returns true when there
  // is nothing left to fetch for the post.
  async function showCached(id) {
    await ready;
    const el = els.get(id);
    if (!el) return true;
    if (!settings.posts) {
      setState(id, "off");
      return true;
    }
    const { comments } = postInfo(el);
    if (isFresh(mem.get(id), comments)) {
      render(id);
      return true;
    }
    if (comments === 0) {
      setState(id, "clean");
      return true;
    }
    return false;
  }

  async function check(id) {
    if (await showCached(id)) return; // also covers posts switched off
    if (inflight.has(id) || queue.includes(id)) return;
    if (Date.now() - (failedAt.get(id) || 0) < FAIL_BACKOFF) return;
    setState(id, "pending");
    queue.push(id);
    pump();
  }

  function pump() {
    while (active < MAX_CONCURRENT && queue.length) {
      const wait = pausedUntil - Date.now();
      if (wait > 0) return void setTimeout(pump, wait);
      const id = queue.shift();
      // Left the middle of the screen before its turn: drop it; it re-queues
      // after another full dwell.
      if (!focused.has(id)) {
        setState(id, "queued-offscreen");
        continue;
      }
      active++;
      inflight.add(id);
      fetchVerdict(id).finally(() => {
        active--;
        inflight.delete(id);
        pump();
      });
    }
  }

  async function fetchVerdict(id) {
    const { sub } = postInfo(els.get(id));
    const json = useJson || IS_OLD || !sub; // old Reddit has no partial endpoint
    let res;
    try {
      res = await fetch(json ? JSON_URL(id) : PARTIAL_URL(id, sub), { credentials: "include" });
    } catch {
      failedAt.set(id, Date.now());
      return setState(id, "error");
    }
    if (res.status === 429) {
      pausedUntil = Date.now() + (+res.headers.get("retry-after") || 30) * 1000;
      queue.unshift(id);
      return;
    }
    if (res.status === 403 && json && !IS_OLD && sub) {
      useJson = false;
      return fetchVerdict(id);
    }
    if (!res.ok) {
      failedAt.set(id, Date.now());
      return setState(id, "error");
    }
    const comments = json
      ? flattenListing((await res.json().catch(() => null))?.[1])
      : parsePartial(await res.text());
    const rules = postRules();
    let hit = pickReputableMention(comments, rules);
    let note = "";
    // A callout that fails only the relative vote bar is worth the account
    // lookup: a karma-farming poster lowers that bar.
    const { author } = postInfo(els.get(id));
    if (!hit && !IS_OLD && author && settings.bots) {
      const relaxed = pickReputableMention(comments, { ...rules, rel: BOT_REL_SCORE });
      if (relaxed && isBotLikeAccount(await accountFor(author))) {
        hit = relaxed;
        note = " · new karma-farming account";
      }
    }
    const entry = {
      v: hit ? 1 : 0,
      m: hit ? `(+${hit.score}) "${hit.snippet}"${note}` : "",
      src: json ? "json" : "partial", // which endpoint, and how many comments it gave
      read: comments.length,
      t: Date.now(),
      n: postInfo(els.get(id)).comments,
    };
    mem.set(id, entry);
    chrome.storage.local.set({ ["p:" + id]: entry });
    render(id);
  }

  // Returns the author's account facts from cache or the hover card, or null
  // if they cannot be read (deleted account, layout change, network error).
  async function accountFor(name) {
    const cached = accounts.get(name);
    if (cached && Date.now() - cached.t < ACCOUNT_TTL) return cached;
    let html;
    try {
      const res = await fetch(HOVER_CARD_URL(name), { credentials: "include" });
      if (!res.ok) return null;
      html = await res.text();
    } catch {
      return null;
    }
    const account = parseHoverCard(html);
    if (!account) return null;
    account.t = Date.now();
    accounts.set(name, account);
    chrome.storage.local.set({ ["a:" + name]: account });
    return account;
  }

  // The card's first karma-number is post karma, the second comment karma
  // ("7,962", "12.3k", "1.2M").
  function parseHoverCard(html) {
    const card = inert(html);
    const pick = (sel) => card.flatMap((root) => [...root.querySelectorAll(sel)]);
    const created = Date.parse(pick("[data-testid='cake-day']")[0]?.getAttribute("datetime"));
    const karma = pick("[data-testid='karma-number']").map((e) => {
      const m = e.textContent.trim().replace(/,/g, "").match(/^([\d.]+)\s*([kKmM]?)/);
      return m ? +m[1] * ({ k: 1e3, m: 1e6 }[m[2].toLowerCase()] || 1) : NaN;
    });
    if (!created || karma.length < 2 || karma.some(isNaN)) return null;
    return { created, postKarma: karma[0], commentKarma: karma[1] };
  }

  // Flattens the JSON comment tree (iteratively) so the vote filter can
  // compare every comment against the thread's top score.
  function flattenListing(listing) {
    const stack = [...(listing?.data?.children || [])];
    const comments = [];
    while (stack.length) {
      const node = stack.pop();
      if (node?.kind !== "t1") continue;
      comments.push(node.data);
      const kids = node.data.replies?.data?.children;
      if (kids) stack.push(...kids);
    }
    return comments;
  }

  // Parses Reddit HTML inside a <template>, which keeps it inert: nothing in it
  // runs or loads. Returns the top fragment plus the content of every nested
  // <template>, since Reddit defers parts of a page inside them (all comment
  // threads after the first, in the comments partial) and querySelectorAll
  // does not descend into template content.
  function inert(html) {
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    const fragments = (root) => [
      root,
      ...[...root.querySelectorAll("template")].flatMap((t) => fragments(t.content)),
    ];
    return fragments(tpl.content);
  }

  // Parses the comments partial into the JSON shape. The partial carries no
  // controversy flag, and it reports score 1 for comments whose score Reddit
  // is still hiding; those never clear the vote floor, so hidden scores
  // cannot blur.
  function parsePartial(html) {
    return inert(html)
      .flatMap((root) => [...root.querySelectorAll("shreddit-comment")])
      .map((c) => ({
        body: c.querySelector("[slot='comment']")?.textContent || "",
        score: +c.getAttribute("score") || 0,
        controversiality: 0,
        score_hidden: false,
      }));
  }

  function render(id) {
    const el = els.get(id);
    const entry = mem.get(id);
    if (!el || !entry) return;
    if (!settings.posts) return setState(id, "off");
    if (!entry.v) return setState(id, "clean");
    if (revealed.has(id)) return setState(id, "revealed");
    setState(id, "ai");
    flag(id, el, entry.m);
  }

  const LABEL = "Potential AI";
  const ARIA_LABEL = "Potential AI, click to reveal";

  function flag(id, el, snippet) {
    if (undos.has(id)) return;
    const title = snippet ? `Quorum reached: upvoted comment ${snippet}` : "";
    const undo = (!IS_OLD && blurWithReddit(id, el, title)) || blurWithOverlay(id, el, title);
    undos.set(id, undo);
  }

  function unflag(id) {
    undos.get(id)?.();
    undos.delete(id);
    setState(id, "seen");
  }

  // What Reddit blurs on an NSFW post: the contents of the media box (whose
  // own border stays crisp around the blur) or the text body, never the title,
  // flair or vote/comment row. A post with neither is wrapped whole.
  function blurTarget(post) {
    const media = post.querySelector(":scope > [slot='post-media-container']");
    if (media?.childElementCount) return { host: media, text: false };
    const body =
      post.querySelector(":scope > [slot='text-body'] [slot='text-body']") ||
      post.querySelector(":scope > [slot='text-body']");
    if (body?.childElementCount) return { host: body, text: true };
    return null;
  }

  // Reddit's own NSFW blur: the content goes in the "revealed" slot of a
  // <shreddit-blurred-container reason="nsfw">, which draws the blur, scrim and
  // pill and reveals on click; only the pill's label is ours. A content script
  // cannot reach the page's custom element registry or the component's
  // properties, so this goes through the DOM: :defined confirms the element
  // upgraded, and the component drops embed-obscured when revealed.
  function blurWithReddit(id, el, title) {
    const target = blurTarget(el);
    const host = target ? target.host : el.parentElement;
    const box = document.createElement("shreddit-blurred-container");
    box.className = "rab-blur";
    box.setAttribute("reason", "nsfw");
    box.setAttribute("mode", "wrap");
    box.setAttribute("blurred", "");
    // Reddit's text-post form: a fixed 88px blurred strip.
    if (target?.text) box.setAttribute("is-richtext-content", "");
    box.title = title;
    const content = target ? [...host.childNodes] : [el];
    if (target) host.append(box);
    else el.before(box);
    if (!box.matches(":defined")) {
      box.remove();
      return false;
    }
    const slot = document.createElement("div");
    slot.slot = "revealed";
    slot.append(...content);
    box.append(slot);
    // The component renders in a microtask after it connects. Relabelling from
    // a MutationObserver on its shadow root runs in the microtask right after,
    // so Reddit's own label never reaches a frame, and any re-render of the
    // button is relabelled too.
    const labeller = new MutationObserver(() => relabel(box));
    if (box.shadowRoot) labeller.observe(box.shadowRoot, { childList: true, subtree: true, characterData: true });
    relabel(box);
    const watcher = new MutationObserver(() => {
      if (box.hasAttribute("embed-obscured")) return;
      watcher.disconnect();
      labeller.disconnect();
      revealed.add(id);
      box.removeAttribute("title");
      setState(id, "revealed");
    });
    watcher.observe(box, { attributes: true, attributeFilter: ["embed-obscured"] });
    // Lifting the blur puts the content back where it was.
    return () => {
      watcher.disconnect();
      labeller.disconnect();
      box.replaceWith(...slot.childNodes);
    };
  }

  function relabel(box) {
    const button = box.shadowRoot?.querySelector("button");
    if (!button) return;
    const walk = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
    for (let t; (t = walk.nextNode()); ) {
      if (!t.data.trim()) continue;
      if (t.data !== LABEL) t.data = LABEL; // the guard stops our own write re-triggering
      break;
    }
    if (button.getAttribute("aria-label") !== ARIA_LABEL) button.setAttribute("aria-label", ARIA_LABEL);
  }

  // Fallback for old Reddit, which has no blur component: content.css copies
  // the component's measured styles onto a plain overlay. New Reddit renders
  // shreddit-post through a shadow root, so the overlay goes on its <article>
  // wrapper (or one we add); old Reddit's .thing is plain DOM.
  function wrapperFor(el) {
    if (IS_OLD) return el;
    const article = el.closest("article");
    if (article) return article;
    if (el.parentElement?.classList.contains("rab-wrap")) return el.parentElement;
    const wrap = document.createElement("div");
    wrap.className = "rab-wrap";
    el.before(wrap);
    wrap.append(el);
    return wrap;
  }

  function blurWithOverlay(id, el, title) {
    const wrap = wrapperFor(el);
    wrap.classList.add("rab-flagged");
    const overlay = document.createElement("div");
    overlay.className = "rab-overlay";
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "rab-pill";
    pill.textContent = LABEL;
    pill.setAttribute("aria-label", ARIA_LABEL);
    overlay.append(pill);
    overlay.title = title;
    const reveal = (e) => {
      e.preventDefault();
      e.stopPropagation();
      revealed.add(id);
      overlay.remove();
      wrap.classList.replace("rab-flagged", "rab-revealed");
      setState(id, "revealed");
    };
    overlay.addEventListener("click", reveal);
    wrap.append(overlay);
    return () => {
      overlay.remove();
      wrap.classList.remove("rab-flagged");
    };
  }

  // Comments. A comment is hidden when one of its direct replies calls it out
  // as AI-written (or as a bot) and that reply passes the same vote rules
  // among its sibling replies. Everything needed is already in the page, so
  // this costs no request; it reruns as more replies load.
  const C_SELECTOR = IS_OLD ? ".thing.comment" : "shreddit-comment[thingid]";
  const judged = new Map(); // comment id -> how many replies it was judged on
  const commentUndos = new Map(); // comment id -> lifts its spoiler or collapse and badge
  const BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, pre, td, th";

  const commentId = (el) => (IS_OLD ? el.dataset.fullname : el.getAttribute("thingid"));
  const parentCommentId = (el) =>
    IS_OLD ? el.parentElement?.closest(".thing.comment")?.dataset.fullname : el.getAttribute("parentid");

  // The comment's own body, never a reply's (replies are nested inside it).
  function ownBody(el) {
    if (IS_OLD) return el.querySelector(":scope > .entry .usertext-body .md");
    const body = el.querySelector("[slot='comment']");
    return body?.closest("shreddit-comment") === el ? body : null;
  }

  function commentData(el) {
    const body = ownBody(el)?.textContent || "";
    if (!IS_OLD) return { body, score: +el.getAttribute("score") || 0, controversiality: 0, score_hidden: false };
    // Old Reddit prints each score three ways (dislikes, unvoted, likes), with
    // the plain number in the title; a hidden score has none.
    const score = el.querySelector(":scope > .entry .tagline .score.unvoted");
    return {
      body,
      score: score ? +score.title || 0 : 0,
      score_hidden: !score,
      controversiality: el.classList.contains("controversial") ? 1 : 0,
    };
  }

  async function scanComments() {
    await ready;
    if (!settings.comments) return;
    const all = document.querySelectorAll(C_SELECTOR);
    const replies = new Map();
    for (const el of all) {
      const parent = parentCommentId(el);
      if (!parent) continue;
      if (!replies.has(parent)) replies.set(parent, []);
      replies.get(parent).push(el);
    }
    const rules = {
      ...STRICTNESS[settings.strictness],
      find: (t) => findCommentMention(t, settings),
      deny: isCommentDenial,
    };
    for (const el of all) {
      const id = commentId(el);
      const kids = replies.get(id);
      if (!kids || commentUndos.has(id) || judged.get(id) === kids.length) continue;
      judged.set(id, kids.length);
      const hit = pickReputableMention(kids.map(commentData), rules);
      el.setAttribute("data-rab-comment", hit ? "ai" : "clean");
      if (hit) hideComment(id, el, `Quorum reached: reply (+${hit.score}) "${hit.snippet}"`);
    }
  }

  function hideComment(id, el, title) {
    const undo = [addBadge(el, title)];
    undo.push(settings.commentStyle === "collapse" ? collapse(el) : spoil(el));
    commentUndos.set(id, () => undo.forEach((f) => f()));
  }

  function unhideComment(id) {
    commentUndos.get(id)?.();
    commentUndos.delete(id);
    document.querySelector(IS_OLD ? `.thing[data-fullname="${id}"]` : `shreddit-comment[thingid="${id}"]`)
      ?.removeAttribute("data-rab-comment");
  }

  // The label sits beside the author's name, styled as Reddit styles user
  // flair there (its own utility classes on New Reddit, .flair on old).
  function addBadge(el, title) {
    const badge = document.createElement("span");
    badge.textContent = LABEL;
    badge.title = title;
    let anchor;
    if (IS_OLD) {
      badge.className = "flair rab-badge";
      anchor = el.querySelector(":scope > .entry .tagline .author");
    } else {
      badge.className =
        "rab-badge bg-tone-4 inline-block max-w-full text-12 font-normal align-text-bottom box-border px-[6px] rounded-5 leading-4 ms-2xs";
      const meta = [...el.querySelectorAll("[slot='commentMeta']")].find((m) => m.closest("shreddit-comment") === el);
      const name = meta?.querySelector(".author-name-meta");
      anchor = name?.closest(".author-hovercard-trigger") || name;
    }
    if (!anchor) return () => {};
    anchor.after(badge);
    return () => badge.remove();
  }

  // Reddit's own collapse: the same <details> toggle its collapse button
  // flips, so the badge stays on the one-line row.
  function collapse(el) {
    if (IS_OLD) {
      if (!el.classList.contains("noncollapsed")) return () => {};
      el.classList.replace("noncollapsed", "collapsed");
      return () => el.classList.replace("collapsed", "noncollapsed");
    }
    const details = el.querySelector(":scope > details");
    if (!details?.open) return () => {};
    details.open = false;
    return () => (details.open = true);
  }

  // Reddit's spoiler: its <shreddit-spoiler> is inline, so each paragraph (or
  // list item, heading, cell) gets its own, and revealing one reveals the
  // rest. Where the component is missing (old Reddit), content.css draws the
  // same bar with its measured values.
  function spoil(el) {
    const body = ownBody(el);
    if (!body) return () => {};
    let blocks = [...body.querySelectorAll(BLOCKS)].filter((b) => !b.querySelector(BLOCKS));
    if (!blocks.length) blocks = [body];
    const native = !IS_OLD && isDefined("shreddit-spoiler");
    const spoilers = blocks.map((block) => {
      const sp = document.createElement(native ? "shreddit-spoiler" : "span");
      sp.classList.add("rab-spoiler");
      if (native) sp.append(...block.childNodes);
      else {
        const inner = document.createElement("span");
        inner.className = "rab-spoiler-inner";
        inner.append(...block.childNodes);
        sp.append(inner);
        sp.setAttribute("role", "button");
        sp.tabIndex = 0;
        sp.title = "Reveal spoiler";
      }
      block.append(sp);
      return sp;
    });
    const isHidden = (sp) => (native ? sp.hasAttribute("embed-obscured") : !sp.classList.contains("rab-revealed"));
    const revealAll = () => {
      for (const sp of spoilers) {
        if (!isHidden(sp)) continue;
        if (native) sp.shadowRoot?.querySelector(".outer")?.click();
        else sp.classList.add("rab-revealed");
      }
      el.setAttribute("data-rab-comment", "revealed");
    };
    let watcher = null;
    let onClick = null;
    if (native) {
      // The component drops embed-obscured when clicked open.
      watcher = new MutationObserver(() => spoilers.some((sp) => !isHidden(sp)) && revealAll());
      for (const sp of spoilers) watcher.observe(sp, { attributes: true, attributeFilter: ["embed-obscured"] });
    } else {
      onClick = (e) => {
        if (!e.target.closest?.(".rab-spoiler") || !spoilers.some(isHidden)) return;
        e.preventDefault(); // a link under the bar is not followed until revealed
        e.stopPropagation();
        revealAll();
      };
      body.addEventListener("click", onClick, true);
    }
    return () => {
      watcher?.disconnect();
      if (onClick) body.removeEventListener("click", onClick, true);
      for (const sp of spoilers) {
        const content = native ? sp : sp.firstChild;
        sp.replaceWith(...content.childNodes);
      }
    };
  }

  // A content script cannot read the page's custom element registry, but an
  // upgraded element matches :defined.
  const definedTags = new Map();
  function isDefined(tag) {
    if (definedTags.get(tag)) return true; // a miss is retried: Reddit may define it later
    const probe = document.createElement(tag);
    document.body.append(probe);
    const ok = probe.matches(":defined");
    probe.remove();
    definedTags.set(tag, ok);
    return ok;
  }

  // Two observers. Near the viewport, a cached verdict is applied at once so a
  // known post is blurred before it scrolls into view. Fetching waits until a
  // post has stayed in the middle half of the screen for the dwell setting
  // (2 s by default), so posts
  // flicked past while scrolling cost no request.
  const near = new IntersectionObserver(
    (entries) => {
      for (const { target, isIntersecting } of entries) {
        const { id } = postInfo(target);
        els.set(id, target);
        if (isIntersecting) showCached(id);
      }
    },
    { rootMargin: "200px 0px" }
  );

  const middle = new IntersectionObserver(
    (entries) => {
      for (const { target, isIntersecting } of entries) {
        const { id } = postInfo(target);
        els.set(id, target);
        clearTimeout(dwellTimers.get(id));
        if (isIntersecting) {
          focused.add(id);
          // The post a post page is about was opened on purpose: no dwell.
          const dwell = target.getAttribute("view-context") === "CommentsPage" ? 0 : settings.dwell * 1000;
          dwellTimers.set(id, setTimeout(() => focused.has(id) && check(id), dwell));
        } else {
          focused.delete(id);
        }
      }
    },
    { rootMargin: "-25% 0px -25% 0px" }
  );

  function scan() {
    for (const el of document.querySelectorAll(SELECTOR)) {
      if (el.hasAttribute("data-rab-state")) continue;
      el.setAttribute("data-rab-state", "seen");
      near.observe(el);
      middle.observe(el);
    }
  }

  // Infinite scroll adds posts, and comment pages add replies, in batches;
  // coalesce mutation bursts into one scan every 250 ms rather than walking
  // the DOM per mutation.
  let scanTimer = 0;
  new MutationObserver(() => {
    if (!scanTimer) scanTimer = setTimeout(() => ((scanTimer = 0), scan(), scanComments()), 250);
  }).observe(document.documentElement, { childList: true, subtree: true });
  scan();
  scanComments();
})();
