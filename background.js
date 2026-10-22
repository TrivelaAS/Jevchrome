/**
 * EXECUTER Background Service Worker
 * Manages position polling, exit rules evaluation, storage persistence,
 * and dispatching auto-sell triggers to pump.fun content scripts.
 */

import { evaluateExit, DEFAULT_CONFIG } from './engine/exit_rules.js';

const STORAGE_KEYS = {
  POSITIONS: 'executer_positions',
  CLOSED_TRADES: 'executer_closed_trades',
  CONFIG: 'executer_config'
};

const ALARM_NAME = 'executer_price_poller';

// Initialize storage and alarm on install/startup
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[EXECUTER] Extension installed/updated.');
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.POSITIONS,
    STORAGE_KEYS.CLOSED_TRADES,
    STORAGE_KEYS.CONFIG
  ]);

  if (!stored[STORAGE_KEYS.POSITIONS]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.POSITIONS]: [] });
  }
  if (!stored[STORAGE_KEYS.CLOSED_TRADES]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.CLOSED_TRADES]: [] });
  }
  if (!stored[STORAGE_KEYS.CONFIG]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.CONFIG]: DEFAULT_CONFIG });
  }

  // Setup periodic alarm (Chrome alarms have a 1-minute floor in production, so we pair with interval)
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
  startIntervalPoller();
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) {
    pollAllPositions();
  }
});

let intervalTimer = null;
function startIntervalPoller() {
  if (intervalTimer) clearInterval(intervalTimer);
  intervalTimer = setInterval(() => {
    pollAllPositions();
  }, (DEFAULT_CONFIG.checkIntervalSec || 10) * 1000);
}

// Ensure poller runs on service worker wakeup
startIntervalPoller();

/**
 * Robust multi-source price fetcher for Solana / pump.fun tokens.
 * Data quality rule: returns null on failure so evaluateExit treats it as unknown_price.
 */
async function fetchTokenPrice(mint) {
  if (!mint || typeof mint !== 'string' || mint.trim() === '') {
    return null;
  }

  // 1. Try DexScreener API
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      headers: { 'Accept': 'application/json' }
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.pairs && data.pairs.length > 0) {
        // Find best pair (highest liquidity or pump.fun / raydium)
        const pair = data.pairs[0];
        const price = parseFloat(pair.priceUsd);
        if (!Number.isNaN(price) && price > 0) {
          return { price, mcap: pair.marketCap || null, source: 'dexscreener' };
        }
      }
    }
  } catch (err) {
    console.warn(`[EXECUTER] DexScreener fetch error for ${mint}:`, err);
  }

  // 2. Try pump.fun frontend API
  try {
    const res = await fetch(`https://frontend-api.pump.fun/coins/${mint}`, {
      headers: { 'Accept': 'application/json' }
    });
    if (res.ok) {
      const data = await res.json();
      if (data) {
        const mcap = parseFloat(data.usd_market_cap || data.market_cap);
        const price = parseFloat(data.price_usd || (mcap ? mcap / 1_000_000_000 : 0));
        if (!Number.isNaN(price) && price > 0) {
          return { price, mcap, source: 'pumpfun_api' };
        }
      }
    }
  } catch (err) {
    console.warn(`[EXECUTER] pump.fun API fetch error for ${mint}:`, err);
  }

  // 3. Try Jupiter Price API
  try {
    const res = await fetch(`https://api.jup.ag/price/v2?ids=${mint}`);
    if (res.ok) {
      const data = await res.json();
      if (data && data.data && data.data[mint]) {
        const price = parseFloat(data.data[mint].price);
        if (!Number.isNaN(price) && price > 0) {
          return { price, mcap: null, source: 'jupiter' };
        }
      }
    }
  } catch (err) {
    console.warn(`[EXECUTER] Jupiter fetch error for ${mint}:`, err);
  }

  return null;
}

/**
 * Evaluates all open positions and triggers auto-sell on exit conditions.
 */
async function pollAllPositions() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.POSITIONS,
    STORAGE_KEYS.CLOSED_TRADES,
    STORAGE_KEYS.CONFIG
  ]);

  const positions = data[STORAGE_KEYS.POSITIONS] || [];
  const closedTrades = data[STORAGE_KEYS.CLOSED_TRADES] || [];
  const config = data[STORAGE_KEYS.CONFIG] || DEFAULT_CONFIG;

  if (positions.length === 0) return;

  const nowMs = Date.now();
  const updatedPositions = [];
  const newlyClosed = [];

  for (const pos of positions) {
    const quote = await fetchTokenPrice(pos.mint);
    const currentPrice = quote ? quote.price : null;

    const evalResult = evaluateExit(pos, currentPrice, nowMs, config);

    if (evalResult.action === 'SELL') {
      console.warn(`[EXECUTER] Auto-sell triggered for ${pos.symbol || pos.mint}: ${evalResult.reason}`, evalResult.detail);

      // Dispatch execution signal to pump.fun content scripts
      await dispatchAutoSell(evalResult.updatedPosition, evalResult.reason, evalResult.detail);

      // Record closed trade
      newlyClosed.push({
        ...evalResult.updatedPosition,
        exitPrice: currentPrice,
        exitMultiple: pos.entryPrice ? (currentPrice / pos.entryPrice) : 1.0,
        exitReason: evalResult.reason,
        exitDetail: evalResult.detail,
        closedAtMs: nowMs
      });
    } else {
      // Position remains open (HOLD or WAIT)
      updatedPositions.push(evalResult.updatedPosition);
    }
  }

  await chrome.storage.local.set({
    [STORAGE_KEYS.POSITIONS]: updatedPositions,
    [STORAGE_KEYS.CLOSED_TRADES]: [...newlyClosed, ...closedTrades].slice(0, 100),
    lastPollMs: nowMs
  });
}

/**
 * Dispatches an auto-sell instruction to any open pump.fun tabs.
 */
async function dispatchAutoSell(position, reason, detail) {
  try {
    const tabs = await chrome.tabs.query({ url: '*://pump.fun/*' });
    let executedInTab = false;

    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: 'EXECUTE_SELL',
          position,
          reason,
          detail
        });
        executedInTab = true;
      } catch (err) {
        // Tab may not have content script ready
      }
    }

    // Also send an optional desktop/browser notification
    try {
      if (chrome.notifications) {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: `EXECUTER: Auto-Sell Fired (${reason})`,
          message: `${position.symbol || 'Coin'} triggered ${reason}. Multiple: ${detail.multiple ? detail.multiple.toFixed(2) + 'x' : 'N/A'}.`,
          priority: 2
        });
      }
    } catch (e) {
      // Notifications permission optional
    }

    return { executedInTab };
  } catch (err) {
    console.error('[EXECUTER] Error dispatching auto-sell:', err);
    return { executedInTab: false, error: err.message };
  }
}

// Handle runtime messages from popup and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === 'GET_STATE') {
        const data = await chrome.storage.local.get([
          STORAGE_KEYS.POSITIONS,
          STORAGE_KEYS.CLOSED_TRADES,
          STORAGE_KEYS.CONFIG,
          'lastPollMs'
        ]);
        sendResponse({
          success: true,
          positions: data[STORAGE_KEYS.POSITIONS] || [],
          closedTrades: data[STORAGE_KEYS.CLOSED_TRADES] || [],
          config: data[STORAGE_KEYS.CONFIG] || DEFAULT_CONFIG,
          lastPollMs: data.lastPollMs || null
        });
        return;
      }

      if (message.type === 'ADD_POSITION') {
        const { mint, symbol, entryPrice, openedAtMs } = message.payload;
        if (!mint || !entryPrice || entryPrice <= 0) {
          sendResponse({ success: false, error: 'Invalid mint or entry price' });
          return;
        }

        const data = await chrome.storage.local.get([STORAGE_KEYS.POSITIONS]);
        const positions = data[STORAGE_KEYS.POSITIONS] || [];

        // Check if already tracking
        const existingIdx = positions.findIndex(p => p.mint === mint);
        const nowMs = Date.now();

        const newPos = {
          id: `pos_${mint.slice(0, 8)}_${nowMs}`,
          mint,
          symbol: symbol || `${mint.slice(0, 4)}...${mint.slice(-4)}`,
          entryPrice: parseFloat(entryPrice),
          peakPrice: parseFloat(entryPrice),
          armed: false,
          breachCount: 0,
          openedAtMs: openedAtMs || nowMs,
          lastCheckMs: nowMs,
          lastPrice: parseFloat(entryPrice),
          lastMultiple: 1.0
        };

        if (existingIdx >= 0) {
          positions[existingIdx] = { ...positions[existingIdx], ...newPos };
        } else {
          positions.unshift(newPos);
        }

        await chrome.storage.local.set({ [STORAGE_KEYS.POSITIONS]: positions });
        console.log(`[EXECUTER] Added position for ${newPos.symbol} (${mint}) at ${entryPrice}`);

        // Trigger immediate background poll
        pollAllPositions();

        sendResponse({ success: true, position: newPos });
        return;
      }

      if (message.type === 'REMOVE_POSITION') {
        const { mint } = message.payload;
        const data = await chrome.storage.local.get([STORAGE_KEYS.POSITIONS]);
        const positions = (data[STORAGE_KEYS.POSITIONS] || []).filter(p => p.mint !== mint);
        await chrome.storage.local.set({ [STORAGE_KEYS.POSITIONS]: positions });
        sendResponse({ success: true });
        return;
      }

      if (message.type === 'PANIC_SELL') {
        const { mint } = message.payload;
        const data = await chrome.storage.local.get([
          STORAGE_KEYS.POSITIONS,
          STORAGE_KEYS.CLOSED_TRADES
        ]);
        const positions = data[STORAGE_KEYS.POSITIONS] || [];
        const closedTrades = data[STORAGE_KEYS.CLOSED_TRADES] || [];

        const targetPos = positions.find(p => p.mint === mint);
        if (!targetPos) {
          sendResponse({ success: false, error: 'Position not found' });
          return;
        }

        const nowMs = Date.now();
        const quote = await fetchTokenPrice(mint);
        const exitPrice = quote ? quote.price : targetPos.lastPrice || targetPos.entryPrice;

        await dispatchAutoSell(targetPos, 'panic_sell', { manual: true, exitPrice });

        const updatedPositions = positions.filter(p => p.mint !== mint);
        const closedEntry = {
          ...targetPos,
          exitPrice,
          exitMultiple: exitPrice / targetPos.entryPrice,
          exitReason: 'panic_sell',
          exitDetail: { manual: true, timestamp: nowMs },
          closedAtMs: nowMs
        };

        await chrome.storage.local.set({
          [STORAGE_KEYS.POSITIONS]: updatedPositions,
          [STORAGE_KEYS.CLOSED_TRADES]: [closedEntry, ...closedTrades].slice(0, 100)
        });

        sendResponse({ success: true, closedTrade: closedEntry });
        return;
      }

      if (message.type === 'UPDATE_CONFIG') {
        const { config } = message.payload;
        const merged = { ...DEFAULT_CONFIG, ...config };
        await chrome.storage.local.set({ [STORAGE_KEYS.CONFIG]: merged });
        startIntervalPoller();
        sendResponse({ success: true, config: merged });
        return;
      }

      if (message.type === 'RESET_CONFIG') {
        await chrome.storage.local.set({ [STORAGE_KEYS.CONFIG]: DEFAULT_CONFIG });
        startIntervalPoller();
        sendResponse({ success: true, config: DEFAULT_CONFIG });
        return;
      }

      if (message.type === 'POLL_NOW') {
        await pollAllPositions();
        sendResponse({ success: true });
        return;
      }

      sendResponse({ success: false, error: 'Unknown message type' });
    } catch (err) {
      console.error('[EXECUTER] Error handling message:', err);
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true; // Keep message channel open for async response
});
