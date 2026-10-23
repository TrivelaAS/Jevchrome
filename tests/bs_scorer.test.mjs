/**
 * Test Suite for bullshtt.ai (Jevchrome) BS Scorer & Proxy
 *
 * Runs via: node --test tests/bs_scorer.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  JEV_MODEL,
  QUESTION_VERSION,
  POLICY_VERSION,
  BRAND_DOMAIN,
  ALWAYS_REVIEW_LABELS,
  SIGNAL_LABELS,
  VERDICT_LABELS,
  computePostHash,
  buildJevBatchRequest,
  validateJevResponse,
  formatAutoAnswer,
  scoreBatchFromJev,
  isCacheEntryFresh
} from "../engine/bs_scorer.js";
import { getTypesafeApiKey, callJevBatch, createProxyServer } from "../server/proxy.mjs";

const SAMPLE_POST = {
  id: "techluisenzo_001",
  author: "Luis Enzo",
  handle: "@techluisenzo",
  text: `I generated $7625 overnight using an automated Claude setup.

I’ve documented the exact, step-by-step process behind this timezone arbitrage strategy.

What you need👇
• Claude
• A Mobile
• 24 hours to test it ( no cost )

How to access the guide👇
1. Comment “ SetUp ”
2. Like & RT
3. Follow @techluisenzo  (so I can send it via DM)

The system runs continuously, scanning global news across Japanese, European, Australian, and Middle Eastern markets.

It identifies pricing inefficiencies situations where outcomes are already reflected overseas, but U.S. markets have yet to adjust.

After 9 days of running this setup, the results have been consistent and eye opening.

Most traders focus on EST. Markets don’t.

While one region sleeps, another resolves events in real time.

That timing gap is the opportunity.

Follow @techluisenzo  to receive the full breakdown.

( First 1500 people will get it! Like, comment, and follow quickly )`,
  metrics: {
    views: 28554,
    likes: 427,
    retweets: 181,
    replies: 336
  }
};

function createMockJevResponse(overrides = {}) {
  return {
    model: "jev-1.14.0",
    answers: {
      p0_implausible_claim: { type: "noul", noul: 0.96 },
      p0_incoherent_mechanism: { type: "noul", noul: 0.94 },
      p0_zero_verifiable_evidence: { type: "noul", noul: 0.96 },
      p0_engagement_farming_gate: { type: "noul", noul: 0.93 },
      p0_manufactured_rage_bait: { type: "noul", noul: 0.12 },
      p0_bullshit_tier: {
        type: "score",
        score: 3.9,
        confidence: 0.92,
        probabilities: { "0": 0, "1": 0, "2": 0.02, "3": 0.06, "4": 0.92 }
      },
      p0_primary_intent: {
        type: "choice",
        choice: "engagement_bait_slop",
        confidence: 0.95,
        probabilities: {
          genuine_insight: 0.0,
          news_reporting: 0.0,
          engagement_bait_slop: 0.92,
          rage_bait: 0.0,
          hustle_grift: 0.08,
          satire: 0.0,
          other: 0.0
        }
      },
      ...overrides
    }
  };
}

test("computePostHash produces deterministic 16-hex hash with case-normalization", () => {
  const hash1 = computePostHash(SAMPLE_POST);
  const hash2 = computePostHash({
    ...SAMPLE_POST,
    handle: "  @TECHLUISENZO  "
  });
  assert.equal(typeof hash1, "string");
  assert.equal(hash1.length, 16);
  assert.match(hash1, /^[0-9a-f]{16}$/);
  assert.equal(hash1, hash2, "Hashes should match when handle casing and whitespace differ");

  const diffHash = computePostHash({
    ...SAMPLE_POST,
    text: "Completely different text here"
  });
  assert.notEqual(hash1, diffHash, "Different text should produce different hash");
});

test("buildJevBatchRequest builds valid Jev payload with explicit record identifiers", () => {
  const req = buildJevBatchRequest([SAMPLE_POST]);
  assert.equal(req.model, JEV_MODEL);
  assert.ok(req.state.posts.p0);
  assert.equal(req.state.posts.p0.id, "techluisenzo_001");

  const qKeys = Object.keys(req.questions);
  assert.equal(qKeys.length, 7, "Must contain all 7 narrow diagnostic questions");

  for (const key of qKeys) {
    const q = req.questions[key];
    assert.match(q.instructions, /`posts\.p0\.text`/, `Question ${key} must reference backticked posts.p0.text`);
    assert.match(q.instructions, /techluisenzo/, `Question ${key} must explicitly reference post record id`);
  }

  // Bullshit tier has 5 concrete levels
  assert.equal(req.questions.p0_bullshit_tier.type, "score");
  assert.equal(req.questions.p0_bullshit_tier.criteria.length, 5);

  // Primary intent has 7 uniform criteria with what and not_for
  assert.equal(req.questions.p0_primary_intent.type, "choice");
  const candidates = Object.keys(req.questions.p0_primary_intent.criteria);
  assert.deepEqual(candidates, [
    "genuine_insight",
    "news_reporting",
    "engagement_bait_slop",
    "rage_bait",
    "hustle_grift",
    "satire",
    "other"
  ]);
  for (const cand of candidates) {
    const crit = req.questions.p0_primary_intent.criteria[cand];
    assert.ok(crit.what, `Candidate ${cand} must define 'what'`);
    assert.ok(crit.not_for, `Candidate ${cand} must define 'not_for'`);
  }
});

test("validateJevResponse accepts conforming response and rejects invalid shapes", () => {
  const req = buildJevBatchRequest([SAMPLE_POST]);
  const validResp = createMockJevResponse();

  // Valid response passes
  assert.equal(validateJevResponse(req, validResp), true);

  // Missing model
  assert.throws(() => {
    validateJevResponse(req, { ...validResp, model: "" });
  }, /missing or empty 'model'/i);

  // Missing answer
  assert.throws(() => {
    const badResp = createMockJevResponse();
    delete badResp.answers.p0_implausible_claim;
    validateJevResponse(req, badResp);
  }, /missing answer object/i);

  // Noul out of range
  assert.throws(() => {
    const badResp = createMockJevResponse({
      p0_implausible_claim: { type: "noul", noul: 1.5 }
    });
    validateJevResponse(req, badResp);
  }, /must be a number in \[0, 1\]/i);

  // Choice probabilities not summing to 1.0 ± 0.05
  assert.throws(() => {
    const badResp = createMockJevResponse({
      p0_primary_intent: {
        type: "choice",
        choice: "engagement_bait_slop",
        confidence: 0.95,
        probabilities: {
          genuine_insight: 0.5,
          news_reporting: 0.5,
          engagement_bait_slop: 0.9,
          rage_bait: 0.0,
          hustle_grift: 0.0,
          satire: 0.0,
          other: 0.0
        }
      }
    });
    validateJevResponse(req, badResp);
  }, /probabilities sum to/i);

  // Choice is not argmax of probabilities
  assert.throws(() => {
    const badResp = createMockJevResponse({
      p0_primary_intent: {
        type: "choice",
        choice: "satire", // Picked satire when engagement_bait_slop has 0.92
        confidence: 0.95,
        probabilities: {
          genuine_insight: 0.0,
          news_reporting: 0.0,
          engagement_bait_slop: 0.92,
          rage_bait: 0.0,
          hustle_grift: 0.08,
          satire: 0.0,
          other: 0.0
        }
      }
    });
    validateJevResponse(req, badResp);
  }, /is not argmax of probabilities/i);
});

test("scoreBatchFromJev computes accurate composite scores and checks satire damping", () => {
  const posts = [SAMPLE_POST];
  const req = buildJevBatchRequest(posts);
  const resp = createMockJevResponse();

  const results = scoreBatchFromJev(posts, req, resp);
  assert.equal(results.length, 1);
  const res = results[0];

  assert.equal(res.id, "techluisenzo_001");
  assert.equal(res.handle, "@techluisenzo");
  // Expected score for @techluisenzo mock is 95%
  assert.equal(res.stinkinessPct, 95);
  assert.equal(res.primaryIntent, "engagement_bait_slop");
  assert.equal(res.verdictLabel, "Engagement-Bait Slop");
  assert.equal(res.isSatire, false);
  assert.equal(res.uncertain, false);
  assert.equal(res.questionVersion, QUESTION_VERSION);
  assert.equal(res.policyVersion, POLICY_VERSION);
  assert.equal(res.model, "jev-1.14.0");

  // Verify Satire Damping Policy
  const satireResp = createMockJevResponse({
    p0_primary_intent: {
      type: "choice",
      choice: "satire",
      confidence: 0.96,
      probabilities: {
        genuine_insight: 0.0,
        news_reporting: 0.0,
        engagement_bait_slop: 0.05,
        rage_bait: 0.0,
        hustle_grift: 0.0,
        satire: 0.95,
        other: 0.0
      }
    }
  });

  const satireResults = scoreBatchFromJev(posts, req, satireResp);
  const satireRes = satireResults[0];
  assert.equal(satireRes.isSatire, true);
  assert.equal(satireRes.verdictLabel, "Satire / Parody");
  // Score damped by 0.35 factor: 95 * 0.35 ≈ 33%
  assert.ok(satireRes.stinkinessPct <= 35, `Satire score should be damped <= 35, got ${satireRes.stinkinessPct}`);
});

test("formatAutoAnswer formats full and compact replies with required signature and < 280 chars", () => {
  const scoredResult95 = {
    handle: "@techluisenzo",
    stinkinessPct: 95,
    verdictLabel: "Engagement-Bait Slop",
    signals: {
      implausible_claim: 0.96,
      zero_verifiable_evidence: 0.96,
      incoherent_mechanism: 0.94,
      engagement_farming_gate: 0.93,
      manufactured_rage_bait: 0.12
    }
  };

  const full95 = formatAutoAnswer(scoredResult95, { style: "full" });
  assert.ok(
    full95.includes("rated 95% on stinkiness by bullshtt.ai"),
    "Full reply must contain exact signature tagline: rated 95% on stinkiness by bullshtt.ai"
  );
  assert.ok(full95.includes("• 96% Implausible claim"));
  assert.ok(full95.includes("• 96% Zero verifiable proof"));
  assert.ok(full95.includes("Verdict: Engagement-Bait Slop"));
  assert.ok(full95.length < 280, `Full answer length must be < 280 chars, got ${full95.length}`);

  const compact95 = formatAutoAnswer(scoredResult95, { style: "compact" });
  assert.ok(
    compact95.includes("rated 95% on stinkiness by bullshtt.ai"),
    "Compact reply must contain signature"
  );
  assert.ok(compact95.length < 280);

  // Test 89% score signature
  const scoredResult89 = {
    handle: "@rage_account",
    stinkinessPct: 89,
    verdictLabel: "Rage Bait",
    signals: {
      manufactured_rage_bait: 0.95,
      implausible_claim: 0.85,
      zero_verifiable_evidence: 0.82,
      incoherent_mechanism: 0.70,
      engagement_farming_gate: 0.10
    }
  };

  const full89 = formatAutoAnswer(scoredResult89, { style: "full" });
  assert.ok(
    full89.includes("rated 89% on stinkiness by bullshtt.ai"),
    "Full reply must contain exact signature tagline: rated 89% on stinkiness by bullshtt.ai"
  );
  assert.ok(full89.length < 280, `Full answer length must be < 280 chars, got ${full89.length}`);
});

test("isCacheEntryFresh verifies entry freshness, versions, and expiration", () => {
  const hash = computePostHash(SAMPLE_POST);
  const validEntry = {
    postHash: hash,
    questionVersion: QUESTION_VERSION,
    policyVersion: POLICY_VERSION,
    stinkinessPct: 95,
    model: "jev-1.14.0",
    evaluatedAt: new Date().toISOString()
  };

  assert.equal(isCacheEntryFresh(validEntry, hash), true);

  // Hash mismatch
  assert.equal(isCacheEntryFresh(validEntry, "other_hash_1234"), false);

  // Version mismatch
  assert.equal(
    isCacheEntryFresh({ ...validEntry, questionVersion: "old-version" }, hash),
    false
  );
  assert.equal(
    isCacheEntryFresh({ ...validEntry, policyVersion: "old-policy" }, hash),
    false
  );

  // Non-Jev model
  assert.equal(
    isCacheEntryFresh({ ...validEntry, model: "gpt-4o" }, hash),
    false
  );

  // Expired entry (older than 7 days)
  const expiredDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(
    isCacheEntryFresh({ ...validEntry, evaluatedAt: expiredDate }, hash),
    false
  );
});

test("Live integration test against TypeSafe Jev API (jev-1.14.0) with @techluisenzo post", async () => {
  let apiKey;
  try {
    apiKey = getTypesafeApiKey();
  } catch (err) {
    console.warn("Skipping live integration test: TYPESAFE_API_KEY unavailable.");
    return;
  }

  const posts = [SAMPLE_POST];
  const req = buildJevBatchRequest(posts, JEV_MODEL);

  const startTime = Date.now();
  const jevResponse = await callJevBatch(req, apiKey);
  const elapsed = Date.now() - startTime;

  console.log(`[Integration Test] Live Jev response received in ${elapsed}ms: model=${jevResponse.model}`);

  // Invariant 1: responseData.model === "jev-1.14.0"
  assert.equal(jevResponse.model, "jev-1.14.0", `Expected model to be jev-1.14.0, got ${jevResponse.model}`);

  // Score the batch
  const results = scoreBatchFromJev(posts, req, jevResponse);
  assert.equal(results.length, 1);
  const scored = results[0];

  console.log(`[Integration Test] Stinkiness score: ${scored.stinkinessPct}%, Verdict: ${scored.verdictLabel}`);
  console.log(`[Integration Test] Auto-answer reply text:\n${scored.autoAnswerText}`);

  // Invariant 2: stinkinessPct >= 85
  assert.ok(
    scored.stinkinessPct >= 85,
    `Expected @techluisenzo post to score stinkinessPct >= 85, got ${scored.stinkinessPct}`
  );

  // Invariant 3: autoAnswerText contains "on stinkiness by bullshtt.ai"
  assert.ok(
    scored.autoAnswerText.includes("on stinkiness by bullshtt.ai"),
    "Auto-answer text must contain 'on stinkiness by bullshtt.ai'"
  );

  // Invariant 4: length strictly < 280
  assert.ok(
    scored.autoAnswerText.length < 280,
    `Auto-answer text length must be < 280, got ${scored.autoAnswerText.length}`
  );
});

test("Proxy server endpoints: CORS, GET /api/health, and POST /api/score caching", async () => {
  let apiKey;
  try {
    apiKey = getTypesafeApiKey();
  } catch (err) {
    console.warn("Skipping proxy server test: TYPESAFE_API_KEY unavailable.");
    return;
  }

  const testPort = 18787;
  const proxy = createProxyServer(testPort);
  await proxy.start();

  try {
    // 1. OPTIONS Preflight CORS check
    const optRes = await fetch(`http://localhost:${testPort}/api/score`, {
      method: "OPTIONS"
    });
    assert.equal(optRes.status, 204);
    assert.equal(optRes.headers.get("access-control-allow-origin"), "*");
    assert.ok(optRes.headers.get("access-control-allow-methods").includes("POST"));

    // 2. GET /api/health
    const healthRes = await fetch(`http://localhost:${testPort}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthData = await healthRes.json();
    assert.equal(healthData.status, "ok");
    assert.equal(healthData.brand, BRAND_DOMAIN);
    assert.equal(healthData.model, JEV_MODEL);

    // 3. POST /api/score (live call + cache write with unique nonce)
    const noncePost = {
      ...SAMPLE_POST,
      id: "proxy_nonce_" + Date.now(),
      text: SAMPLE_POST.text + "\nNonce: " + Math.random()
    };

    const scoreRes1 = await fetch(`http://localhost:${testPort}/api/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ posts: [noncePost] })
    });
    assert.equal(scoreRes1.status, 200);
    const data1 = await scoreRes1.json();
    assert.equal(data1.model, "jev-1.14.0");
    assert.equal(data1.results.length, 1);
    assert.ok(data1.results[0].stinkinessPct >= 85);
    assert.equal(data1.results[0].fromCache, false);

    // 4. POST /api/score second call (immediate cache hit)
    const scoreRes2 = await fetch(`http://localhost:${testPort}/api/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ posts: [noncePost] })
    });
    assert.equal(scoreRes2.status, 200);
    const data2 = await scoreRes2.json();
    assert.equal(data2.results.length, 1);
    assert.equal(data2.results[0].fromCache, true);
    assert.equal(data2.results[0].postHash, data1.results[0].postHash);
  } finally {
    await proxy.stop();
  }
});

