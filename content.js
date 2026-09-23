(() => {
  // Only run on X's two hostnames, matching the manifest's injection scope.
  if (location.hostname !== "x.com" && location.hostname !== "twitter.com") return;
  const platform = "X";
  const t = (key, ...substitutions) => {
    if (!alive()) {
      shutdown();
      return key;
    }
    try {
      return chrome.i18n.getMessage(key, substitutions.length ? substitutions : undefined) || key;
    } catch (error) {
      if (alive() && !String(error).includes("Extension context invalidated")) throw error;
      // 插件重载后旧页面脚本不能再调用扩展 API，停用旧监听，等待刷新后注入新版。
      shutdown();
      return key;
    }
  };

  const SITES = [
    {
      // The timeline, search, post detail, and replies all use the same article structure.
      item: 'article[data-testid="tweet"]',
      author: '[data-testid="User-Name"] a span',
      text: '[data-testid="tweetText"]:not(div[role="link"] [data-testid="tweetText"])',
      repost: 'div[role="link"] [data-testid="tweetText"]', // Quoted posts are classified separately from the author's own text.
      key: (el) => el.querySelector("a:has(> time)")?.getAttribute("href"),
      // When a promoted post has no timestamp link, anchor the badge after the @handle instead.
      anchor: (el) => el.querySelector("a:has(> time)") || el.querySelector('[data-testid="User-Name"] a[tabindex="-1"]'),
      body: '[data-testid="tweetText"]'
    }
  ];

  const KIND = () => ({
    hard_ad: t("kindHardAd"),
    soft_ad: t("kindSoftAd"),
    lead_gen: t("kindLeadGen"),
    organic: t("kindOrganic")
  });

  let settings = { enabled: true, mode: "label", keywords: [], smartMatch: true, authenticated: false, keySource: "server" };
  const canCheck = () => settings.enabled && (settings.authenticated || settings.keySource === "user");
  let settingsVersion = 0;
  // Threshold for meaning-based keyword matches: in practice "just briefly mentioned" scores around 0.7;
  // only 0.8+ reliably means the content is actually about the topic.
  const TOPIC_THRESHOLD = 0.8;
  const foldAds = () => settings.mode === "fold" || settings.mode === "blur"; // "blur" is a legacy setting name.

  // Literal (case-insensitive) keyword matches, including quoted post text and hashtags.
  function keywordHits(state) {
    const kws = (settings.keywords || []).filter((k) => typeof k === "string" && k.trim()); // Storage may contain stale/invalid entries.
    if (!kws.length || !state) return [];
    const hay = [state.author, state.title, state.text, state.reposted, (state.tags || []).join(" ")]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    return kws.filter((k) => {
      const low = k.toLowerCase().trim();
      // Latin/digit keywords match on word boundaries so "AI" doesn't match "Raider", "again", "said";
      // CJK keywords keep simple substring matching.
      if (/^[a-z0-9][a-z0-9 .+#-]*$/.test(low)) {
        const re = new RegExp(`(^|[^a-z0-9])${low.replace(/[.+#-]/g, "\\$&")}($|[^a-z0-9])`);
        return re.test(hay);
      }
      return hay.includes(low);
    });
  }

  const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // ---------- Content extraction ----------
  // Use textContent instead of innerText: innerText forces a synchronous layout on every read,
  // which gets slow with many posts on screen.
  const clean = (text) => text.replace(/[ \t\u00a0\u200b]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  // Translation extensions (Immersive Translate, etc.) inject translated text into the post body.
  // Strip it so we only classify the original text; otherwise the text doubles up and the
  // translated copy skews the AI-ratio estimate.
  const TRANSLATION = 'font[lang], [class*="immersive-translate"], [data-immersive-translate-walked] > font';
  const textOf = (root, sel) => {
    if (!sel) return "";
    const el = root.querySelector(sel);
    if (!el) return "";
    if (!el.querySelector(TRANSLATION)) return clean(el.textContent);
    const copy = el.cloneNode(true);
    copy.querySelectorAll(TRANSLATION).forEach((n) => n.remove());
    return clean(copy.textContent);
  };

  function extract(el, site) {
    const state = { platform };
    const author = textOf(el, site.author);
    const text = textOf(el, site.text).slice(0, 3000);
    const repost = textOf(el, site.repost).slice(0, 1500);
    if (text.length < 4) return null;
    if (author) state.author = author.slice(0, 60);
    if (text) state.text = text;
    if (repost) state.reposted = repost;
    // Pass along the platform's own ad/promo labels as extra context for the model.
    // X renders these in whatever language the user's page is set to, so both Chinese and English label text are matched here regardless of the extension's own UI locale.
    const marks = new Set();
    el.querySelectorAll("span, i, em").forEach((n) => {
      if (n.childElementCount) return;
      const label = n.textContent.trim();
      if (/^(广告|推广|赞助|品牌合作|商品|好物推荐|合作|Ad|Promoted|Sponsored|Boosted)$/.test(label)) marks.add(label);
    });
    if (marks.size) state.page_labels = [...marks].join("、");
    return state;
  }

  // ---------- Badge ----------
  function mountBadge(el, site) {
    let b = el.__jevBadge;
    if (b && b.isConnected) return b;
    const anchor = site.anchor(el);
    b = document.createElement("span");
    b.className = "jev-badge";
    b.dataset.placement = anchor ? "after" : "inside";
    b.setAttribute("role", "button");
    b.tabIndex = 0;
    if (!anchor) {
      el.classList.add("jev-host");
      el.appendChild(b);
    } else {
      anchor.after(b);
    }
    b.__jevItem = el; // Clicks are handled by the global capture-phase listener (see onPointCapture).
    b.addEventListener("mouseenter", () => tip.show(b));
    b.addEventListener("mouseleave", () => tip.hide());
    b.addEventListener("focus", () => tip.show(b));
    b.addEventListener("blur", () => tip.hide());
    el.__jevBadge = b;
    return b;
  }

  // Only show the AI-generated ratio on the badge once it's ≥ 50%, rounded to the nearest 10%
  // (the estimate has some margin of error, so we don't pretend to be more precise than that).
  const AI_BADGE_MIN = 0.5;
  const aiPct = (ai) => Math.round(ai * 10) * 10;

  function setBadge(b, state, label, ai) {
    b.dataset.state = state;
    b.textContent = label;
    if (typeof ai === "number" && ai >= AI_BADGE_MIN) {
      const seg = document.createElement("span");
      seg.className = "jev-ai-seg";
      seg.textContent = t("badgeAiApprox", String(aiPct(ai)));
      b.append(seg);
    }
  }

  // Badge text for each failure case.
  const ERROR_LABEL = () => ({
    upstream: t("badgeUnavailable"),
    network: t("badgeNetworkError"),
    bad_key: t("badgeCheckFailed")
  });
  const RETRY_AFTER_MS = 60_000;

  function render(el, site, res) {
    if (res && !res.ok && res.code === "quota") return onQuota(el, res.error);
    const b = mountBadge(el, site);
    el.classList.remove("jev-ad");
    b.__jevResult = res;
    b.__jevLiteral = el.__jevLiteral || [];
    if (!res || !res.ok) {
      setBadge(b, "error", ERROR_LABEL()[res?.code] || t("badgeCheckFailed"));
      applyFold(el, site, null); // Keywords matched literally are still folded, regardless of the classification result.
      return;
    }
    const r = res.result;
    const pct = Math.round(r.prob * 100);
    if (r.isAd) {
      const kind = r.kind === "organic" ? t("badgeAd") : KIND()[r.kind] || t("badgeAd");
      setBadge(b, "ad", `${kind} ${pct}%`, res.ai);
      el.classList.add("jev-ad");
    } else if (matchedKeywords(el, res).length) {
      setBadge(b, "kw", `${t("badgeBlocked")} · ${matchedKeywords(el, res)[0]}`, res.ai);
    } else {
      setBadge(b, "ok", t("badgeNotAd"), res.ai);
    }
    applyFold(el, site, res);
  }

  // Combines keywords matched literally and keywords matched by meaning.
  function matchedKeywords(el, res) {
    const semantic = Object.entries(res?.topics || {})
      .filter(([, p]) => p >= TOPIC_THRESHOLD)
      .map(([k]) => k);
    const all = [...(el.__jevLiteral || []), ...semantic];
    return all.filter((k, i) => all.findIndex((x) => x.toLowerCase() === k.toLowerCase()) === i);
  }

  // ---------- Folding: ads (in fold mode) or content matching a blocked keyword ----------

  // Content the user has expanded (keyed by content signature); stays expanded even if the page re-renders it.
  const revealed = new Set();
  // Content that has already been folded once (keyed by content signature), so the fold-in animation only plays once per post.
  const foldedSigs = new Set();

  function applyFold(el, site, res) {
    const r = res?.ok ? res.result : null;
    const kws = matchedKeywords(el, res);
    const adFold = r?.isAd && foldAds();
    if (!kws.length && !adFold) return unfold(el);

    const why = [];
    if (r?.isAd) why.push(`${r.kind === "organic" ? t("badgeAd") : KIND()[r.kind] || t("badgeAd")} ${Math.round(r.prob * 100)}%`);
    if (kws.length) why.push(t("veilContainsKeywords", kws.slice(0, 3).join("、")));
    const lead = t("veilFolded");
    const who = el.__jevAuthor ? [el.__jevAuthor] : [];

    const willShow = revealed.has(sent.get(el));
    const wasFolded = el.classList.contains("jev-fold") && !el.classList.contains("jev-reveal");
    // Keyed by content signature: content folded once still appears pre-folded (no animation replay)
    // if its element gets recycled and rebuilt.
    const sig = sent.get(el);
    const firstFold = !foldedSigs.has(sig);
    if (sig) foldedSigs.add(sig);
    const commit = () => {
      markBody(el, site);
      el.classList.add("jev-fold");
      el.dataset.jevFold = "collapse";
      el.classList.toggle("jev-reveal", willShow);
      const v = mountVeil(el);
      if (v) {
        v.querySelector(".jev-veil-text").textContent = [lead, ...who, ...why].join(" · ");
        v.setAttribute("aria-label", `${[lead, ...why].join(", ")}, ${t("veilExpand").toLowerCase()}`);
      }
    };
    // Only animate the fold when the post is currently on screen; posts off-screen are folded
    // instantly (the user can't see them, and it avoids layout jumps for content being read).
    if (firstFold && !wasFolded && !willShow && !el.__jevFolding && inView(el) && !reduceMotion()) {
      foldInPlace(el, commit);
    } else if (!el.__jevFolding) {
      commit();
    }
  }

  // Clicking the badge or a folded area only expands/re-folds; it must not trigger X's own navigation.
  // Attached on window's capture phase (fires before anything else); X handles navigation on
  // pointerdown/up, so we intercept the whole event chain and only act on the final click.
  function pointTarget(e) {
    if (dead) return null;
    if (!alive()) {
      shutdown();
      return null;
    }
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return null;
    const badge = target.closest(".jev-badge");
    if (badge?.__jevItem) return { el: badge.__jevItem, badge: true };
    const el = target.closest(".jev-fold:not(.jev-reveal)");
    return el && target.closest(".jev-body, .jev-veil") ? { el, badge: false } : null;
  }
  function onPointCapture(e) {
    const hit = pointTarget(e);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type !== "click") return;
    setRevealed(hit.el, hit.badge ? !hit.el.classList.contains("jev-reveal") : true);
  }
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) addEventListener(type, onPointCapture, true);

  function unfold(el) {
    el.__jevAnim?.cancel();
    el.classList.remove("jev-fold", "jev-reveal");
    delete el.dataset.jevFold;
    el.__jevVeil?.remove();
    el.__jevVeil = null;
  }

  // Expand on user click / re-fold on badge click.
  function setRevealed(el, on) {
    const sig = sent.get(el);
    if (sig) on ? revealed.add(sig) : revealed.delete(sig);
    const toggle = () => el.classList.toggle("jev-reveal", on);
    if (el.dataset.jevFold !== "collapse") {
      toggle(); // Plain labeled posts have no fold bar, so no clip animation is needed.
    } else if (reduceMotion()) {
      toggle();
      if (on) fadeIn(foldContent(el), 150, 0);
    } else if (on) {
      unfoldReveal(el, toggle); // Expand: open downward from the fold bar's position, content fades in slightly after.
    } else {
      foldConceal(el, toggle, 180); // Re-fold: a bit quicker than expanding.
    }
    if (!on) el.__jevVeil?.focus({ preventScroll: true });
  }

  // ---------- Fold animation ----------

  const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)"; // appear, expand

  const EASE_IN_OUT = "cubic-bezier(0.77, 0, 0.175, 1)";
  const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const inView = (el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight && r.height > 0;
  };
  const foldContent = (el) => [...el.children].filter((c) => !c.classList.contains("jev-veil"));
  const fadeIn = (els, duration, delay) =>
    els.forEach((c) => c.animate([{ opacity: 0 }, { opacity: 1 }], { duration, delay, easing: "ease", fill: "backwards" }));

  // Why we don't animate height directly: X's timeline is a virtual list that only re-lays-out
  // a frame or two later. If height changes frame by frame, the post below can't keep up and
  // gets overlapped (observed up to 255px), and every frame also triggers a full-page reflow.
  // So height changes instantly, and only the visible clip region animates "open from the top /
  // close from the bottom" via clip-path.
  const BAR_HEIGHT = 44;
  const radius = (el) => getComputedStyle(el).borderTopLeftRadius || "0px";
  const clipTo = (el, hidden) => `inset(0 0 ${Math.max(0, hidden)}px 0 round ${radius(el)})`;
  // Current position of an in-flight clip animation (so an interruption can continue from there).
  const currentClip = (el) => {
    const c = el.__jevAnim ? getComputedStyle(el).clipPath : "none";
    return c && c !== "none" ? c : null;
  };

  function unfoldReveal(el, toggle) {
    const interrupted = currentClip(el); // If expand is clicked while collapsing, continue from the current position.
    el.__jevAnim?.cancel();
    toggle();
    const full = el.getBoundingClientRect().height;
    const start = interrupted || clipTo(el, full - BAR_HEIGHT);
    const a = el.animate([{ clipPath: start }, { clipPath: clipTo(el, 0) }], { duration: 260, easing: EASE_OUT });
    track(el, a);
    fadeIn(foldContent(el), 200, 60);
  }

  // Collapse: shrink the visible region to one line and fade the content out, then commit the fold
  // (so the post below can move up to fill the space).
  function foldConceal(el, commit, duration) {
    const full = el.getBoundingClientRect().height;
    const from = currentClip(el) || clipTo(el, 0);
    el.__jevAnim?.cancel();
    const a = el.animate([{ clipPath: from }, { clipPath: clipTo(el, full - BAR_HEIGHT) }], {
      duration,
      easing: EASE_IN_OUT,
      fill: "forwards"
    });
    track(el, a);
    const fades = foldContent(el).map((c) =>
      c.animate([{ opacity: 1 }, { opacity: 0 }], { duration: Math.min(120, duration), easing: "ease", fill: "forwards" })
    );
    el.__jevFolding = true;
    a.finished
      .then(
        () => {
          commit();
          if (el.__jevVeil) fadeIn([el.__jevVeil], 160, 0);
        },
        () => {} // Animation was interrupted: the new animation takes over; errors inside commit() are not swallowed.
      )
      .finally(() => {
        el.__jevFolding = false;
        a.cancel();
        fades.forEach((f) => f.cancel());
      });
  }

  function track(el, a) {
    el.__jevAnim = a;
    const done = () => el.__jevAnim === a && (el.__jevAnim = null);
    a.onfinish = done;
    a.oncancel = done;
  }

  // Content that gets auto-folded while already on screen.
  function foldInPlace(el, commit) {
    foldConceal(el, commit, 240);
  }

  function mountVeil(el) {
    if (el.__jevVeil?.isConnected) return el.__jevVeil;
    const v = document.createElement("button");
    v.type = "button";
    v.className = "jev-veil";
    v.innerHTML = `<span class="jev-veil-text"></span><span class="jev-veil-action">${escapeHtml(t("veilExpand"))}</span>`;
    v.dataset.placement = "bar";
    el.prepend(v); // The fold bar sits first; the rest of the post content is hidden via CSS.
    el.__jevVeil = v;
    return v;
  }

  function markBody(el, site) {
    el.querySelectorAll(".jev-body").forEach((n) => n.classList.remove("jev-body"));
    if (!site.body) return;
    el.querySelectorAll(site.body).forEach((n) => n.classList.add("jev-body"));
  }

  function aiBlock(res) {
    if (typeof res.ai === "number") {
      const p = aiPct(res.ai);
      const desc = res.ai >= 0.75 ? t("tipAiDescHeavy") : res.ai >= 0.5 ? t("tipAiDescMixed") : res.ai >= 0.25 ? t("tipAiDescLight") : t("tipAiDescHuman");
      return `<div class="jev-tip-sub">${escapeHtml(t("tipAiRatioLabel"))} · ${escapeHtml(desc)}</div><div class="jev-rows"><div class="jev-row is-top"><span>AI</span><i style="--w:${p}%"></i><b>${escapeHtml(t("badgeAiApprox", String(p)))}</b></div></div>`;
    }
    if (res.aiShort) return `<div class="jev-tip-sub">${escapeHtml(t("tipAiShort"))}</div>`;
    return "";
  }

  // ---------- Detail tooltip (a single shared node for the whole page, so it can't be clipped by a card's overflow) ----------
  const tip = (() => {
    let node = null;
    let hideTimer = null;
    let lastHidden = 0;

    function build() {
      node = document.createElement("div");
      node.className = "jev-tip";
      node.setAttribute("role", "tooltip");
      document.documentElement.appendChild(node);
    }

    function content(res) {
      if (!res) return `<div class="jev-tip-head">${escapeHtml(t("tipChecking"))}</div>`;
      if (!res.ok) return `<div class="jev-tip-head">${escapeHtml(ERROR_LABEL()[res.code] || t("badgeCheckFailed"))}</div><div class="jev-tip-err"></div>`;
      const r = res.result;
      const pct = Math.round(r.prob * 100);
      const rows = Object.entries(r.kindProbs)
        .sort((a, b) => b[1] - a[1])
        .map(
          ([k, v]) =>
            `<div class="jev-row${k === r.kind ? " is-top" : ""}"><span>${escapeHtml(KIND()[k] || k)}</span><i style="--w:${Math.round(v * 100)}%"></i><b>${Math.round(v * 100)}%</b></div>`
        )
        .join("");
      const kwRows = (settings.keywords || [])
        .map((k) => {
          const literal = (res.__literal || []).some((x) => x.toLowerCase() === k.toLowerCase());
          const p = res.topics?.[k];
          if (!literal && !(p >= TOPIC_THRESHOLD)) return "";
          return `<div class="jev-row is-top"><span>${escapeHtml(k)}</span><i style="--w:${literal ? 100 : Math.round(p * 100)}%"></i><b>${literal ? escapeHtml(t("tipLiteralMatch")) : Math.round(p * 100) + "%"}</b></div>`;
        })
        .join("");
      const kwBlock = kwRows ? `<div class="jev-tip-sub">${escapeHtml(t("tipBlockedKeywords"))}</div><div class="jev-rows">${kwRows}</div>` : "";
      const hint = res.__folded ? `<div class="jev-tip-foot">${escapeHtml(t("tipReclickToFold"))}</div>` : "";
      return `<div class="jev-tip-head"><span>${escapeHtml(t("tipAdProbability"))}</span><strong data-ad="${r.isAd}">${pct}%</strong></div>
        <div class="jev-meter" data-ad="${r.isAd}"><i style="--w:${pct}%"></i></div>
        <div class="jev-rows">${rows}</div>${kwBlock}${aiBlock(res)}${hint}`;
    }

    return {
      show(badge) {
        if (!node) build();
        clearTimeout(hideTimer);
        const res = badge.__jevResult && { ...badge.__jevResult, __literal: badge.__jevLiteral, __folded: !!badge.closest(".jev-fold") };
        node.innerHTML = content(res);
        if (res && !res.ok) node.querySelector(".jev-tip-err").textContent = res.error || t("tipUnknownError");
        const r = badge.getBoundingClientRect();
        const w = 240;
        const left = Math.min(Math.max(8, r.left), innerWidth - w - 8);
        const below = r.bottom + 6 + 170 < innerHeight;
        node.style.left = `${left}px`;
        node.style.top = below ? `${r.bottom + 6}px` : "";
        node.style.bottom = below ? "" : `${innerHeight - r.top + 6}px`;
        node.style.setProperty("--origin", `${r.left - left + r.width / 2}px ${below ? "top" : "bottom"}`);
        // If another tooltip just closed, appear instantly instead of playing the entrance animation.
        node.dataset.instant = String(Date.now() - lastHidden < 300);
        node.dataset.open = "true";
      },
      hide() {
        if (!node) return;
        hideTimer = setTimeout(() => {
          node.dataset.open = "false";
          lastHidden = Date.now();
        }, 60);
      }
    };
  })();

  // ---------- Messaging with the extension background ----------
  // After the extension is reloaded/updated, the old script still running in an already-open page
  // loses its connection; calling chrome.runtime again throws "Extension context invalidated".
  // Once detected, tear down all of the old script's listeners; the new script takes over on the next page refresh.
  let dead = false;

  function alive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function shutdown() {
    if (dead) return;
    dead = true;
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) removeEventListener(type, onPointCapture, true);
    mo.disconnect();
    io.disconnect();
    themeObserver.disconnect();
    pending.clear();
    tip.hide();
  }

  function send(msg, cb) {
    if (dead) return;
    if (!alive()) return shutdown();
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        try {
          if (!alive()) return shutdown();
          if (chrome.runtime.lastError) return;
          cb(res);
        } catch (error) {
          if (alive() && !String(error).includes("Extension context invalidated")) throw error;
          shutdown();
        }
      });
    } catch {
      shutdown();
    }
  }

  // ---------- Scanning ----------
  const sent = new WeakMap(); // el -> signature of the content already submitted for classification

  // Remember classification results keyed by content signature. X's timeline is a virtual list
  // that recycles and rebuilds elements while scrolling; the same content can reappear on a new
  // element, so we reuse the remembered result instead of showing "checking" again or re-requesting.
  // Cleared whenever settings change (threshold and keywords affect the result).
  const memory = new Map(); // sig -> { res, literal }
  const inFlight = new Map(); // sig -> callbacks waiting for the same page request
  const MEMORY_LIMIT = 3000;
  const retries = new Map();
  function remember(sig, entry) {
    memory.delete(sig);
    memory.set(sig, entry);
    if (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value);
  }

  function check(el, site) {
    if (!alive()) return shutdown();
    if (dead || !canCheck() || quotaHit) return;
    el.__jevKey = site.key?.(el);
    const state = extract(el, site);
    if (!state) return;
    const sig = JSON.stringify(state);
    if (sent.get(el) === sig) return;
    sent.set(el, sig);
    // This content was already classified (element was recycled and rebuilt): show the result directly.
    const known = memory.get(sig);
    if (known) {
      el.__jevAuthor = state.author || "";
      el.__jevLiteral = known.literal;
      render(el, site, known.res);
      return;
    }
    const b = mountBadge(el, site);
    b.__jevResult = null;
    setBadge(b, "loading", t("badgeChecking"));
    el.__jevAuthor = state.author || "";
    el.__jevLiteral = keywordHits(state);
    if (el.__jevLiteral.length) applyFold(el, site, null); // Literal keyword matches don't need to wait for the classification result.
    const topics = settings.smartMatch ? (settings.keywords || []).filter((k) => typeof k === "string" && k.trim()) : [];
    const currentVersion = settingsVersion;
    const onResult = (res) => {
      // After logout or switching accounts, discard any in-flight response from the old session, even for the same post.
      if (currentVersion !== settingsVersion || !canCheck()) return;
      if (["auth_required", "account_disabled", "session_changed"].includes(res?.code)) {
        send({ type: "getSettings" }, applySettings);
        return;
      }
      if (res?.ok) remember(sig, { res, literal: el.__jevLiteral });
      if (sent.get(el) !== sig) return;
      render(el, site, res);
      // Only auto-retry once for transient failures, to avoid repeatedly hammering the service (and consuming credits) while it's down.
      if (res && !res.ok && (res.code === "upstream" || res.code === "network") && !retries.has(sig)) {
        retries.set(sig, true);
        setTimeout(() => {
          if (currentVersion !== settingsVersion || sent.get(el) !== sig) return;
          sent.delete(el);
          check(el, site);
        }, RETRY_AFTER_MS);
      }
    };
    // 同页相同内容若同时出现，只提交一次请求；各展示位置共用这次返回的结果。
    const waiting = inFlight.get(sig);
    if (waiting) {
      waiting.push(onResult);
      return;
    }
    const callbacks = [onResult];
    inFlight.set(sig, callbacks);
    send({ type: "classify", state, topics }, (res) => {
      if (inFlight.get(sig) === callbacks) inFlight.delete(sig);
      callbacks.forEach((callback) => callback(res));
    });
  }

  // Show a single page-wide notice once credits run out; it clears once the account is refreshed with new credits.
  let quotaHit = false;
  function onQuota(el, message) {
    el.__jevBadge?.remove();
    el.__jevBadge = null;
    if (quotaHit) return;
    quotaHit = true;
    document.querySelectorAll('.jev-badge[data-state="loading"]').forEach((b) => b.remove());
    toast("ok", t("toastQuotaExhausted", message || t("quotaExhaustedDefault")), 6000);
  }

  // Do all the work while the browser is idle, so it never competes with the page's own rendering or scrolling.
  const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 1000 }) : setTimeout(fn, 200));

  // Only classify content that has scrolled near the viewport; items entering the viewport are queued and processed in batches while idle.
  const pending = new Set();
  let flushQueued = false;
  function queueFlush() {
    if (flushQueued || dead) return;
    flushQueued = true;
    idle((deadline) => {
      flushQueued = false;
      for (const el of pending) {
        // This frame's idle budget is almost gone; leave the rest for the next one.
        if (deadline && !deadline.didTimeout && deadline.timeRemaining() < 3) return queueFlush();
        pending.delete(el);
        if (el.isConnected) check(el, el.__jevSite);
      }
    });
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) pending.add(e.target);
      if (pending.size) queueFlush();
    },
    { rootMargin: "300px 0px" }
  );

  function scan() {
    if (!alive()) return shutdown();
    for (const site of SITES) {
      document.querySelectorAll(site.item).forEach((el) => {
        if (el.__jevSite) {
          // X reuses post containers: re-classify if a previously seen container's content changed
          // (check() returns immediately if the signature is unchanged).
          if (sent.has(el)) {
            if (el.__jevBadge && !el.__jevBadge.isConnected) {
              sent.delete(el);
              el.__jevBadge = null;
            } else if (site.key && site.key(el) === el.__jevKey) {
              return; // Still the same content: no need to re-read the text.
            }
            check(el, site);
          } else if (el.__jevBadge && !el.__jevBadge.isConnected) {
            // 页面重新渲染时优先复用本页已有结果；没有结果才重新发起一次计费判断。
            sent.delete(el);
            el.__jevBadge = null;
            check(el, site);
          }
          return;
        }
        if (el.parentElement?.closest(site.item)) return;
        el.__jevSite = site;
        io.observe(el);
      });
    }
  }

  // Scan at most once every 300ms after a DOM change, and only while the browser is idle;
  // changes in between are coalesced (e.g. autoplaying video keeps mutating the page continuously).
  let scanQueued = false;
  const mo = new MutationObserver(() => {
    if (scanQueued || dead) return;
    scanQueued = true;
    setTimeout(
      () =>
        idle(() => {
          scanQueued = false;
          if (!dead) scan();
        }),
      300
    );
  });

  function reset() {
    settingsVersion++;
    tip.hide();
    pending.clear();
    revealed.clear();
    memory.clear();
    inFlight.clear();
    retries.clear();
    foldedSigs.clear();
    document.querySelectorAll(".jev-badge, .jev-veil").forEach((b) => b.remove());
    document.querySelectorAll(".jev-ad, .jev-fold, .jev-reveal").forEach((el) => {
      el.classList.remove("jev-ad", "jev-fold", "jev-reveal");
      delete el.dataset.jevFold;
    });
    for (const site of SITES)
      document.querySelectorAll(site.item).forEach((el) => {
        el.__jevAnim?.cancel();
        sent.delete(el);
        el.__jevBadge = null;
        el.__jevVeil = null;
        if (el.__jevSite) {
          io.unobserve(el);
          if (canCheck()) io.observe(el); // 设置变更后重新判断；成功请求按查询次数计费。
        }
      });
  }

  // X's own light/dark setting is independent of the OS setting; pick the badge/tooltip colors based on the page background brightness.
  function syncTheme() {
    const m = getComputedStyle(document.body).backgroundColor.match(/\d+/g);
    if (!m) return;
    const [r, g, b] = m.map(Number);
    document.documentElement.dataset.jevTheme = 0.299 * r + 0.587 * g + 0.114 * b < 128 ? "dark" : "light";
  }
  const themeObserver = new MutationObserver(syncTheme);
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ["style"] });

  function start() {
    syncTheme();
    scan();
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // Wait for the page to finish loading and the browser to go idle before starting to label posts.
  function startWhenPageReady() {
    const go = () => idle(() => !dead && canCheck() && start());
    if (document.readyState === "complete") go();
    else addEventListener("load", go, { once: true });
  }

  send({ type: "getSettings" }, (s) => {
    if (s) settings = s;
    if (canCheck()) startWhenPageReady();
  });

  function applySettings(next) {
    if (!next) return;
    settings = next;
    quotaHit = false;
    mo.disconnect();
    reset();
    if (canCheck()) start();
  }

  // ---------- Bottom-of-page toast ----------
  function toast(state, text, ms = 3200) {
    document.querySelectorAll(".jev-toast").forEach((node) => node.remove());
    const node = document.createElement("div");
    node.className = "jev-toast";
    node.dataset.state = state;
    node.textContent = text;
    document.documentElement.appendChild(node);
    setTimeout(() => {
      node.dataset.leaving = "true";
      setTimeout(() => node.remove(), 200);
    }, ms);
  }

  // Result of the right-click "check selected text" action.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "settingsChanged") return applySettings(msg.settings);
    if (msg?.type !== "showToast") return;
    if (msg.error) return toast("error", t("toastCheckFailed", msg.error));
    const r = msg.result;
    const pct = Math.round(r.prob * 100);
    toast(
      r.isAd ? "ad" : "ok",
      r.isAd ? t("toastLikelyAd", KIND()[r.kind] === t("kindOrganic") ? t("badgeAd") : KIND()[r.kind], String(pct)) : t("toastNotAd", String(pct))
    );
  });
})();
