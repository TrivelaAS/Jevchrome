/**
 * EXECUTER Popup UI Controller
 * Sober terminal dark-theme UI for managing open pump.fun positions,
 * viewing live exit metrics (Combo 2+4), and editing configuration.
 */

import { calculatePositionMetrics, DEFAULT_CONFIG } from './engine/exit_rules.js';

let appState = {
  positions: [],
  closedTrades: [],
  config: { ...DEFAULT_CONFIG },
  activeTab: 'open'
};

document.addEventListener('DOMContentLoaded', async () => {
  setupTabs();
  setupActionButtons();
  setupSettingsForm();
  await refreshState();
  setInterval(refreshState, 2000);
});

async function refreshState() {
  try {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
      if (chrome.runtime.lastError || !res || !res.success) return;
      appState.positions = res.positions || [];
      appState.closedTrades = res.closedTrades || [];
      appState.config = res.config || DEFAULT_CONFIG;

      renderCounts();
      if (appState.activeTab === 'open') {
        renderPositions();
      } else if (appState.activeTab === 'history') {
        renderHistory();
      }
    });
  } catch (e) {
    // Context invalidated
  }
}

function setupTabs() {
  const tabs = document.querySelectorAll('.tab-btn');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

      tab.classList.add('active');
      const target = tab.dataset.tab;
      appState.activeTab = target;
      document.getElementById(`tab-${target}`).classList.add('active');

      if (target === 'open') renderPositions();
      if (target === 'history') renderHistory();
      if (target === 'settings') populateSettingsForm();
    });
  });
}

function renderCounts() {
  document.getElementById('count-open').textContent = appState.positions.length;
  document.getElementById('count-closed').textContent = appState.closedTrades.length;
}

function renderPositions() {
  const container = document.getElementById('positions-list');
  const now = Date.now();

  if (appState.positions.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        No open positions being monitored.<br>
        Navigate to a coin on <b>pump.fun</b> and click <i>+ Track Current Pump.fun Tab</i>.
      </div>
    `;
    return;
  }

  container.innerHTML = appState.positions.map(pos => {
    const metrics = calculatePositionMetrics(pos, pos.lastPrice, appState.config);
    const ageMin = (now - (pos.openedAtMs || now)) / 60_000;

    const multClass = metrics.multiple >= 1.0 ? 'text-green' : 'text-red';
    const multStr = `${metrics.multiple.toFixed(2)}x`;
    const pnlStr = `${metrics.pnlPct >= 0 ? '+' : ''}${metrics.pnlPct.toFixed(1)}%`;
    const peakStr = `${metrics.peakMultiple.toFixed(2)}x`;

    const armed = metrics.armed;
    const badgeHtml = armed
      ? `<span class="badge-status badge-armed">ARMED</span>`
      : `<span class="badge-status badge-unarmed">UNARMED</span>`;

    // Time countdowns
    let timeStopInfo = '';
    if (!armed) {
      const minLeft = Math.max(0, appState.config.unarmedTimeStopMin - ageMin);
      timeStopInfo = `Unarmed stop in ${minLeft.toFixed(0)}m`;
    } else {
      const maxLeft = Math.max(0, appState.config.maxHoldMin - ageMin);
      timeStopInfo = `Max hold in ${Math.floor(maxLeft / 60)}h ${(maxLeft % 60).toFixed(0)}m`;
    }

    const trailInfo = armed
      ? `Stop at <b>${metrics.trailStopMultiple.toFixed(2)}x</b> (-${appState.config.trailPct}%)`
      : `Arms at <b>${appState.config.trailArmX.toFixed(2)}x</b> (needs +${Math.max(0, (appState.config.trailArmX - metrics.multiple) / metrics.multiple * 100).toFixed(0)}%)`;

    return `
      <div class="pos-card ${armed ? 'armed-card' : 'unarmed-card'}" data-mint="${pos.mint}">
        <div class="pos-header">
          <div>
            <span class="pos-symbol">${escapeHtml(pos.symbol || 'COIN')}</span>
            <span class="pos-mint">${pos.mint.slice(0, 4)}...${pos.mint.slice(-4)}</span>
            ${badgeHtml}
          </div>
          <div class="pos-multiple ${multClass}">
            ${multStr} <span style="font-size: 11px; font-weight: normal;">(${pnlStr})</span>
          </div>
        </div>

        <div class="pos-details-grid">
          <div class="detail-item">
            <span class="detail-label">Peak:</span>
            <span class="detail-val text-bright">${peakStr}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">Entry:</span>
            <span class="detail-val">${formatPrice(pos.entryPrice)}</span>
          </div>
          <div class="detail-item" style="grid-column: span 2;">
            <span class="detail-label">Exit Rule:</span>
            <span class="detail-val">${trailInfo}</span>
          </div>
          <div class="detail-item" style="grid-column: span 2;">
            <span class="detail-label">Time Stop:</span>
            <span class="detail-val ${!armed && (appState.config.unarmedTimeStopMin - ageMin) < 15 ? 'text-amber' : ''}">${timeStopInfo}</span>
          </div>
        </div>

        <div class="pos-actions">
          <button class="btn btn-secondary btn-remove" data-mint="${pos.mint}">Untrack</button>
          <button class="btn btn-danger btn-panic" data-mint="${pos.mint}" data-symbol="${escapeHtml(pos.symbol || 'COIN')}">Panic Sell Now</button>
        </div>
      </div>
    `;
  }).join('');

  // Attach card action listeners
  container.querySelectorAll('.btn-panic').forEach(btn => {
    btn.onclick = () => {
      const mint = btn.dataset.mint;
      const symbol = btn.dataset.symbol;
      if (confirm(`PANIC SELL 100% of ${symbol}? This sends an immediate exit instruction to pump.fun.`)) {
        chrome.runtime.sendMessage({ type: 'PANIC_SELL', payload: { mint } }, () => {
          refreshState();
        });
      }
    };
  });

  container.querySelectorAll('.btn-remove').forEach(btn => {
    btn.onclick = () => {
      const mint = btn.dataset.mint;
      chrome.runtime.sendMessage({ type: 'REMOVE_POSITION', payload: { mint } }, () => {
        refreshState();
      });
    };
  });
}

function renderHistory() {
  const container = document.getElementById('history-list');
  if (appState.closedTrades.length === 0) {
    container.innerHTML = `<div class="empty-state">No closed trades recorded yet.</div>`;
    return;
  }

  container.innerHTML = appState.closedTrades.map(trade => {
    const mult = trade.exitMultiple ? `${trade.exitMultiple.toFixed(2)}x` : '1.00x';
    const multClass = (trade.exitMultiple || 1.0) >= 1.0 ? 'text-green' : 'text-red';
    const dateStr = trade.closedAtMs ? new Date(trade.closedAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';

    return `
      <div class="history-card">
        <div>
          <div style="font-weight: bold; color: #f0f6fc;">${escapeHtml(trade.symbol || 'COIN')} <span class="${multClass}">(${mult})</span></div>
          <div class="history-reason">${escapeHtml(trade.exitReason || 'closed')} • ${dateStr}</div>
        </div>
        <div style="font-size: 10px; color: #8b949e; text-align: right;">
          Peak: ${trade.peakPrice ? (trade.peakPrice / trade.entryPrice).toFixed(2) + 'x' : 'N/A'}<br>
          Mint: ${trade.mint.slice(0, 4)}...${trade.mint.slice(-4)}
        </div>
      </div>
    `;
  }).join('');
}

function setupActionButtons() {
  // Track active tab button
  document.getElementById('btn-track-active').onclick = async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || tabs.length === 0) return;

    const currentTab = tabs[0];
    const url = currentTab.url || '';

    if (!url.includes('pump.fun')) {
      alert('Active tab is not on pump.fun! Open a pump.fun coin page first.');
      return;
    }

    const match = url.match(/\/(?:coin\/)?([1-9A-HJ-NP-Za-km-z]{32,44})/);
    if (!match) {
      alert('Could not find a valid Solana token mint in current pump.fun URL.');
      return;
    }

    const mint = match[1];
    // Fetch coin info
    try {
      const res = await fetch(`https://frontend-api.pump.fun/coins/${mint}`);
      if (res.ok) {
        const coin = await res.json();
        const price = parseFloat(coin.usd_market_cap || coin.market_cap || 1);
        const symbol = coin.symbol || 'COIN';

        chrome.runtime.sendMessage({
          type: 'ADD_POSITION',
          payload: {
            mint,
            symbol,
            entryPrice: price,
            openedAtMs: Date.now()
          }
        }, () => {
          refreshState();
        });
        return;
      }
    } catch (e) {
      // Fallback manual entry
    }

    // Prompt for entry price if API unavailable
    const priceStr = prompt(`Tracking mint: ${mint}\nEnter estimated entry market cap or price in USD:`, '50000');
    if (priceStr && !isNaN(parseFloat(priceStr))) {
      chrome.runtime.sendMessage({
        type: 'ADD_POSITION',
        payload: {
          mint,
          symbol: `${mint.slice(0, 4)}...${mint.slice(-4)}`,
          entryPrice: parseFloat(priceStr),
          openedAtMs: Date.now()
        }
      }, () => {
        refreshState();
      });
    }
  };

  // Toggle manual entry form
  const toggleBtn = document.getElementById('btn-toggle-manual');
  const manualForm = document.getElementById('manual-form');
  toggleBtn.onclick = () => {
    manualForm.classList.toggle('hidden');
  };

  // Submit manual position
  document.getElementById('btn-submit-manual').onclick = () => {
    const mint = document.getElementById('manual-mint').value.trim();
    const symbol = document.getElementById('manual-symbol').value.trim() || 'COIN';
    const price = parseFloat(document.getElementById('manual-price').value);

    if (!mint || isNaN(price) || price <= 0) {
      alert('Please provide a valid mint address and positive entry price/mcap.');
      return;
    }

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
        document.getElementById('manual-mint').value = '';
        document.getElementById('manual-symbol').value = '';
        document.getElementById('manual-price').value = '';
        manualForm.classList.add('hidden');
        refreshState();
      } else {
        alert('Failed to add position: ' + (res?.error || 'Unknown error'));
      }
    });
  };

  // Poll now button
  document.getElementById('btn-poll-now').onclick = () => {
    chrome.runtime.sendMessage({ type: 'POLL_NOW' }, () => {
      refreshState();
    });
  };
}

function setupSettingsForm() {
  document.getElementById('btn-save-settings').onclick = () => {
    const newConfig = {
      trailArmX: parseFloat(document.getElementById('cfg-arm-x').value) || DEFAULT_CONFIG.trailArmX,
      trailPct: parseFloat(document.getElementById('cfg-trail-pct').value) || DEFAULT_CONFIG.trailPct,
      trailConfirm: parseInt(document.getElementById('cfg-trail-confirm').value, 10) || DEFAULT_CONFIG.trailConfirm,
      unarmedTimeStopMin: parseFloat(document.getElementById('cfg-unarmed-time').value) || DEFAULT_CONFIG.unarmedTimeStopMin,
      maxHoldMin: parseFloat(document.getElementById('cfg-max-hold').value) || DEFAULT_CONFIG.maxHoldMin,
      checkIntervalSec: parseInt(document.getElementById('cfg-poll-sec').value, 10) || DEFAULT_CONFIG.checkIntervalSec
    };

    chrome.runtime.sendMessage({ type: 'UPDATE_CONFIG', payload: { config: newConfig } }, (res) => {
      if (res && res.success) {
        alert('Settings saved successfully!');
        appState.config = res.config;
      }
    });
  };

  document.getElementById('btn-reset-settings').onclick = () => {
    if (confirm('Reset all exit configuration parameters to default values?')) {
      chrome.runtime.sendMessage({ type: 'RESET_CONFIG' }, (res) => {
        if (res && res.success) {
          appState.config = res.config;
          populateSettingsForm();
        }
      });
    }
  };
}

function populateSettingsForm() {
  const cfg = appState.config || DEFAULT_CONFIG;
  document.getElementById('cfg-arm-x').value = cfg.trailArmX;
  document.getElementById('cfg-trail-pct').value = cfg.trailPct;
  document.getElementById('cfg-trail-confirm').value = cfg.trailConfirm;
  document.getElementById('cfg-unarmed-time').value = cfg.unarmedTimeStopMin;
  document.getElementById('cfg-max-hold').value = cfg.maxHoldMin;
  document.getElementById('cfg-poll-sec').value = cfg.checkIntervalSec;
}

function formatPrice(val) {
  if (val === null || val === undefined) return 'N/A';
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 1_000) return `$${(val / 1_000).toFixed(1)}K`;
  if (val >= 1) return `$${val.toFixed(2)}`;
  return `$${val.toFixed(6)}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
