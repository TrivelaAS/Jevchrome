/**
 * bullshtt.ai — Background Service Worker (Manifest V3)
 * Real-time X.com bullshit & rage-bait scorer + auto-answer orchestrator powered by Jev.
 */

import {
  JEV_ENDPOINT,
  JEV_MODEL,
  computePostHash,
  buildJevBatchRequest,
  scoreBatchFromJev,
  isCacheEntryFresh,
  formatAutoAnswer
} from "./engine/bs_scorer.js";

const DEFAULT_SETTINGS = {
  autoScanViewport: true,
  firewallMode: "xray", // "xray" | "collapse"
  stinkinessThreshold: 75, // 1-100
  replyStyle: "full", // "full" | "compact"
  proxyUrl: "http://127.0.0.1:8787/api/score",
  typesafeApiKey: ""
};

const DEFAULT_STATS = {
  totalScanned: 0,
  stinkyCount: 0,
  avgStinkiness: 0,
  recentVerdicts: []
};

const STORAGE_KEYS = {
  SETTINGS: "bs_settings",
  STATS: "bs_stats",
  CACHE: "bs_cache"
};

// Initialize default storage on install
chrome.runtime.onInstalled.addListener(async () => {
  console.log("[bullshtt.ai] Service worker installed/updated.");
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.SETTINGS,
    STORAGE_KEYS.STATS,
    STORAGE_KEYS.CACHE
  ]);

  if (!stored[STORAGE_KEYS.SETTINGS]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: DEFAULT_SETTINGS });
  } else {
    // Merge any new default settings
    await chrome.storage.local.set({
      [STORAGE_KEYS.SETTINGS]: { ...DEFAULT_SETTINGS, ...stored[STORAGE_KEYS.SETTINGS] }
    });
  }

  if (!stored[STORAGE_KEYS.STATS]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.STATS]: DEFAULT_STATS });
  }

  if (!stored[STORAGE_KEYS.CACHE]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.CACHE]: {} });
  }
});

/**
 * Retrieve current settings from storage
 */
async function getSettings() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEYS.SETTINGS] || {}) };
}

/**
 * Retrieve current stats from storage
 */
async function getStats() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.STATS);
  return { ...DEFAULT_STATS, ...(data[STORAGE_KEYS.STATS] || {}) };
}

/**
 * Retrieve cache from storage
 */
async function getCache() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.CACHE);
  return data[STORAGE_KEYS.CACHE] || {};
}

/**
 * Helper to normalize scored results (whether returned as Array or Object)
 * into a dictionary keyed by post ID.
 */
function normalizeScoredResults(rawResults) {
  const map = {};
  if (Array.isArray(rawResults)) {
    for (const item of rawResults) {
      if (item && item.id) {
        map[String(item.id)] = item;
      }
    }
  } else if (rawResults && typeof rawResults === "object") {
    for (const [k, v] of Object.entries(rawResults)) {
      if (v && (v.id || k)) {
        map[String(v.id || k)] = v;
      }
    }
  }
  return map;
}

/**
 * Call the local/remote bullshtt.ai proxy server
 */
async function callProxyScorer(proxyUrl, posts) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 7000);

  try {
    const res = await fetch(proxyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ posts }),
      signal: controller.signal
    });

    if (!res.ok) {
      throw new Error(`Proxy responded with HTTP ${res.status}`);
    }

    const data = await res.json();
    if (!data || !data.results) {
      throw new Error("Invalid response format from proxy: missing results");
    }

    return normalizeScoredResults(data.results);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Direct fallback to Jev API (jev-1.14.0) using user's API key
 */
async function callDirectJevScorer(apiKey, posts) {
  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error("No TypeSafe API key provided for direct fallback.");
  }

  const trimmedKey = apiKey.trim();
  const payload = buildJevBatchRequest(posts, JEV_MODEL);

  const res = await fetch(JEV_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${trimmedKey}`
    },
    body: JSON.stringify(payload),
    redirect: "error"
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Jev API error HTTP ${res.status}: ${errText}`);
  }

  const responseData = await res.json();
  console.log(`[bullshtt.ai] Jev model=${responseData.model || JEV_MODEL}`);

  const rawResults = scoreBatchFromJev(posts, payload, responseData);
  return normalizeScoredResults(rawResults);
}

/**
 * Core scoring flow: checks L1 cache, falls back to proxy, then direct Jev
 */
async function handleScorePosts(posts) {
  if (!Array.isArray(posts) || posts.length === 0) {
    return { success: true, results: {} };
  }

  const settings = await getSettings();
  const stats = await getStats();
  const cache = await getCache();

  const results = {};
  const postsToScore = [];

  // Step 1: L1 Cache check with postHash freshness
  for (const post of posts) {
    if (!post || !post.id) continue;
    const expectedHash = computePostHash(post);
    const cachedEntry = cache[String(post.id)];

    if (cachedEntry && isCacheEntryFresh(cachedEntry, expectedHash)) {
      results[String(post.id)] = cachedEntry;
    } else {
      postsToScore.push(post);
    }
  }

  // If everything was cached, return immediately
  if (postsToScore.length === 0) {
    return { success: true, results, fromCache: true };
  }

  // Step 2: Score uncached posts
  let newResults = null;
  let usedProxy = false;
  let usedDirectJev = false;
  let lastError = null;

  // Try proxy first
  if (settings.proxyUrl) {
    try {
      newResults = await callProxyScorer(settings.proxyUrl, postsToScore);
      usedProxy = true;
    } catch (proxyErr) {
      console.warn("[bullshtt.ai] Proxy unreachable or failed:", proxyErr.message);
      lastError = proxyErr;
    }
  }

  // If proxy failed, try direct Jev
  if (!newResults && settings.typesafeApiKey) {
    try {
      newResults = await callDirectJevScorer(settings.typesafeApiKey, postsToScore);
      usedDirectJev = true;
    } catch (jevErr) {
      console.error("[bullshtt.ai] Direct Jev call failed:", jevErr.message);
      lastError = jevErr;
    }
  }

  if (!newResults) {
    return {
      success: false,
      results,
      error: lastError ? lastError.message : "Proxy is offline and no TypeSafe API key is configured."
    };
  }

  // Step 3: Update results, cache, and stats
  const newlyScoredIds = Object.keys(newResults);
  const updatedCache = { ...cache };
  let newTotalScanned = stats.totalScanned;
  let newStinkyCount = stats.stinkyCount;
  let totalScoreSum = stats.avgStinkiness * stats.totalScanned;
  const recentVerdicts = [...(stats.recentVerdicts || [])];

  for (const postId of newlyScoredIds) {
    const scored = newResults[postId];
    if (!scored) continue;

    // Ensure autoAnswerText and autoAnswerCompact exist
    if (!scored.autoAnswerText) {
      scored.autoAnswerText = formatAutoAnswer(scored, { style: "full" });
    }
    if (!scored.autoAnswerCompact) {
      scored.autoAnswerCompact = formatAutoAnswer(scored, { style: "compact" });
    }

    results[postId] = scored;
    updatedCache[postId] = scored;

    // Match with original post for metadata
    const originalPost = postsToScore.find((p) => String(p.id) === String(postId));

    newTotalScanned += 1;
    totalScoreSum += (scored.stinkinessPct || 0);

    const threshold = settings.stinkinessThreshold || 75;
    if ((scored.stinkinessPct || 0) >= threshold) {
      newStinkyCount += 1;
    }

    // Add to recent verdicts list
    recentVerdicts.unshift({
      id: postId,
      author: originalPost?.author || scored.author || "Unknown",
      handle: originalPost?.handle || scored.handle || "@unknown",
      textSnippet: (originalPost?.text || "").slice(0, 140),
      stinkinessPct: scored.stinkinessPct,
      verdictLabel: scored.verdictLabel,
      evaluatedAt: scored.evaluatedAt || new Date().toISOString(),
      autoAnswerText: scored.autoAnswerText,
      autoAnswerCompact: scored.autoAnswerCompact,
      signals: scored.signals || {},
      url: originalPost?.url || ""
    });
  }

  // Cap recent verdicts at 50
  if (recentVerdicts.length > 50) {
    recentVerdicts.length = 50;
  }

  const updatedStats = {
    totalScanned: newTotalScanned,
    stinkyCount: newStinkyCount,
    avgStinkiness: newTotalScanned > 0 ? Math.round(totalScoreSum / newTotalScanned) : 0,
    recentVerdicts
  };

  // Persist to storage
  await chrome.storage.local.set({
    [STORAGE_KEYS.CACHE]: updatedCache,
    [STORAGE_KEYS.STATS]: updatedStats
  });

  return {
    success: true,
    results,
    usedProxy,
    usedDirectJev
  };
}

// Runtime message router
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) {
    return false;
  }

  (async () => {
    try {
      switch (message.action) {
        case "SCORE_POSTS": {
          const res = await handleScorePosts(message.posts || []);
          sendResponse(res);
          break;
        }

        case "SCORE_SINGLE_TEXT": {
          const text = (message.text || "").trim();
          if (!text) {
            sendResponse({ success: false, error: "Empty text provided" });
            break;
          }

          const mockPost = {
            id: `manual_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            author: message.author || "Manual Prompt",
            handle: message.handle || "@manual_test",
            text,
            url: "",
            metrics: {}
          };

          const res = await handleScorePosts([mockPost]);
          if (res.success && res.results[mockPost.id]) {
            sendResponse({ success: true, scored: res.results[mockPost.id] });
          } else {
            sendResponse({ success: false, error: res.error || "Scoring failed" });
          }
          break;
        }

        case "GET_STATE": {
          const settings = await getSettings();
          const stats = await getStats();
          const cache = await getCache();
          sendResponse({
            success: true,
            settings,
            stats,
            cacheSize: Object.keys(cache).length
          });
          break;
        }

        case "UPDATE_SETTINGS": {
          const current = await getSettings();
          const updated = { ...current, ...(message.settings || {}) };
          await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: updated });
          sendResponse({ success: true, settings: updated });
          break;
        }

        case "CLEAR_CACHE": {
          await chrome.storage.local.set({ [STORAGE_KEYS.CACHE]: {} });
          sendResponse({ success: true });
          break;
        }

        case "TEST_CONNECTION": {
          const settings = await getSettings();
          let proxyOk = false;
          let jevOk = false;
          let error = null;

          // Test proxy
          if (settings.proxyUrl) {
            try {
              const pingUrl = settings.proxyUrl.includes("/api/score")
                ? settings.proxyUrl.replace(/\/api\/score\/?$/, "/api/health")
                : `${settings.proxyUrl.replace(/\/$/, "")}/api/health`;

              const res = await fetch(pingUrl, { method: "GET" });
              if (res.ok) proxyOk = true;
            } catch {
              // Ignore proxy ping failure
            }
          }

          // Test Jev API if key is present
          if (settings.typesafeApiKey) {
            try {
              const res = await fetch(JEV_ENDPOINT, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${settings.typesafeApiKey.trim()}`
                },
                body: JSON.stringify({
                  model: JEV_MODEL,
                  questions: {
                    ping_test: {
                      type: "score",
                      instructions: "Health ping."
                    }
                  }
                }),
                redirect: "error"
              });
              if (res.ok) jevOk = true;
            } catch (err) {
              error = err.message;
            }
          }

          sendResponse({ success: true, proxyOk, jevOk, error });
          break;
        }

        default:
          sendResponse({ success: false, error: `Unknown action: ${message.action}` });
      }
    } catch (err) {
      console.error("[bullshtt.ai] Error in background script:", err);
      sendResponse({ success: false, error: err.message || String(err) });
    }
  })();

  return true; // Keep message channel open for async response
});
