/**
 * bullshtt.ai — Popup Controller
 * Dashboard, Live X.com Telemetry Feed, Manual Tweet Tester & Configuration.
 */

(function () {
  "use strict";

  // Elements
  const tabButtons = document.querySelectorAll(".tab-btn");
  const tabContents = document.querySelectorAll(".tab-content");

  // Summary Stat Counters
  const statTotalScanned = document.getElementById("stat-total-scanned");
  const statStinkyCaught = document.getElementById("stat-stinky-caught");
  const statAvgStinkiness = document.getElementById("stat-avg-stinkiness");

  // Manual Tester Elements
  const manualAuthor = document.getElementById("manual-author");
  const manualText = document.getElementById("manual-text");
  const btnManualScore = document.getElementById("btn-manual-score");
  const manualResult = document.getElementById("manual-result");
  const manualScoreGauge = document.getElementById("manual-score-gauge");
  const manualVerdict = document.getElementById("manual-verdict");
  const manualBrandCallout = document.getElementById("manual-brand-callout");
  const manualSignalsList = document.getElementById("manual-signals-list");
  const manualAnswerPreview = document.getElementById("manual-answer-preview");
  const btnCopyManualAnswer = document.getElementById("btn-copy-manual-answer");

  // Feed Elements
  const feedList = document.getElementById("feed-list");
  const btnRefreshFeed = document.getElementById("btn-refresh-feed");

  // Settings Elements
  const settingAutoscan = document.getElementById("setting-autoscan");
  const settingFirewall = document.getElementById("setting-firewall");
  const settingThreshold = document.getElementById("setting-threshold");
  const thresholdVal = document.getElementById("threshold-val");
  const settingStyle = document.getElementById("setting-style");
  const settingProxyUrl = document.getElementById("setting-proxy-url");
  const settingTypesafeKey = document.getElementById("setting-typesafe-key");
  const btnSaveSettings = document.getElementById("btn-save-settings");
  const btnTestConnection = document.getElementById("btn-test-connection");
  const btnClearCache = document.getElementById("btn-clear-cache");
  const connectionStatusPill = document.getElementById("connection-status-pill");
  const popupToast = document.getElementById("popup-toast");

  let currentManualScored = null;

  // Initialize
  document.addEventListener("DOMContentLoaded", () => {
    setupTabs();
    setupThresholdSlider();
    setupActions();
    loadDashboardState();
    checkConnectionStatus();
  });

  /**
   * Tab Navigation Setup
   */
  function setupTabs() {
    tabButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const targetId = btn.dataset.tab;

        tabButtons.forEach((b) => b.classList.remove("active"));
        tabContents.forEach((c) => c.classList.remove("active"));

        btn.classList.add("active");
        const targetContent = document.getElementById(targetId);
        if (targetContent) {
          targetContent.classList.add("active");
        }
      });
    });
  }

  /**
   * Threshold Slider Live Display
   */
  function setupThresholdSlider() {
    settingThreshold.addEventListener("input", () => {
      thresholdVal.textContent = `${settingThreshold.value}%`;
    });
  }

  /**
   * Wire up event listeners
   */
  function setupActions() {
    // Manual Score Button
    btnManualScore.addEventListener("click", handleManualScore);

    // Copy Manual Answer
    btnCopyManualAnswer.addEventListener("click", () => {
      if (manualAnswerPreview.textContent) {
        copyText(manualAnswerPreview.textContent);
        showToast("Auto-Answer copied to clipboard!");
      }
    });

    // Refresh Feed
    btnRefreshFeed.addEventListener("click", () => {
      btnRefreshFeed.textContent = "⏳";
      loadDashboardState(() => {
        btnRefreshFeed.textContent = "🔄";
      });
    });

    // Save Settings
    btnSaveSettings.addEventListener("click", handleSaveSettings);

    // Test Connection
    btnTestConnection.addEventListener("click", checkConnectionStatus);

    // Clear Cache
    btnClearCache.addEventListener("click", handleClearCache);
  }

  /**
   * Load dashboard stats, settings, and recent feed
   */
  function loadDashboardState(callback) {
    chrome.runtime.sendMessage({ action: "GET_STATE" }, (res) => {
      if (res && res.success) {
        const stats = res.stats || {};
        const settings = res.settings || {};

        // Update Stats
        statTotalScanned.textContent = stats.totalScanned || 0;
        statStinkyCaught.textContent = stats.stinkyCount || 0;
        statAvgStinkiness.textContent = `${stats.avgStinkiness || 0}%`;

        // Update Settings Form
        settingAutoscan.checked = Boolean(settings.autoScanViewport);
        settingFirewall.value = settings.firewallMode || "xray";
        settingThreshold.value = settings.stinkinessThreshold || 75;
        thresholdVal.textContent = `${settingThreshold.value}%`;
        settingStyle.value = settings.replyStyle || "full";
        settingProxyUrl.value = settings.proxyUrl || "";
        settingTypesafeKey.value = settings.typesafeApiKey || "";

        // Render Recent Feed
        renderFeedList(stats.recentVerdicts || [], settings.replyStyle);
      }

      if (callback) callback();
    });
  }

  /**
   * Render Recent Scored Posts
   */
  function renderFeedList(items, replyStyle) {
    if (!items || items.length === 0) {
      feedList.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">📭</span>
          <p>No tweets scored yet. Browse X.com or use the tester above!</p>
        </div>
      `;
      return;
    }

    feedList.innerHTML = "";
    items.forEach((item) => {
      const feedItem = document.createElement("div");
      feedItem.className = "feed-item";

      const pct = item.stinkinessPct ?? 50;
      let badgeClass = "badge-clean";
      let badgeLabel = "Clean";
      let badgeIcon = "✅";

      if (pct >= 75) {
        badgeClass = "badge-stinky";
        badgeLabel = "Stinky";
        badgeIcon = "💩";
      } else if (pct >= 40) {
        badgeClass = "badge-sus";
        badgeLabel = "Sus";
        badgeIcon = "🤨";
      }

      const replyText = replyStyle === "compact"
        ? (item.autoAnswerCompact || item.autoAnswerText)
        : (item.autoAnswerText || item.autoAnswerCompact);

      feedItem.innerHTML = `
        <div class="feed-item-header">
          <div>
            <span class="feed-item-author">${escapeHtml(item.author || "Unknown")}</span>
            <span class="feed-item-handle">${escapeHtml(item.handle || "")}</span>
          </div>
          <span class="feed-item-badge ${badgeClass}">
            ${badgeIcon} ${pct}% ${badgeLabel}
          </span>
        </div>
        <div class="feed-item-snippet">${escapeHtml(item.textSnippet || "No text")}</div>
        <div class="feed-item-actions">
          <span class="feed-item-time">${formatTimeAgo(item.evaluatedAt)}</span>
          <div style="display: flex; gap: 6px;">
            <button class="btn btn-secondary btn-sm btn-copy-feed" title="Copy Auto-Answer">
              <span>📋</span> Copy Reply
            </button>
            ${item.url ? `<a href="${item.url}" target="_blank" class="btn btn-secondary btn-sm" title="Open on X">↗ Open</a>` : ""}
          </div>
        </div>
      `;

      feedItem.querySelector(".btn-copy-feed").addEventListener("click", () => {
        if (replyText) {
          copyText(replyText);
          showToast("Auto-Answer copied!");
        }
      });

      feedList.appendChild(feedItem);
    });
  }

  /**
   * Handle Manual Scoring Flow
   */
  function handleManualScore() {
    const text = manualText.value.trim();
    if (!text) {
      showToast("Please enter tweet text to score.");
      manualText.focus();
      return;
    }

    const author = manualAuthor.value.trim() || "@claim_tester";
    btnManualScore.disabled = true;
    btnManualScore.innerHTML = `<span>⏳</span> Scoring with Jev...`;

    chrome.runtime.sendMessage(
      {
        action: "SCORE_SINGLE_TEXT",
        text,
        author,
        handle: author.startsWith("@") ? author : `@${author}`
      },
      (res) => {
        btnManualScore.disabled = false;
        btnManualScore.innerHTML = `<span>💩</span> Score Claim with Jev`;

        if (!res || !res.success || !res.scored) {
          showToast(`Error: ${res?.error || "Failed to score claim"}`);
          return;
        }

        currentManualScored = res.scored;
        displayManualResult(res.scored);
        loadDashboardState();
      }
    );
  }

  /**
   * Render Manual Scoring Result
   */
  function displayManualResult(scored) {
    manualResult.classList.remove("hidden");

    const pct = scored.stinkinessPct ?? 50;
    manualScoreGauge.textContent = `${pct}%`;

    let scoreColor = "var(--color-primary)";
    if (pct < 40) scoreColor = "var(--color-green)";
    else if (pct < 75) scoreColor = "var(--color-amber)";

    manualScoreGauge.style.color = scoreColor;
    manualVerdict.textContent = scored.verdictLabel || "Analysis Complete";
    manualBrandCallout.textContent = `rated ${pct}% on stinkiness by bullshtt.ai`;

    // Render Signals
    const signals = scored.signals || {};
    const sigItems = [
      { name: "Implausible Claim", val: signals.implausible_claim ?? 0 },
      { name: "Incoherent Mechanism", val: signals.incoherent_mechanism ?? 0 },
      { name: "Zero Evidence", val: signals.zero_verifiable_evidence ?? 0 },
      { name: "Engagement DM Gate", val: signals.engagement_farming_gate ?? 0 },
      { name: "Manufactured Rage", val: signals.manufactured_rage_bait ?? 0 }
    ];

    manualSignalsList.innerHTML = sigItems
      .map((s) => {
        const valPct = Math.min(100, Math.max(0, Math.round(s.val > 1 ? s.val : s.val * 100)));
        let color = "var(--color-green)";
        if (valPct >= 70) color = "var(--color-primary)";
        else if (valPct >= 40) color = "var(--color-amber)";

        return `
          <div class="sig-row">
            <span>${s.name}</span>
            <div style="display: flex; align-items: center; gap: 6px;">
              <div class="sig-track">
                <div class="sig-bar" style="width: ${valPct}%; background: ${color};"></div>
              </div>
              <span style="font-family: var(--font-mono);">${valPct}%</span>
            </div>
          </div>
        `;
      })
      .join("");

    const answer = settingStyle.value === "compact"
      ? (scored.autoAnswerCompact || scored.autoAnswerText)
      : (scored.autoAnswerText || scored.autoAnswerCompact);

    manualAnswerPreview.textContent = answer || "";
  }

  /**
   * Save Settings
   */
  function handleSaveSettings() {
    const newSettings = {
      autoScanViewport: settingAutoscan.checked,
      firewallMode: settingFirewall.value,
      stinkinessThreshold: parseInt(settingThreshold.value, 10),
      replyStyle: settingStyle.value,
      proxyUrl: settingProxyUrl.value.trim(),
      typesafeApiKey: settingTypesafeKey.value.trim()
    };

    btnSaveSettings.disabled = true;
    btnSaveSettings.textContent = "Saving...";

    chrome.runtime.sendMessage({ action: "UPDATE_SETTINGS", settings: newSettings }, (res) => {
      btnSaveSettings.disabled = false;
      btnSaveSettings.innerHTML = `<span>💾</span> Save Settings`;

      if (res && res.success) {
        showToast("Settings saved successfully!");
        checkConnectionStatus();
      } else {
        showToast("Error saving settings.");
      }
    });
  }

  /**
   * Check connection status to proxy and direct Jev
   */
  function checkConnectionStatus() {
    connectionStatusPill.className = "status-pill status-pill-neutral";
    connectionStatusPill.textContent = "Testing...";

    chrome.runtime.sendMessage({ action: "TEST_CONNECTION" }, (res) => {
      if (res && res.proxyOk) {
        connectionStatusPill.className = "status-pill status-pill-ok";
        connectionStatusPill.textContent = "Proxy Online ✅";
      } else if (res && res.jevOk) {
        connectionStatusPill.className = "status-pill status-pill-ok";
        connectionStatusPill.textContent = "Direct Jev Online ⚡";
      } else {
        connectionStatusPill.className = "status-pill status-pill-fail";
        connectionStatusPill.textContent = "Disconnected ❌";
      }
    });
  }

  /**
   * Clear local cache
   */
  function handleClearCache() {
    if (confirm("Are you sure you want to clear the local scored tweet cache?")) {
      chrome.runtime.sendMessage({ action: "CLEAR_CACHE" }, (res) => {
        if (res && res.success) {
          showToast("Local cache cleared!");
          loadDashboardState();
        }
      });
    }
  }

  /**
   * Copy helper
   */
  function copyText(text) {
    navigator.clipboard.writeText(text).catch(() => {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    });
  }

  /**
   * Toast helper
   */
  function showToast(msg) {
    popupToast.textContent = msg;
    popupToast.classList.add("visible");
    clearTimeout(popupToast.__timer);
    popupToast.__timer = setTimeout(() => {
      popupToast.classList.remove("visible");
    }, 2500);
  }

  function escapeHtml(str) {
    return (str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatTimeAgo(isoString) {
    if (!isoString) return "";
    const sec = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
    if (sec < 60) return "Just now";
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    return `${Math.floor(hr / 24)}d ago`;
  }
})();
