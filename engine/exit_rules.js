/**
 * EXECUTER Exit Rules Engine (Combo 2 + 4)
 * Pure, testable, deterministic exit evaluation.
 *
 * Exit Policy:
 * 1. Trailing Stop from Peak (Combo 2):
 *    - Arms once peak price reaches trailArmX (default: 1.3x entry price).
 *    - Triggers auto-sell when price pulls back trailPct (default: 25%) below peakPrice.
 *    - Confirmed over trailConfirm (default: 2) consecutive price checks.
 *
 * 2. Unarmed Time Stop (Combo 4):
 *    - Auto-sell when position age reaches unarmedTimeStopMin (default: 60 min)
 *      if position never armed (peak < 1.3x entry).
 *
 * 3. Max Hold Time Stop (Combo 4):
 *    - Auto-sell when position age reaches maxHoldMin (default: 240 min / 4h),
 *      acting as a hard backstop so forgotten trades never run forever.
 *
 * Data Quality Guarantee:
 * - Unknown is never zero: invalid/null/undefined/NaN/<=0 prices return { action: "WAIT", reason: "unknown_price" }.
 *   Never triggers a false stop-out on network failure or missing quote!
 */

export const DEFAULT_CONFIG = Object.freeze({
  trailArmX: 1.3,           // Arm trailing stop when peak >= 1.3x entry (+30%)
  trailPct: 25,             // Auto-sell when price pulls back 25% from peak
  trailConfirm: 2,          // Require 2 consecutive checks below stop
  unarmedTimeStopMin: 60,   // Auto-sell after 60 min if never armed
  maxHoldMin: 240,          // Max hold 240 min (4 hours)
  checkIntervalSec: 10      // Price poll interval in seconds
});

/**
 * Evaluates whether an open position should SELL, HOLD, or WAIT.
 *
 * @param {Object} position - Current position state
 * @param {number} position.entryPrice - Base entry price (> 0)
 * @param {number} [position.peakPrice] - High-water mark observed so far
 * @param {boolean} [position.armed] - True once peak reached trailArmX * entryPrice
 * @param {number} [position.breachCount] - Consecutive checks below trailing stop line
 * @param {number} position.openedAtMs - Epoch ms when position was opened
 * @param {number} currentPrice - Latest observed price (must be > 0 and finite)
 * @param {number} nowMs - Current epoch ms
 * @param {Object} [customConfig] - Optional override config
 * @returns {{ action: 'SELL'|'HOLD'|'WAIT', reason: string, updatedPosition: Object, detail: Object }}
 */
export function evaluateExit(position, currentPrice, nowMs = Date.now(), customConfig = {}) {
  const config = { ...DEFAULT_CONFIG, ...customConfig };

  // Data Quality Guard: Unknown is never zero
  if (
    currentPrice === null ||
    currentPrice === undefined ||
    typeof currentPrice !== 'number' ||
    Number.isNaN(currentPrice) ||
    !Number.isFinite(currentPrice) ||
    currentPrice <= 0
  ) {
    return {
      action: 'WAIT',
      reason: 'unknown_price',
      updatedPosition: { ...position },
      detail: {
        message: 'Invalid, zero, or missing price; preserving state without triggering exit',
        receivedPrice: currentPrice
      }
    };
  }

  // Validate entry price
  if (
    !position ||
    typeof position.entryPrice !== 'number' ||
    Number.isNaN(position.entryPrice) ||
    position.entryPrice <= 0
  ) {
    return {
      action: 'WAIT',
      reason: 'invalid_entry_price',
      updatedPosition: { ...position },
      detail: {
        message: 'Position missing valid positive entryPrice',
        entryPrice: position ? position.entryPrice : undefined
      }
    };
  }

  const openedAtMs = (typeof position.openedAtMs === 'number') ? position.openedAtMs : nowMs;
  const ageMs = Math.max(0, nowMs - openedAtMs);
  const ageMin = ageMs / 60_000;

  // Track high-water mark (peak price)
  const previousPeak = position.peakPrice || position.entryPrice;
  const peakPrice = Math.max(previousPeak, currentPrice);

  // Arming check: once armed, stays armed
  const armed = Boolean(
    position.armed ||
    (peakPrice >= position.entryPrice * config.trailArmX)
  );

  const multiple = currentPrice / position.entryPrice;
  const peakMultiple = peakPrice / position.entryPrice;
  const trailStopPrice = peakPrice * (1 - config.trailPct / 100);

  // Rule 3: Max Hold Time Stop (Absolute backstop)
  if (ageMin >= config.maxHoldMin) {
    return {
      action: 'SELL',
      reason: 'time_stop_max',
      updatedPosition: {
        ...position,
        peakPrice,
        armed,
        lastPrice: currentPrice,
        lastMultiple: multiple,
        lastCheckMs: nowMs
      },
      detail: {
        currentPrice,
        entryPrice: position.entryPrice,
        multiple,
        ageMin,
        maxHoldMin: config.maxHoldMin,
        message: `Position age (${ageMin.toFixed(1)}m) exceeded max hold limit (${config.maxHoldMin}m)`
      }
    };
  }

  // Rule 1: Trailing Stop from Peak (when armed)
  let nextBreachCount = position.breachCount || 0;
  if (armed) {
    if (currentPrice <= trailStopPrice) {
      nextBreachCount += 1;
      if (nextBreachCount >= config.trailConfirm) {
        return {
          action: 'SELL',
          reason: 'trailing_stop',
          updatedPosition: {
            ...position,
            peakPrice,
            armed,
            breachCount: nextBreachCount,
            lastPrice: currentPrice,
            lastMultiple: multiple,
            lastCheckMs: nowMs
          },
          detail: {
            currentPrice,
            peakPrice,
            entryPrice: position.entryPrice,
            trailStopPrice,
            multiple,
            peakMultiple,
            drawdownPct: ((peakPrice - currentPrice) / peakPrice) * 100,
            breachCount: nextBreachCount,
            trailConfirm: config.trailConfirm,
            message: `Trailing stop triggered: price ${currentPrice} <= stop ${trailStopPrice} for ${nextBreachCount} checks`
          }
        };
      } else {
        // First breach or confirming, not yet reached confirmation threshold
        return {
          action: 'WAIT',
          reason: 'confirming_trailing_stop',
          updatedPosition: {
            ...position,
            peakPrice,
            armed,
            breachCount: nextBreachCount,
            lastPrice: currentPrice,
            lastMultiple: multiple,
            lastCheckMs: nowMs
          },
          detail: {
            currentPrice,
            peakPrice,
            trailStopPrice,
            breachCount: nextBreachCount,
            trailConfirm: config.trailConfirm,
            message: `Breach detected (${nextBreachCount}/${config.trailConfirm}); confirming on next check`
          }
        };
      }
    } else {
      // Price is above trailing stop line; reset breach count
      nextBreachCount = 0;
    }
  }

  // Rule 2: Unarmed Time Stop
  if (!armed && ageMin >= config.unarmedTimeStopMin) {
    return {
      action: 'SELL',
      reason: 'time_stop_unarmed',
      updatedPosition: {
        ...position,
        peakPrice,
        armed,
        breachCount: 0,
        lastPrice: currentPrice,
        lastMultiple: multiple,
        lastCheckMs: nowMs
      },
      detail: {
        currentPrice,
        entryPrice: position.entryPrice,
        multiple,
        peakMultiple,
        ageMin,
        unarmedTimeStopMin: config.unarmedTimeStopMin,
        armThresholdX: config.trailArmX,
        message: `Unarmed timeout: position aged ${ageMin.toFixed(1)}m without reaching ${config.trailArmX}x arm threshold`
      }
    };
  }

  // Normal HOLD state
  return {
    action: 'HOLD',
    reason: armed ? 'trailing_active' : 'monitoring',
    updatedPosition: {
      ...position,
      peakPrice,
      armed,
      breachCount: nextBreachCount,
      lastPrice: currentPrice,
      lastMultiple: multiple,
      lastCheckMs: nowMs
    },
    detail: {
      currentPrice,
      peakPrice,
      entryPrice: position.entryPrice,
      multiple,
      peakMultiple,
      armed,
      trailStopPrice: armed ? trailStopPrice : null,
      breachCount: nextBreachCount,
      ageMin
    }
  };
}

/**
 * Calculates current display metrics for a position.
 */
export function calculatePositionMetrics(position, currentPrice = null, config = DEFAULT_CONFIG) {
  const price = (typeof currentPrice === 'number' && currentPrice > 0)
    ? currentPrice
    : position.lastPrice || position.entryPrice;

  const multiple = price / position.entryPrice;
  const peak = Math.max(position.peakPrice || position.entryPrice, price);
  const peakMultiple = peak / position.entryPrice;
  const armed = Boolean(position.armed || (peak >= position.entryPrice * config.trailArmX));
  const trailStopPrice = peak * (1 - config.trailPct / 100);
  const trailStopMultiple = trailStopPrice / position.entryPrice;

  return {
    currentPrice: price,
    entryPrice: position.entryPrice,
    peakPrice: peak,
    multiple,
    peakMultiple,
    armed,
    trailStopPrice,
    trailStopMultiple,
    pnlPct: (multiple - 1) * 100
  };
}
