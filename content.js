/**
 * bullshtt.ai — Content Script (Manifest V3)
 * Real-time X.com bullshit & rage-bait detector + 1-click objective auto-answer.
 * Powered by Jev (jev-1.14.0).
 */

(function () {
  "use strict";

  // Prevent multiple injections
  if (window.__BULLSHTT_AI_INITIALIZED__) return;
  window.__BULLSHTT_AI_INITIALIZED__ = true;

  console.log("[bullshtt.ai] Initializing content script on", window.location.hostname);

  // Cached settings
  let settings = {
    autoScanViewport: true,
    firewallMode: "xray", // "xray" | "collapse"
    stinkinessThreshold: 75,
    replyStyle: "full",
    proxyUrl: "http://127.0.0.1:8787/api/score",
    typesafeApiKey: ""
  };

  // State
  const pendingPosts = new Map(); // id -> post object
  const scannedResults = new Map(); // id -> scoredResult
  let scanDebounceTimer = null;
  let activePopover = null;

  // Load initial settings
  chrome.runtime.sendMessage({ action: "GET_STATE" }, (response) => {
    if (response && response.settings) {
      settings = { ...settings, ...response.settings };
    }
    setupTweetObserver();
  });

  // Listen for settings updates
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.bs_settings) {
      settings = { ...settings, ...changes.bs_settings.newValue };
      // Re-apply firewall mode to already scored tweets if mode changed
      reapplyFirewallToScoredTweets();
    }
  });

  // Inject Custom Stylesheet
  injectStyles();

  /**
   * Inject Extension CSS into DOM
   */
  function injectStyles() {
    if (document.getElementById("bullshtt-ai-styles")) return;

    const style = document.createElement("style");
    style.id = "bullshtt-ai-styles";
    style.textContent = `
      /* bullshtt.ai Badge & Toolbar styles */
      .bs-badge {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 2px 8px;
        border-radius: 9999px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
        user-select: none;
        transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        margin-left: 8px;
        vertical-align: middle;
        z-index: 10;
        box-shadow: 0 1px 3px rgba(0,0,0,0.3);
      }
      .bs-badge:hover {
        transform: translateY(-1px) scale(1.03);
      }
      .bs-badge-stinky {
        background: rgba(239, 68, 68, 0.18);
        color: #f87171;
        border: 1px solid rgba(239, 68, 68, 0.45);
      }
      .bs-badge-stinky:hover {
        background: rgba(239, 68, 68, 0.28);
        border-color: #ef4444;
      }
      .bs-badge-sus {
        background: rgba(245, 158, 11, 0.18);
        color: #fbbf24;
        border: 1px solid rgba(245, 158, 11, 0.45);
      }
      .bs-badge-sus:hover {
        background: rgba(245, 158, 11, 0.28);
        border-color: #f59e0b;
      }
      .bs-badge-clean {
        background: rgba(16, 185, 129, 0.18);
        color: #34d399;
        border: 1px solid rgba(16, 185, 129, 0.45);
      }
      .bs-badge-clean:hover {
        background: rgba(16, 185, 129, 0.28);
        border-color: #10b981;
      }
      .bs-badge-loading {
        background: rgba(148, 163, 184, 0.15);
        color: #94a3b8;
        border: 1px solid rgba(148, 163, 184, 0.3);
      }

      /* In-tweet action button */
      .bs-action-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        border-radius: 9999px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        border: 1px solid rgba(239, 68, 68, 0.3);
        background: rgba(239, 68, 68, 0.08);
        color: #f87171;
        transition: all 0.15s ease;
        margin-left: auto;
      }
      .bs-action-btn:hover {
        background: rgba(239, 68, 68, 0.2);
        border-color: #ef4444;
      }
      .bs-action-btn-clean {
        border-color: rgba(16, 185, 129, 0.3);
        background: rgba(16, 185, 129, 0.08);
        color: #34d399;
      }
      .bs-action-btn-clean:hover {
        background: rgba(16, 185, 129, 0.2);
        border-color: #10b981;
      }

      /* Hover Popover Telemetry Card */
      .bs-popover {
        position: absolute;
        width: 380px;
        max-width: 90vw;
        background: #0d1117;
        color: #e6edf3;
        border: 1px solid #30363d;
        border-radius: 12px;
        padding: 16px;
        box-shadow: 0 16px 36px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.05);
        z-index: 999999;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
        font-size: 13px;
        line-height: 1.45;
        backdrop-filter: blur(12px);
      }
      .bs-popover-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-bottom: 1px solid #21262d;
        padding-bottom: 10px;
        margin-bottom: 12px;
      }
      .bs-popover-brand {
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0.5px;
        color: #f87171;
        display: flex;
        align-items: center;
        gap: 5px;
      }
      .bs-popover-verdict {
        font-size: 11px;
        padding: 2px 7px;
        border-radius: 4px;
        background: #21262d;
        color: #c9d1d9;
        font-weight: 600;
      }
      .bs-popover-score-hero {
        text-align: center;
        padding: 8px 0;
        background: rgba(255, 255, 255, 0.02);
        border-radius: 8px;
        margin-bottom: 12px;
      }
      .bs-popover-score-big {
        font-size: 26px;
        font-weight: 900;
        letter-spacing: -0.5px;
      }
      .bs-popover-score-meta {
        font-size: 11px;
        color: #8b949e;
        margin-top: 2px;
      }
      .bs-signals-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-bottom: 14px;
      }
      .bs-signal-row {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .bs-signal-labels {
        display: flex;
        justify-content: space-between;
        font-size: 11px;
        color: #8b949e;
      }
      .bs-signal-track {
        height: 5px;
        background: #21262d;
        border-radius: 999px;
        overflow: hidden;
      }
      .bs-signal-bar {
        height: 100%;
        border-radius: 999px;
        transition: width 0.3s ease;
      }
      .bs-signal-bar-red { background: #ef4444; }
      .bs-signal-bar-amber { background: #f59e0b; }
      .bs-signal-bar-green { background: #10b981; }

      .bs-popover-preview {
        background: #161b22;
        border: 1px solid #30363d;
        border-radius: 6px;
        padding: 8px 10px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 11px;
        color: #c9d1d9;
        max-height: 85px;
        overflow-y: auto;
        white-space: pre-wrap;
        margin-bottom: 12px;
      }
      .bs-popover-actions {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .bs-btn-primary {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        width: 100%;
        padding: 8px 12px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
        background: #ef4444;
        color: #ffffff;
        border: none;
        transition: background 0.15s ease;
      }
      .bs-btn-primary:hover {
        background: #dc2626;
      }
      .bs-btn-secondary {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        width: 100%;
        padding: 7px 12px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        background: #21262d;
        color: #c9d1d9;
        border: 1px solid #30363d;
        transition: all 0.15s ease;
      }
      .bs-btn-secondary:hover {
        background: #30363d;
        color: #ffffff;
      }

      /* Firewall Shield Banner */
      .bs-shield-banner {
        background: rgba(239, 68, 68, 0.08);
        border: 1px dashed rgba(239, 68, 68, 0.35);
        border-radius: 12px;
        padding: 14px 16px;
        margin: 8px 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        color: #fca5a5;
        font-size: 13px;
      }
      .bs-shield-text {
        display: flex;
        align-items: center;
        gap: 8px;
        line-height: 1.4;
      }
      .bs-shield-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
      }
      .bs-shield-btn-reveal {
        background: #21262d;
        border: 1px solid #30363d;
        color: #c9d1d9;
        padding: 4px 10px;
        border-radius: 6px;
        font-size: 12px;
        cursor: pointer;
      }
      .bs-shield-btn-reveal:hover {
        background: #30363d;
        color: #ffffff;
      }
      .bs-shield-btn-auto {
        background: #ef4444;
        border: none;
        color: #ffffff;
        padding: 4px 10px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      }
      .bs-shield-btn-auto:hover {
        background: #dc2626;
      }

      /* Toast Notification */
      .bs-toast {
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%) translateY(20px);
        background: #161b22;
        border: 1px solid #30363d;
        color: #e6edf3;
        padding: 10px 18px;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 600;
        box-shadow: 0 10px 30px rgba(0,0,0,0.5);
        z-index: 1000000;
        opacity: 0;
        transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
        display: flex;
        align-items: center;
        gap: 8px;
        pointer-events: none;
      }
      .bs-toast.bs-toast-visible {
        transform: translateX(-50%) translateY(0);
        opacity: 1;
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Display temporary toast notification on screen
   */
  function showToast(message, icon = "⚡") {
    let toast = document.getElementById("bs-global-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "bs-global-toast";
      toast.className = "bs-toast";
      document.body.appendChild(toast);
    }
    toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
    toast.classList.add("bs-toast-visible");

    clearTimeout(toast.__timer);
    toast.__timer = setTimeout(() => {
      toast.classList.remove("bs-toast-visible");
    }, 3500);
  }

  /**
   * Observe DOM mutations for new tweet elements
   */
  function setupTweetObserver() {
    const observer = new MutationObserver(() => {
      processTweetElements();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    // Initial run
    processTweetElements();

    // Close popovers on outer click
    document.addEventListener("click", (e) => {
      if (activePopover && !activePopover.contains(e.target) && !e.target.closest(".bs-badge")) {
        closePopover();
      }
    });
  }

  /**
   * Extract tweet structured data from an article element
   */
  function extractTweetData(article) {
    // Tweet status link and ID
    const statusLinks = article.querySelectorAll('a[href*="/status/"]');
    let tweetId = null;
    let tweetUrl = "";
    let handle = "";

    for (const link of statusLinks) {
      const match = link.href.match(/\/([a-zA-Z0-9_]+)\/status\/(\d+)/);
      if (match) {
        handle = `@${match[1]}`;
        tweetId = match[2];
        tweetUrl = link.href;
        break;
      }
    }

    if (!tweetId) {
      // Fallback ID from element position/content
      return null;
    }

    // Display Author
    const userNameNode = article.querySelector('[data-testid="User-Name"]');
    let author = "Unknown";
    if (userNameNode) {
      const firstSpan = userNameNode.querySelector("span");
      if (firstSpan) {
        author = firstSpan.textContent.trim();
      }
      if (!handle) {
        const text = userNameNode.textContent;
        const hMatch = text.match(/@([a-zA-Z0-9_]+)/);
        if (hMatch) handle = `@${hMatch[1]}`;
      }
    }

    // Tweet Text
    const textNode = article.querySelector('[data-testid="tweetText"]');
    const text = textNode ? textNode.innerText.trim() : "";

    // Metrics (if available in role="group")
    const group = article.querySelector('[role="group"]');
    const metrics = {};
    if (group) {
      const replyBtn = group.querySelector('[data-testid="reply"]');
      const retweetBtn = group.querySelector('[data-testid="retweet"], [data-testid="unretweet"]');
      const likeBtn = group.querySelector('[data-testid="like"], [data-testid="unlike"]');
      metrics.replies = replyBtn ? replyBtn.textContent.trim() : "";
      metrics.retweets = retweetBtn ? retweetBtn.textContent.trim() : "";
      metrics.likes = likeBtn ? likeBtn.textContent.trim() : "";
    }

    return {
      id: tweetId,
      author: author || "Unknown",
      handle: handle || "@unknown",
      text,
      url: tweetUrl || `https://x.com/${handle.replace("@", "")}/status/${tweetId}`,
      metrics
    };
  }

  /**
   * Scan all tweet elements on page
   */
  function processTweetElements() {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');

    articles.forEach((article) => {
      if (article.dataset.bsScanned === "true") return;

      const postData = extractTweetData(article);
      if (!postData || !postData.text) return;

      article.dataset.bsPostId = postData.id;

      // Ensure action bar button is injected
      injectActionBarButton(article, postData);

      // Viewport auto-scanning
      if (settings.autoScanViewport && !article.dataset.bsQueued) {
        article.dataset.bsQueued = "true";
        queuePostForScoring(postData, article);
      }
    });
  }

  /**
   * Queue post for batch scoring
   */
  function queuePostForScoring(postData, article) {
    if (scannedResults.has(postData.id)) {
      renderScoredTweet(article, scannedResults.get(postData.id), postData);
      return;
    }

    pendingPosts.set(postData.id, { postData, article });
    renderLoadingBadge(article);

    clearTimeout(scanDebounceTimer);
    scanDebounceTimer = setTimeout(flushPendingQueue, 250);
  }

  /**
   * Send queued posts to background for scoring
   */
  function flushPendingQueue() {
    if (pendingPosts.size === 0) return;

    // Take up to 8 posts per batch
    const entries = Array.from(pendingPosts.entries()).slice(0, 8);
    const batch = entries.map(([_, item]) => item.postData);

    // Remove from pending
    entries.forEach(([id]) => pendingPosts.delete(id));

    chrome.runtime.sendMessage(
      { action: "SCORE_POSTS", posts: batch },
      (response) => {
        if (!response || !response.success || !response.results) {
          console.warn("[bullshtt.ai] Batch scoring returned error or empty:", response?.error);
          entries.forEach(([id, item]) => {
            renderErrorBadge(item.article);
          });
          return;
        }

        const results = response.results;
        entries.forEach(([id, item]) => {
          const scored = results[id];
          if (scored) {
            scannedResults.set(id, scored);
            renderScoredTweet(item.article, scored, item.postData);
          } else {
            renderErrorBadge(item.article);
          }
        });
      }
    );

    // If more posts are remaining in queue, schedule another batch
    if (pendingPosts.size > 0) {
      scanDebounceTimer = setTimeout(flushPendingQueue, 350);
    }
  }

  /**
   * Render initial loading state badge
   */
  function renderLoadingBadge(article) {
    const userNameNode = article.querySelector('[data-testid="User-Name"]');
    if (!userNameNode) return;

    let badge = article.querySelector(".bs-badge");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "bs-badge bs-badge-loading";
      userNameNode.appendChild(badge);
    }
    badge.innerHTML = "⏳ Scanning...";
  }

  /**
   * Render error badge
   */
  function renderErrorBadge(article) {
    const badge = article.querySelector(".bs-badge");
    if (badge) {
      badge.className = "bs-badge bs-badge-sus";
      badge.innerHTML = "⚠️ Unscored";
      badge.title = "Could not reach bullshtt.ai proxy or Jev";
    }
  }

  /**
   * Render scored badge, hover card hooks, and firewall collapse
   */
  function renderScoredTweet(article, scored, postData) {
    if (!article || !scored) return;
    article.dataset.bsScanned = "true";
    article.__bs_result = scored;
    article.__bs_post = postData;

    const pct = scored.stinkinessPct ?? 50;
    let badgeClass = "bs-badge-clean";
    let badgeIcon = "✅";
    let badgeLabel = "Clean";

    if (pct >= (settings.stinkinessThreshold || 75)) {
      badgeClass = "bs-badge-stinky";
      badgeIcon = "💩";
      badgeLabel = "Stinky";
    } else if (pct >= 40) {
      badgeClass = "bs-badge-sus";
      badgeIcon = "🤨";
      badgeLabel = "Sus";
    }

    // 1. Tweet Header Badge
    const userNameNode = article.querySelector('[data-testid="User-Name"]');
    if (userNameNode) {
      let badge = article.querySelector(".bs-badge");
      if (!badge) {
        badge = document.createElement("span");
        userNameNode.appendChild(badge);
      }
      badge.className = `bs-badge ${badgeClass}`;
      badge.innerHTML = `${badgeIcon} ${pct}% ${badgeLabel} · bullshtt.ai`;

      // Click / Hover opens Telemetry Popover
      badge.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        togglePopover(badge, scored, postData, article);
      };
      badge.onmouseenter = (e) => {
        // Subtle hover hint
      };
    }

    // 2. Update Action Bar Button
    updateActionBarButton(article, scored, postData);

    // 3. Firewall Mode: Collapse if enabled and score >= threshold
    applyFirewall(article, scored, postData);
  }

  /**
   * Apply or remove firewall collapse
   */
  function applyFirewall(article, scored, postData) {
    const threshold = settings.stinkinessThreshold || 75;
    const isStinky = (scored.stinkinessPct ?? 0) >= threshold;

    let banner = article.querySelector(".bs-shield-banner");

    if (settings.firewallMode === "collapse" && isStinky && !article.dataset.bsRevealed) {
      // Find content to collapse (tweetText, media, etc.)
      const tweetText = article.querySelector('[data-testid="tweetText"]');
      if (tweetText) tweetText.style.display = "none";

      const tweetPhoto = article.querySelector('[data-testid="tweetPhoto"], [data-testid="videoPlayer"]');
      if (tweetPhoto) tweetPhoto.style.display = "none";

      if (!banner) {
        banner = document.createElement("div");
        banner.className = "bs-shield-banner";
        banner.innerHTML = `
          <div class="bs-shield-text">
            <span>💩</span>
            <div>
              <strong>Shielded by bullshtt.ai:</strong> rated <strong>${scored.stinkinessPct}%</strong> on stinkiness
              <div style="font-size: 11px; opacity: 0.85; margin-top: 1px;">Verdict: ${scored.verdictLabel || "Engagement Slop"}</div>
            </div>
          </div>
          <div class="bs-shield-actions">
            <button class="bs-shield-btn-reveal">Click to Reveal</button>
            <button class="bs-shield-btn-auto">⚡ Auto-Answer</button>
          </div>
        `;

        banner.querySelector(".bs-shield-btn-reveal").onclick = (e) => {
          e.stopPropagation();
          article.dataset.bsRevealed = "true";
          banner.remove();
          if (tweetText) tweetText.style.display = "";
          if (tweetPhoto) tweetPhoto.style.display = "";
        };

        banner.querySelector(".bs-shield-btn-auto").onclick = (e) => {
          e.stopPropagation();
          executeAutoAnswer(article, scored, postData);
        };

        // Insert after User-Name container
        const userNameContainer = article.querySelector('[data-testid="User-Name"]')?.parentElement?.parentElement;
        if (userNameContainer && userNameContainer.parentElement) {
          userNameContainer.parentElement.insertBefore(banner, userNameContainer.nextSibling);
        } else {
          article.prepend(banner);
        }
      }
    } else {
      // Restore normal view
      if (banner) banner.remove();
      const tweetText = article.querySelector('[data-testid="tweetText"]');
      if (tweetText) tweetText.style.display = "";
      const tweetPhoto = article.querySelector('[data-testid="tweetPhoto"], [data-testid="videoPlayer"]');
      if (tweetPhoto) tweetPhoto.style.display = "";
    }
  }

  function reapplyFirewallToScoredTweets() {
    const articles = document.querySelectorAll('article[data-testid="tweet"][data-bs-scanned="true"]');
    articles.forEach((article) => {
      if (article.__bs_result && article.__bs_post) {
        applyFirewall(article, article.__bs_result, article.__bs_post);
      }
    });
  }

  /**
   * Inject action button in tweet's bottom toolbar
   */
  function injectActionBarButton(article, postData) {
    const group = article.querySelector('[role="group"]');
    if (!group || group.querySelector(".bs-action-btn")) return;

    const btn = document.createElement("button");
    btn.className = "bs-action-btn";
    btn.type = "button";
    btn.innerHTML = `<span>💩</span> <span>Auto-Answer BS</span>`;

    btn.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();

      if (article.__bs_result) {
        executeAutoAnswer(article, article.__bs_result, postData);
      } else {
        btn.innerHTML = `<span>⏳</span> <span>Scoring...</span>`;
        queuePostForScoring(postData, article);
      }
    };

    group.appendChild(btn);
  }

  /**
   * Update action bar button once scored
   */
  function updateActionBarButton(article, scored, postData) {
    const btn = article.querySelector(".bs-action-btn");
    if (!btn) return;

    const pct = scored.stinkinessPct ?? 50;
    if (pct >= (settings.stinkinessThreshold || 75)) {
      btn.className = "bs-action-btn";
      btn.innerHTML = `<span>💩</span> <span>${pct}% Stinky · Auto-Answer</span>`;
    } else if (pct >= 40) {
      btn.className = "bs-action-btn";
      btn.innerHTML = `<span>🤨</span> <span>${pct}% Sus · Auto-Answer</span>`;
    } else {
      btn.className = "bs-action-btn bs-action-btn-clean";
      btn.innerHTML = `<span>✅</span> <span>${pct}% Clean · Auto-Answer</span>`;
    }

    btn.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      executeAutoAnswer(article, scored, postData);
    };
  }

  /**
   * Show or toggle hover telemetry popover
   */
  function togglePopover(anchorNode, scored, postData, article) {
    if (activePopover) {
      const wasSame = activePopover.__anchor === anchorNode;
      closePopover();
      if (wasSame) return;
    }

    const popover = document.createElement("div");
    popover.className = "bs-popover";
    popover.__anchor = anchorNode;

    const pct = scored.stinkinessPct ?? 50;
    const signals = scored.signals || {};

    const sigs = [
      { label: "Implausible Claim", val: signals.implausible_claim ?? 0 },
      { label: "Incoherent Mechanism", val: signals.incoherent_mechanism ?? 0 },
      { label: "Zero Evidence", val: signals.zero_verifiable_evidence ?? 0 },
      { label: "Engagement DM Gate", val: signals.engagement_farming_gate ?? 0 },
      { label: "Manufactured Rage", val: signals.manufactured_rage_bait ?? 0 }
    ];

    const signalsHtml = sigs
      .map((s) => {
        const valPct = Math.min(100, Math.max(0, Math.round(s.val > 1 ? s.val : s.val * 100)));
        let colorClass = "bs-signal-bar-green";
        if (valPct >= 70) colorClass = "bs-signal-bar-red";
        else if (valPct >= 40) colorClass = "bs-signal-bar-amber";

        return `
          <div class="bs-signal-row">
            <div class="bs-signal-labels">
              <span>${s.label}</span>
              <span>${valPct}%</span>
            </div>
            <div class="bs-signal-track">
              <div class="bs-signal-bar ${colorClass}" style="width: ${valPct}%;"></div>
            </div>
          </div>
        `;
      })
      .join("");

    const replyText = settings.replyStyle === "compact"
      ? (scored.autoAnswerCompact || scored.autoAnswerText)
      : (scored.autoAnswerText || scored.autoAnswerCompact);

    popover.innerHTML = `
      <div class="bs-popover-header">
        <div class="bs-popover-brand">
          <span>💩</span> bullshtt.ai telemetry
        </div>
        <div class="bs-popover-verdict">
          ${scored.verdictLabel || "Analysis"}
        </div>
      </div>

      <div class="bs-popover-score-hero">
        <div class="bs-popover-score-big" style="color: ${pct >= 75 ? "#ef4444" : pct >= 40 ? "#f59e0b" : "#10b981"};">
          ${pct}% STINKINESS
        </div>
        <div class="bs-popover-score-meta">
          rated ${pct}% on stinkiness by bullshtt.ai · Model: ${scored.model || "jev-1.14.0"}
        </div>
      </div>

      <div class="bs-signals-list">
        ${signalsHtml}
      </div>

      <div style="font-size: 11px; font-weight: 700; color: #8b949e; margin-bottom: 4px;">
        OBJECTIVE AUTO-ANSWER PREVIEW:
      </div>
      <div class="bs-popover-preview">${escapeHtml(replyText)}</div>

      <div class="bs-popover-actions">
        <button class="bs-btn-primary bs-btn-auto-reply">
          <span>⚡</span> Auto-Answer in X Reply
        </button>
        <button class="bs-btn-secondary bs-btn-copy-png">
          <span>🖼️</span> Copy Receipt Card PNG + Text
        </button>
      </div>
    `;

    document.body.appendChild(popover);
    activePopover = popover;

    // Position popover relative to anchor
    const rect = anchorNode.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();

    let top = rect.bottom + window.scrollY + 8;
    let left = rect.left + window.scrollX - 20;

    // Screen bounds adjustment
    if (left + popoverRect.width > window.innerWidth - 20) {
      left = window.innerWidth - popoverRect.width - 20;
    }
    if (left < 10) left = 10;

    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;

    // Wire up buttons
    popover.querySelector(".bs-btn-auto-reply").onclick = (e) => {
      e.stopPropagation();
      closePopover();
      executeAutoAnswer(article, scored, postData);
    };

    popover.querySelector(".bs-btn-copy-png").onclick = async (e) => {
      e.stopPropagation();
      await copyReceiptCardPngAndText(scored, postData);
    };
  }

  function closePopover() {
    if (activePopover) {
      activePopover.remove();
      activePopover = null;
    }
  }

  /**
   * Objective Auto-Answer Injection Workflow
   * Injects formatted objective callout ending with:
   * "rated XX% on stinkiness by bullshtt.ai"
   * into X.com native Draft.js/Lexical editor
   */
  async function executeAutoAnswer(article, scored, postData) {
    const replyText = settings.replyStyle === "compact"
      ? (scored.autoAnswerCompact || scored.autoAnswerText)
      : (scored.autoAnswerText || scored.autoAnswerCompact);

    // 1. Locate tweet's native reply button
    const replyBtn = article.querySelector('[data-testid="reply"]');
    if (!replyBtn) {
      // Fallback: Copy to clipboard if button not found
      await copyToClipboard(replyText);
      showToast("Auto-Answer copied to clipboard! (Reply button not found)", "📋");
      return;
    }

    replyBtn.click();

    // 2. Poll for X's reply editor textarea (up to 2.5s)
    const startTime = Date.now();
    const interval = setInterval(() => {
      const editor = document.querySelector(
        '[data-testid="tweetTextarea_0"], [data-testid="tweetTextarea_0_label"] [contenteditable="true"], [role="textbox"][contenteditable="true"]'
      );

      if (editor) {
        clearInterval(interval);
        injectTextIntoEditor(editor, replyText);
        showToast("Auto-Answer injected into reply! Review and click Reply.", "⚡");
      } else if (Date.now() - startTime > 2500) {
        clearInterval(interval);
        // Fallback to clipboard
        copyToClipboard(replyText);
        showToast("Auto-Answer copied to clipboard! Paste with Ctrl+V.", "📋");
      }
    }, 100);
  }

  /**
   * Injects text into Twitter / X Draft.js & Lexical editor and fires input events
   */
  function injectTextIntoEditor(editor, text) {
    editor.focus();

    // Select existing contents or place cursor at end
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);

    // Modern browsers execCommand insertText
    const success = document.execCommand("insertText", false, text);

    // Fallback/Synthetic input events for Lexical/Draft.js reactive state
    try {
      const inputEvt = new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: text
      });
      editor.dispatchEvent(inputEvt);

      editor.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (e) {
      console.warn("[bullshtt.ai] Event dispatch error:", e);
    }
  }

  /**
   * Renders high-DPI Receipt Card PNG onto HTML5 Canvas
   * and copies both image/png and text/plain to clipboard
   */
  async function copyReceiptCardPngAndText(scored, postData) {
    try {
      const blob = await generateReceiptPngBlob(scored, postData);
      const replyText = settings.replyStyle === "compact"
        ? (scored.autoAnswerCompact || scored.autoAnswerText)
        : (scored.autoAnswerText || scored.autoAnswerCompact);

      if (navigator.clipboard && window.ClipboardItem) {
        const item = new ClipboardItem({
          "image/png": blob,
          "text/plain": new Blob([replyText], { type: "text/plain" })
        });
        await navigator.clipboard.write([item]);
        showToast("Receipt Card PNG + Text copied! Paste in X reply (Ctrl+V)", "🖼️");
      } else {
        await copyToClipboard(replyText);
        showToast("Auto-Answer text copied to clipboard!", "📋");
      }
    } catch (err) {
      console.error("[bullshtt.ai] Failed to copy receipt PNG:", err);
      showToast("Error generating receipt PNG. Text copied.", "⚠️");
    }
  }

  /**
   * HTML5 Canvas High-DPI Telemetry Card Generator
   */
  function generateReceiptPngBlob(scored, postData) {
    return new Promise((resolve, reject) => {
      const width = 1200;
      const height = 630;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");

      if (!ctx) {
        return reject(new Error("Canvas context not available"));
      }

      // Background gradient
      const bgGrad = ctx.createLinearGradient(0, 0, width, height);
      bgGrad.addColorStop(0, "#0b0f19");
      bgGrad.addColorStop(1, "#111827");
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, width, height);

      // Card border
      ctx.strokeStyle = "#1f2937";
      ctx.lineWidth = 4;
      ctx.strokeRect(10, 10, width - 20, height - 20);

      // Header Bar: Brand + Model
      ctx.fillStyle = "#ef4444";
      ctx.font = "bold 28px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
      ctx.fillText("💩 bullshtt.ai telemetry receipt", 50, 65);

      ctx.fillStyle = "#9ca3af";
      ctx.font = "18px monospace";
      ctx.fillText(`Jev Model: ${scored.model || "jev-1.14.0"}`, width - 360, 65);

      // Divider
      ctx.strokeStyle = "#374151";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(50, 85);
      ctx.lineTo(width - 50, 85);
      ctx.stroke();

      // Tweet Info Box
      ctx.fillStyle = "#161f30";
      roundRect(ctx, 50, 110, width - 100, 130, 8, true, false);

      ctx.fillStyle = "#e5e7eb";
      ctx.font = "bold 22px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.fillText(`${postData.author} (${postData.handle})`, 75, 145);

      // Tweet Snippet Text
      ctx.fillStyle = "#9ca3af";
      ctx.font = "18px -apple-system, BlinkMacSystemFont, sans-serif";
      const snippet = postData.text.length > 170 ? postData.text.slice(0, 170) + "..." : postData.text;
      wrapText(ctx, `"${snippet}"`, 75, 180, width - 150, 26);

      // Main Score Big Gauge
      const pct = scored.stinkinessPct ?? 50;
      let scoreColor = "#ef4444";
      if (pct < 40) scoreColor = "#10b981";
      else if (pct < 75) scoreColor = "#f59e0b";

      ctx.fillStyle = scoreColor;
      ctx.font = "900 64px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.fillText(`${pct}%`, 50, 325);

      ctx.fillStyle = "#f3f4f6";
      ctx.font = "bold 28px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.fillText("STINKINESS SCORE", 215, 295);

      ctx.fillStyle = "#d1d5db";
      ctx.font = "20px monospace";
      ctx.fillText(`VERDICT: ${(scored.verdictLabel || "Analysis").toUpperCase()}`, 215, 325);

      // Jev Signal Bars
      const signals = scored.signals || {};
      const signalItems = [
        { name: "Implausible Claim", val: signals.implausible_claim ?? 0 },
        { name: "Incoherent Mechanism", val: signals.incoherent_mechanism ?? 0 },
        { name: "Zero Verifiable Evidence", val: signals.zero_verifiable_evidence ?? 0 },
        { name: "Engagement Farming DM Gate", val: signals.engagement_farming_gate ?? 0 },
        { name: "Manufactured Rage-Bait", val: signals.manufactured_rage_bait ?? 0 }
      ];

      const barStartY = 380;
      const barSpacing = 36;
      const barWidth = 420;

      signalItems.forEach((sig, idx) => {
        const y = barStartY + idx * barSpacing;
        const valPct = Math.min(100, Math.max(0, Math.round(sig.val > 1 ? sig.val : sig.val * 100)));

        ctx.fillStyle = "#9ca3af";
        ctx.font = "16px -apple-system, BlinkMacSystemFont, sans-serif";
        ctx.fillText(sig.name, 50, y + 14);

        // Track
        ctx.fillStyle = "#1f2937";
        roundRect(ctx, 330, y, barWidth, 16, 4, true, false);

        // Fill
        let fColor = "#10b981";
        if (valPct >= 70) fColor = "#ef4444";
        else if (valPct >= 40) fColor = "#f59e0b";
        ctx.fillStyle = fColor;
        roundRect(ctx, 330, y, Math.max(8, (barWidth * valPct) / 100), 16, 4, true, false);

        // Value text
        ctx.fillStyle = "#f3f4f6";
        ctx.font = "bold 15px monospace";
        ctx.fillText(`${valPct}%`, 765, y + 14);
      });

      // Footer callout banner
      ctx.fillStyle = "#1f2937";
      roundRect(ctx, 50, 560, width - 100, 44, 8, true, false);

      ctx.fillStyle = "#f9fafb";
      ctx.font = "bold 18px monospace";
      ctx.fillText(`rated ${pct}% on stinkiness by bullshtt.ai`, 75, 588);

      ctx.fillStyle = "#9ca3af";
      ctx.font = "15px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.fillText("Automated AI Callout · TypeSafe System One", width - 420, 588);

      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Canvas toBlob produced null"));
      }, "image/png");
    });
  }

  // Canvas helper for rounded rectangles
  function roundRect(ctx, x, y, width, height, radius, fill, stroke) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    if (fill) ctx.fill();
    if (stroke) ctx.stroke();
  }

  // Canvas helper for multiline text wrapping
  function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
    const words = text.split(" ");
    let line = "";

    for (let n = 0; n < words.length; n++) {
      const testLine = line + words[n] + " ";
      const metrics = ctx.measureText(testLine);
      const testWidth = metrics.width;
      if (testWidth > maxWidth && n > 0) {
        ctx.fillText(line, x, y);
        line = words[n] + " ";
        y += lineHeight;
      } else {
        line = testLine;
      }
    }
    ctx.fillText(line, x, y);
  }

  function escapeHtml(str) {
    return (str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
  }
})();
