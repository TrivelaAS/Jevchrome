import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExit, DEFAULT_CONFIG, calculatePositionMetrics } from '../engine/exit_rules.js';

test('Data Quality Guard: Unknown is never zero', () => {
  const basePosition = {
    id: 'pos-1',
    mint: 'TestMint11111111111111111111111111111111111',
    entryPrice: 100,
    peakPrice: 100,
    armed: false,
    breachCount: 0,
    openedAtMs: 1_000_000
  };

  const invalidPrices = [null, undefined, NaN, 0, -10, 'invalid', Infinity, -Infinity];

  for (const price of invalidPrices) {
    const res = evaluateExit(basePosition, price, 1_000_000);
    assert.equal(res.action, 'WAIT', `Price ${price} should yield WAIT`);
    assert.equal(res.reason, 'unknown_price');
    assert.equal(res.updatedPosition.breachCount, 0, 'Should not increment breach count on invalid price');
    assert.equal(res.updatedPosition.peakPrice, 100, 'Should not modify peak price');
  }
});

test('Arming threshold: arms at 1.3x entry by default and stays armed', () => {
  const position = {
    id: 'pos-2',
    entryPrice: 1.0,
    peakPrice: 1.0,
    armed: false,
    breachCount: 0,
    openedAtMs: 0
  };

  // 1.2x -> not armed
  const t1 = evaluateExit(position, 1.2, 60_000);
  assert.equal(t1.action, 'HOLD');
  assert.equal(t1.updatedPosition.armed, false);
  assert.equal(t1.updatedPosition.peakPrice, 1.2);

  // 1.3x -> armed
  const t2 = evaluateExit(t1.updatedPosition, 1.3, 120_000);
  assert.equal(t2.action, 'HOLD');
  assert.equal(t2.updatedPosition.armed, true);
  assert.equal(t2.updatedPosition.peakPrice, 1.3);

  // Price pulls back to 1.1x -> remains armed!
  const t3 = evaluateExit(t2.updatedPosition, 1.1, 180_000);
  assert.equal(t3.updatedPosition.armed, true, 'Position should stay armed once threshold reached');
});

test('Trailing stop: triggers after confirmed consecutive checks below high-water mark', () => {
  let pos = {
    id: 'pos-3',
    entryPrice: 10,
    peakPrice: 10,
    armed: false,
    breachCount: 0,
    openedAtMs: 0
  };

  // Price pumps to 20 (2.0x entry) -> peak = 20, trailStop = 15 (-25%)
  const r1 = evaluateExit(pos, 20, 60_000);
  assert.equal(r1.action, 'HOLD');
  assert.equal(r1.updatedPosition.armed, true);
  assert.equal(r1.updatedPosition.peakPrice, 20);
  pos = r1.updatedPosition;

  // Price pulls back to 14.5 (below 15.0 stop). Check 1 of 2 -> WAIT confirming
  const r2 = evaluateExit(pos, 14.5, 70_000);
  assert.equal(r2.action, 'WAIT');
  assert.equal(r2.reason, 'confirming_trailing_stop');
  assert.equal(r2.updatedPosition.breachCount, 1);
  pos = r2.updatedPosition;

  // Price remains at 14.2 on check 2 of 2 -> SELL trailing_stop
  const r3 = evaluateExit(pos, 14.2, 80_000);
  assert.equal(r3.action, 'SELL');
  assert.equal(r3.reason, 'trailing_stop');
  assert.equal(r3.updatedPosition.breachCount, 2);
  assert.equal(r3.detail.peakPrice, 20);
  assert.equal(r3.detail.trailStopPrice, 15);
});

test('Trailing stop: resets breach count if price bounces back above stop line', () => {
  let pos = {
    id: 'pos-4',
    entryPrice: 10,
    peakPrice: 20, // peak is 20, stop is 15
    armed: true,
    breachCount: 0,
    openedAtMs: 0
  };

  // Check 1: 14.8 (breach 1)
  const r1 = evaluateExit(pos, 14.8, 10_000);
  assert.equal(r1.action, 'WAIT');
  assert.equal(r1.updatedPosition.breachCount, 1);
  pos = r1.updatedPosition;

  // Check 2: bounces back to 16.0 (above 15.0 stop line) -> resets breach count to 0!
  const r2 = evaluateExit(pos, 16.0, 20_000);
  assert.equal(r2.action, 'HOLD');
  assert.equal(r2.updatedPosition.breachCount, 0, 'Breach count must reset when price recovers');
  pos = r2.updatedPosition;

  // Check 3: drops again to 14.7 -> starts at breach 1 again, does not sell prematurely
  const r3 = evaluateExit(pos, 14.7, 30_000);
  assert.equal(r3.action, 'WAIT');
  assert.equal(r3.updatedPosition.breachCount, 1);
});

test('Unarmed Time Stop: closes stagnant positions after 60 min if peak < 1.3x', () => {
  const openedAt = 0;
  const pos = {
    id: 'pos-5',
    entryPrice: 1.0,
    peakPrice: 1.1,
    armed: false,
    breachCount: 0,
    openedAtMs: openedAt
  };

  // At 59 minutes: still holding
  const t59m = 59 * 60_000;
  const r1 = evaluateExit(pos, 1.05, t59m);
  assert.equal(r1.action, 'HOLD');

  // At 60 minutes: auto-sell under unarmed time stop
  const t60m = 60 * 60_000;
  const r2 = evaluateExit(pos, 1.05, t60m);
  assert.equal(r2.action, 'SELL');
  assert.equal(r2.reason, 'time_stop_unarmed');
});

test('Armed position does NOT trigger unarmed time stop at 60 minutes', () => {
  const openedAt = 0;
  const pos = {
    id: 'pos-6',
    entryPrice: 1.0,
    peakPrice: 1.4, // armed at 1.4x!
    armed: true,
    breachCount: 0,
    openedAtMs: openedAt
  };

  // At 65 minutes with price 1.20 (above stop 1.4 * 0.75 = 1.05): should HOLD
  const t65m = 65 * 60_000;
  const r = evaluateExit(pos, 1.20, t65m);
  assert.equal(r.action, 'HOLD');
  assert.equal(r.reason, 'trailing_active');
});

test('Max Hold Time Stop: hard exit after 240 minutes regardless of armed status', () => {
  const openedAt = 0;
  const pos = {
    id: 'pos-7',
    entryPrice: 1.0,
    peakPrice: 3.0,
    armed: true,
    breachCount: 0,
    openedAtMs: openedAt
  };

  // At 240 minutes: hard time stop
  const t240m = 240 * 60_000;
  const r = evaluateExit(pos, 2.8, t240m);
  assert.equal(r.action, 'SELL');
  assert.equal(r.reason, 'time_stop_max');
});

test('calculatePositionMetrics returns correct multiples and stops', () => {
  const pos = {
    entryPrice: 50,
    peakPrice: 100,
    armed: true,
    lastPrice: 80
  };

  const metrics = calculatePositionMetrics(pos, 80);
  assert.equal(metrics.multiple, 1.6);
  assert.equal(metrics.peakMultiple, 2.0);
  assert.equal(metrics.trailStopPrice, 75); // 100 * 0.75
  assert.equal(metrics.trailStopMultiple, 1.5);
  assert.equal(metrics.armed, true);
});

test('Custom config overrides are respected', () => {
  const customConfig = {
    trailArmX: 1.5,
    trailPct: 10,
    trailConfirm: 1,
    unarmedTimeStopMin: 30,
    maxHoldMin: 120
  };

  const pos = {
    id: 'pos-custom',
    entryPrice: 100,
    peakPrice: 140, // 1.4x (not armed because custom trailArmX is 1.5)
    armed: false,
    breachCount: 0,
    openedAtMs: 0
  };

  // At 1.4x: not armed under custom 1.5x
  const r1 = evaluateExit(pos, 140, 10_000, customConfig);
  assert.equal(r1.updatedPosition.armed, false);

  // At 1.55x: armed! Peak is 155, trailStop is 155 * 0.9 = 139.5 (-10%)
  const r2 = evaluateExit(r1.updatedPosition, 155, 20_000, customConfig);
  assert.equal(r2.updatedPosition.armed, true);

  // Price drops to 135 (below 139.5) with trailConfirm=1 -> instant SELL on check 1
  const r3 = evaluateExit(r2.updatedPosition, 135, 30_000, customConfig);
  assert.equal(r3.action, 'SELL');
  assert.equal(r3.reason, 'trailing_stop');
});

test('Full pump.fun trade lifecycle simulation', () => {
  // Scenario: Hans buys a fresh coin on pump.fun at $10k mcap
  let pos = {
    id: 'pump-test-1',
    mint: 'CzLSujWBLFsSjncfkh59rQD4ETecfgzW55471BQ4pump',
    symbol: 'JEVCOIN',
    entryPrice: 10000,
    peakPrice: 10000,
    armed: false,
    breachCount: 0,
    openedAtMs: 1_000_000
  };

  const priceHistory = [
    { t: 1_010_000, price: 11000, expectedAction: 'HOLD', expectedArmed: false },
    { t: 1_020_000, price: 12500, expectedAction: 'HOLD', expectedArmed: false },
    { t: 1_030_000, price: 13500, expectedAction: 'HOLD', expectedArmed: true }, // Arms! (1.35x >= 1.30x)
    { t: 1_040_000, price: 18000, expectedAction: 'HOLD', expectedArmed: true }, // Peak = 18k, stop = 13.5k
    { t: 1_050_000, price: 20000, expectedAction: 'HOLD', expectedArmed: true }, // Peak = 20k, stop = 15k (-25%)
    { t: 1_060_000, price: 17000, expectedAction: 'HOLD', expectedArmed: true }, // Above 15k
    { t: 1_070_000, price: 14800, expectedAction: 'WAIT', expectedArmed: true }, // Breach 1 of 2 (below 15k)
    { t: 1_080_000, price: 14200, expectedAction: 'SELL', expectedArmed: true }  // Breach 2 of 2 -> Auto-sell triggered!
  ];

  for (const step of priceHistory) {
    const res = evaluateExit(pos, step.price, step.t);
    assert.equal(res.action, step.expectedAction);
    assert.equal(res.updatedPosition.armed, step.expectedArmed);
    pos = res.updatedPosition;
  }

  assert.equal(pos.breachCount, 2);
  assert.equal(pos.peakPrice, 20000);
});

