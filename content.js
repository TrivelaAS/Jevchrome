/**
 * EXECUTER Content Script (pump.fun)
 * Injected on https://pump.fun/*
 *
 * Capabilities:
 * 1. 1-Click "Track in EXECUTER" pill injected into pump.fun trade panel.
 * 2. Auto-detects manual buys on pump.fun and registers them.
 * 3. Executes DOM-automated 100% sell when background exit signal arrives.
 */

(() => {
  console.log('[EXECUTER] pump.fun Exit Guardian active.');

  let currentMint = null;
  let isTrackingCurrent = false;

  function extractMintFromUrl() {
    const match = window.location.pathname.match(/\/(?:coin\/)?([1-9A-HJ-NP-Za-km-z]{32,44})/);
    return match ? match[1] : null;
  }

  function extractTokenSymbol() {
    const titleEl = document.querySelector('h1, h2, [class*="ticker"], [class*="symbol"]');
    if (titleEl && titleEl.textContent) {
      const match = titleEl.textContent.match(/\$([A-Za-z0-9_-]+)/);
      if (match) return match[1];
      const trimmed = titleEl.textContent.trim().split(/\s+/)[0];
      if (trimmed.length > 0 && trimmed.length < 15) return trimmed;
    }
    return null;
  }

  async function getCoinData(mint) {
    try {
      const res = await fetch(`https://frontend-api.pump.fun/coins/${mint}`);
      if (res.ok) {
        return await res.json();
      }
    } catch (e) {
      console.warn('[EXECUTER] Error reading coin from pump.fun frontend-api:', e);
    }
    return null;
  }

  // Inject or update the 1-click EXECUTER action pill
  async function injectExecuterPill() {
    const mint = extractMintFromUrl();
    if (!mint) {
      removePill();
      return;
    }

    currentMint = mint;

    // Check if background is already tracking this mint
    try {
      chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
        if (chrome.runtime.lastError || !response || !response.success) return;
        const tracked = response.positions.find(p => p.mint === mint);
        isTrackingCurrent = Boolean(tracked);
        renderPill(mint, tracked);
      });
    } catch (e) {
      // Extension context invalidated or loading
    }
  }

  function removePill() {
    const existing = document.getElementById('executer-pill-container');
    if (existing) existing.remove();
  }

  function renderPill(mint, trackedPosition = null) {
    let container = document.getElementById('executer-pill-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'executer-pill-container';
      container.style.position = 'fixed';
      container.style.bottom = '20px';
      container.style.right = '20px';
      container.style.zIndex = '999999';
      container.style.fontFamily = 'monospace';
      container.style.fontSize = '12px';
      document.body.appendChild(container);
    }

    if (trackedPosition) {
      const mult = trackedPosition.lastMultiple ? `${trackedPosition.lastMultiple.toFixed(2)}x` : '1.00x';
      const peak = trackedPosition.peakPrice && trackedPosition.entryPrice
        ? `${(trackedPosition.peakPrice / trackedPosition.entryPrice).toFixed(2)}x`
        : mult;
      const status = trackedPosition.armed ? 'ARMED' : 'MONITORING';

      container.innerHTML = `
        <div style="background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 8px 12px; color: #c9d1d9; box-shadow: 0 4px 12px rgba(0,0,0,0.4); display: flex; align-items: center; gap: 8px;">
          <span style="color: ${trackedPosition.armed ? '#3fb950' : '#d29922'}; font-weight: bold;">🛡️ ${status}</span>
          <span>${trackedPosition.symbol || 'COIN'}: <b>${mult}</b> (Peak: ${peak})</span>
          <button id="executer-pill-panic" style="background: #da3633; color: white; border: none; border-radius: 4px; padding: 3px 8px; cursor: pointer; font-size: 11px; font-weight: bold;">Panic Sell</button>
        </div>
      `;

      const panicBtn = document.getElementById('executer-pill-panic');
      if (panicBtn) {
        panicBtn.onclick = () => {
          if (confirm(`Panic sell 100% of ${trackedPosition.symbol || mint}?`)) {
            chrome.runtime.sendMessage({
              type: 'PANIC_SELL',
              payload: { mint }
            }, () => {
              injectExecuterPill();
            });
          }
        };
      }
    } else {
      container.innerHTML = `
        <button id="executer-pill-track" style="background: #238636; color: white; border: 1px solid #2ea043; border-radius: 8px; padding: 8px 14px; cursor: pointer; font-family: monospace; font-size: 12px; font-weight: bold; box-shadow: 0 4px 12px rgba(0,0,0,0.3); display: flex; align-items: center; gap: 6px;">
          <span>🛡️ Track in EXECUTER</span>
          <span style="font-size: 10px; opacity: 0.8;">(Combo 2+4 Stop)</span>
        </button>
      `;

      const trackBtn = document.getElementById('executer-pill-track');
      if (trackBtn) {
        trackBtn.onclick = async () => {
          trackBtn.textContent = '⏳ Fetching price...';
          const coinData = await getCoinData(mint);
          const price = coinData ? parseFloat(coinData.usd_market_cap || coinData.market_cap || 1) : 1;
          const symbol = coinData ? coinData.symbol : extractTokenSymbol() || 'COIN';

          chrome.runtime.sendMessage({
            type: 'ADD_POSITION',
            payload: {
              mint,
              symbol,
              entryPrice: price,
              openedAtMs: Date.now()
            }
          }, (res) => {
            if (res && res.success) {
              injectExecuterPill();
            } else {
              alert('Failed to track position: ' + (res?.error || 'Unknown error'));
              injectExecuterPill();
            }
          });
        };
      }
    }
  }

  // Hook buy button clicks on pump.fun trade panel
  function setupBuyListener() {
    document.addEventListener('click', (e) => {
      const target = e.target.closest('button');
      if (!target) return;

      const text = (target.textContent || '').toLowerCase().trim();
      if (text.includes('place trade') || text.includes('quick buy') || (text === 'buy' && target.type === 'submit')) {
        const mint = extractMintFromUrl();
        if (mint) {
          console.log('[EXECUTER] Buy action detected on pump.fun for mint:', mint);
          setTimeout(() => {
            injectExecuterPill();
          }, 1500);
        }
      }
    }, true);
  }

  // Auto-sell execution engine inside pump.fun DOM
  async function performDOMSell(position, reason, detail) {
    showExitBanner(position, reason, detail);

    console.warn(`[EXECUTER] Executing 100% sell for ${position.symbol} due to ${reason}`);

    // Step 1: Switch to "Sell" tab if available
    const buttons = Array.from(document.querySelectorAll('button, div[role="tab"]'));
    const sellTab = buttons.find(b => (b.textContent || '').trim().toLowerCase() === 'sell');
    if (sellTab) {
      sellTab.click();
      await sleep(200);
    }

    // Step 2: Click "100%" or "Max" amount button
    const maxButtons = Array.from(document.querySelectorAll('button'));
    const hundredPctBtn = maxButtons.find(b => {
      const t = (b.textContent || '').trim().toLowerCase();
      return t === '100%' || t === 'max';
    });
    if (hundredPctBtn) {
      hundredPctBtn.click();
      await sleep(250);
    }

    // Step 3: Click "Place trade" or "Quick Sell" button
    const tradeButtons = Array.from(document.querySelectorAll('button'));
    const placeTradeBtn = tradeButtons.find(b => {
      const t = (b.textContent || '').trim().toLowerCase();
      return t.includes('place trade') || t.includes('sell') && !t.includes('100%');
    });

    if (placeTradeBtn && !placeTradeBtn.disabled) {
      console.log('[EXECUTER] Triggering sell submit button...');
      placeTradeBtn.click();
    } else {
      console.warn('[EXECUTER] Sell button not directly clickable or disabled; user alerted via overlay banner');
    }
  }

  function showExitBanner(position, reason, detail) {
    const banner = document.createElement('div');
    banner.style.position = 'fixed';
    banner.style.top = '0';
    banner.style.left = '0';
    banner.style.right = '0';
    banner.style.background = '#da3633';
    banner.style.color = '#ffffff';
    banner.style.padding = '12px 20px';
    banner.style.zIndex = '9999999';
    banner.style.fontFamily = 'monospace';
    banner.style.fontSize = '14px';
    banner.style.fontWeight = 'bold';
    banner.style.display = 'flex';
    banner.style.justifyContent = 'space-between';
    banner.style.alignItems = 'center';
    banner.style.boxShadow = '0 4px 16px rgba(0,0,0,0.6)';

    banner.innerHTML = `
      <div>
        🛡️ [EXECUTER AUTO-SELL] ${position.symbol || 'COIN'}: Triggered ${reason.toUpperCase()} | Peak: ${(detail.peakPrice || 0)} | Price: ${(detail.currentPrice || 0)}
      </div>
      <button style="background: #ffffff; color: #da3633; border: none; border-radius: 4px; padding: 4px 10px; cursor: pointer; font-weight: bold;" onclick="this.parentElement.remove()">Dismiss</button>
    `;

    document.body.appendChild(banner);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Listen for messages from background script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'EXECUTE_SELL') {
      const { position, reason, detail } = message;
      performDOMSell(position, reason, detail);
      sendResponse({ success: true, acknowledged: true });
      return true;
    }
  });

  // Watch URL changes in SPA
  let lastUrl = window.location.href;
  const observer = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      injectExecuterPill();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Initial setup
  setupBuyListener();
  injectExecuterPill();
  setInterval(injectExecuterPill, 3000);
})();
