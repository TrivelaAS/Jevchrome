/**
 * bullshtt.ai (Jevchrome) - Core Jev Scoring Engine
 *
 * Evaluates social posts (X/Twitter, etc.) for bullshit, engagement-farming bait,
 * rage-bait, and financial grift using TypeSafe System One (Jev).
 *
 * Implements calibrated typed semantic judgment with deterministic code policy.
 */

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-1.14.0";
export const QUESTION_VERSION = "bullshtt-q-v1.0";
export const POLICY_VERSION = "bullshtt-policy-v1.0";
export const BRAND_DOMAIN = "bullshtt.ai";

export const ALWAYS_REVIEW_LABELS = new Set([
  "other",
  "unknown",
  "abstain",
  "review",
  "none",
  "insufficient_evidence"
]);

export const SIGNAL_LABELS = {
  implausible_claim: "Implausible claim",
  zero_verifiable_evidence: "Zero verifiable proof",
  incoherent_mechanism: "Incoherent mechanism",
  engagement_farming_gate: "Engagement-bait DM gate",
  manufactured_rage_bait: "Manufactured rage bait"
};

export const VERDICT_LABELS = {
  genuine_insight: "Genuine Insight",
  news_reporting: "News Reporting",
  engagement_bait_slop: "Engagement-Bait Slop",
  rage_bait: "Rage Bait",
  hustle_grift: "Hustle Grift",
  satire: "Satire / Parody",
  other: "Unclassified"
};

export const BULLSHIT_TIER_CRITERIA = [
  "Level 0 - Grounded and credible: specific, verifiable technical details or facts, realistic caveats, honest reporting, and no engagement gatekeeping.",
  "Level 1 - Mildly promotional: mostly factual content with mild marketing framing or optimistic benchmarks, but no outright deception.",
  "Level 2 - Noticeable hype: buzzword-heavy framing, selective claims, or mild engagement prompts with limited substantiation.",
  "Level 3 - Aggressive bait or grift: implausible passive-income or miracle claims, engagement-farming DM funnels, or deliberate rage provocation.",
  "Level 4 - Pure fabricated scam, rage-bait, or total bullshit: completely impossible financial or technical claims, egregious outrage farming, or deceptive grift designed solely to harvest engagement or lure victims."
];

export const PRIMARY_INTENT_CRITERIA = {
  genuine_insight: {
    what: "Sharing real, verifiable engineering, data, educational analysis, or honest discussion",
    not_for: "Engagement bait, sales funnels, unverified windfall claims, or promotional hype"
  },
  news_reporting: {
    what: "Factual reporting or commentary with cited context or verifiable news events",
    not_for: "Fabricated sensationalism, rage-farming bait, or marketing funnels"
  },
  engagement_bait_slop: {
    what: "Engagement-farming hustle-bro bait or DM-gate funnel using exaggerated claims to farm followers/replies",
    not_for: "Legitimate free open-source releases with direct public links"
  },
  rage_bait: {
    what: "Inflammatory provocation, strawman framing, tribal provocation, or outrage farming designed to make readers angry enough to reply",
    not_for: "Calm, nuanced disagreement or measured factual criticism"
  },
  hustle_grift: {
    what: "Promoting a deceptive get-rich-quick scheme, fake arbitrage, crypto pump, or financial grift",
    not_for: "Standard transparent commercial product announcements"
  },
  satire: {
    what: "Intentional humor, parody, sarcasm, or obvious joke/shitpost not meant to be taken literally",
    not_for: "Earnest deception or genuine scams pretending to be serious"
  },
  other: {
    what: "None of the above categories fit the post",
    not_for: "Posts that clearly belong in one of the specific categories above"
  }
};

/**
 * Computes a deterministic post hash that works identically in Node.js,
 * browser window, and Chrome extension service workers.
 *
 * @param {object} post - { id, author, handle, text }
 * @returns {string} 16-character hex hash string
 */
export function computePostHash(post) {
  const author = (post && (post.handle || post.author || "")).trim().toLowerCase();
  const text = (post && post.text ? String(post.text) : "").trim();
  const input = `${author}|${text}`;

  // Deterministic 64-bit FNV-1a hash formatted as 16-hex characters
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ (code & 0xff), 0x01000193);
    h2 = Math.imul(h2 ^ ((code >> 8) | ((code & 0xff) << 8)), 0x5bd1e995);
  }
  const hex1 = (h1 >>> 0).toString(16).padStart(8, "0");
  const hex2 = (h2 >>> 0).toString(16).padStart(8, "0");
  return `${hex1}${hex2}`;
}

/**
 * Builds one batched Jev request for an array of posts.
 * Names both the backticked path (`posts.p0.text`) AND the record identifier
 * inside every question's instructions per Jev Best Practice #4.
 *
 * @param {Array<object>} posts - Array of { id, author, handle, text, metrics }
 * @param {string} model - Defaults to JEV_MODEL ("jev-1.14.0")
 * @returns {object} Jev request payload { model, state: { posts }, questions }
 */
export function buildJevBatchRequest(posts, model = JEV_MODEL) {
  if (!Array.isArray(posts) || posts.length === 0) {
    throw new Error("buildJevBatchRequest requires a non-empty array of posts");
  }

  const statePosts = {};
  const questions = {};

  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    const k = `p${i}`;
    const recordId = p.id || p.handle || p.author || `post-${i}`;

    statePosts[k] = {
      id: p.id || `post-${i}`,
      author: p.author || "",
      handle: p.handle || p.author || "",
      text: p.text || "",
      metrics: p.metrics || null
    };

    questions[`${k}_implausible_claim`] = {
      type: "noul",
      instructions: `Does \`posts.${k}.text\` (post "${recordId}") claim an extraordinary financial, statistical, or factual windfall or outcome without primary verifiable proof?`
    };

    questions[`${k}_incoherent_mechanism`] = {
      type: "noul",
      instructions: `Is the claimed mechanism, causal explanation, or technical workflow in \`posts.${k}.text\` (post "${recordId}") economically, technically, or logically incoherent or buzzword salad?`
    };

    questions[`${k}_zero_verifiable_evidence`] = {
      type: "noul",
      instructions: `Does \`posts.${k}.text\` (post "${recordId}") fail to provide concrete, verifiable evidence, primary sources, reproducible code, or auditable data in the post itself?`
    };

    questions[`${k}_engagement_farming_gate`] = {
      type: "noul",
      instructions: `Does \`posts.${k}.text\` (post "${recordId}") withhold information behind a "Comment keyword / Like / RT / Follow to get DM" funnel, engagement bait prompt, or artificial scarcity?`
    };

    questions[`${k}_manufactured_rage_bait`] = {
      type: "noul",
      instructions: `Does \`posts.${k}.text\` (post "${recordId}") use deliberate outrage bait, strawman framing, tribal provocation, or emotional manipulation designed to farm angry replies?`
    };

    questions[`${k}_bullshit_tier`] = {
      type: "score",
      instructions: `Rate the overall level of fabricated hype, engagement-farming bait, or rage-bait bullshit in \`posts.${k}.text\` (post "${recordId}").`,
      criteria: BULLSHIT_TIER_CRITERIA
    };

    questions[`${k}_primary_intent`] = {
      type: "choice",
      instructions: `What is the primary nature of \`posts.${k}.text\` (post "${recordId}")?`,
      criteria: PRIMARY_INTENT_CRITERIA
    };
  }

  return {
    model,
    state: {
      posts: statePosts
    },
    questions
  };
}

/**
 * Validates that a Jev response matches all schema requirements and invariants:
 * - Non-empty model identifier
 * - All questions answered
 * - Noul values in [0, 1]
 * - Choice is valid candidate, probabilities sum to 1.0 ± 0.05, and choice is argmax
 * - Score is valid number in range [0, criteria.length - 1], probabilities sum to 1.0 ± 0.05
 *
 * @param {object} requestPayload - The original request sent to Jev
 * @param {object} responseData - The parsed response received from Jev
 * @returns {boolean} true if valid, throws Error otherwise
 */
export function validateJevResponse(requestPayload, responseData) {
  if (!responseData || typeof responseData !== "object") {
    throw new Error("Invalid Jev response: responseData must be a non-null object");
  }
  if (typeof responseData.model !== "string" || !responseData.model.trim()) {
    throw new Error("Invalid Jev response: missing or empty 'model' identifier string");
  }
  if (!responseData.answers || typeof responseData.answers !== "object") {
    throw new Error("Invalid Jev response: missing or invalid 'answers' object");
  }

  const questions = requestPayload?.questions || {};
  for (const [qKey, qDef] of Object.entries(questions)) {
    const ans = responseData.answers[qKey];
    if (!ans || typeof ans !== "object") {
      throw new Error(`Invalid Jev response: missing answer object for question "${qKey}"`);
    }

    if (qDef.type === "noul") {
      if (typeof ans.noul !== "number" || isNaN(ans.noul) || ans.noul < 0 || ans.noul > 1) {
        throw new Error(
          `Invalid Jev response for noul question "${qKey}": 'noul' must be a number in [0, 1], got ${ans.noul}`
        );
      }
    } else if (qDef.type === "choice") {
      if (typeof ans.choice !== "string") {
        throw new Error(
          `Invalid Jev response for choice question "${qKey}": 'choice' must be a string, got ${typeof ans.choice}`
        );
      }
      const validCandidates = Object.keys(qDef.criteria || {});
      if (!validCandidates.includes(ans.choice)) {
        throw new Error(
          `Invalid Jev response for choice question "${qKey}": choice "${ans.choice}" is not one of candidate options: ${validCandidates.join(", ")}`
        );
      }
      if (typeof ans.confidence !== "number" || isNaN(ans.confidence) || ans.confidence < 0 || ans.confidence > 1) {
        throw new Error(
          `Invalid Jev response for choice question "${qKey}": 'confidence' must be in [0, 1], got ${ans.confidence}`
        );
      }
      if (!ans.probabilities || typeof ans.probabilities !== "object") {
        throw new Error(`Invalid Jev response for choice question "${qKey}": missing 'probabilities' object`);
      }

      const probKeys = Object.keys(ans.probabilities);
      let probSum = 0;
      let maxProb = -Infinity;
      let argmaxCandidate = null;

      for (const cand of validCandidates) {
        const p = ans.probabilities[cand];
        if (typeof p !== "number" || isNaN(p) || p < 0 || p > 1) {
          throw new Error(
            `Invalid Jev response for choice question "${qKey}": probability for "${cand}" must be in [0, 1], got ${p}`
          );
        }
        probSum += p;
        if (p > maxProb) {
          maxProb = p;
          argmaxCandidate = cand;
        }
      }

      if (probKeys.length !== validCandidates.length) {
        throw new Error(
          `Invalid Jev response for choice question "${qKey}": probabilities keys (${probKeys.length}) do not match candidate count (${validCandidates.length})`
        );
      }

      if (Math.abs(probSum - 1.0) > 0.05) {
        throw new Error(
          `Invalid Jev response for choice question "${qKey}": probabilities sum to ${probSum.toFixed(4)}, expected 1.0 ± 0.05`
        );
      }

      // Verify choice is the argmax of probabilities
      if (ans.probabilities[ans.choice] < maxProb - 0.005) {
        throw new Error(
          `Invalid Jev response for choice question "${qKey}": choice "${ans.choice}" (P=${ans.probabilities[ans.choice]}) is not argmax of probabilities (highest is "${argmaxCandidate}" with P=${maxProb})`
        );
      }
    } else if (qDef.type === "score") {
      const maxScore = (qDef.criteria?.length || 5) - 1;
      if (typeof ans.score !== "number" || isNaN(ans.score) || ans.score < 0 || ans.score > maxScore) {
        throw new Error(
          `Invalid Jev response for score question "${qKey}": 'score' must be a number in [0, ${maxScore}], got ${ans.score}`
        );
      }
      if (typeof ans.confidence !== "number" || isNaN(ans.confidence) || ans.confidence < 0 || ans.confidence > 1) {
        throw new Error(
          `Invalid Jev response for score question "${qKey}": 'confidence' must be in [0, 1], got ${ans.confidence}`
        );
      }
      if (!ans.probabilities || typeof ans.probabilities !== "object") {
        throw new Error(`Invalid Jev response for score question "${qKey}": missing 'probabilities' object`);
      }

      let probSum = 0;
      for (let i = 0; i <= maxScore; i++) {
        const p = ans.probabilities[String(i)] !== undefined ? ans.probabilities[String(i)] : ans.probabilities[i];
        if (typeof p !== "number" || isNaN(p) || p < 0 || p > 1) {
          throw new Error(
            `Invalid Jev response for score question "${qKey}": tier probability for "${i}" must be in [0, 1], got ${p}`
          );
        }
        probSum += p;
      }

      if (Math.abs(probSum - 1.0) > 0.05) {
        throw new Error(
          `Invalid Jev response for score question "${qKey}": score probabilities sum to ${probSum.toFixed(4)}, expected 1.0 ± 0.05`
        );
      }
    }
  }

  return true;
}

/**
 * Formats the auto-answer reply text for X.com.
 * STRICT REQUIREMENT: Always includes the signature tagline:
 * "rated ${scoredResult.stinkinessPct}% on stinkiness by bullshtt.ai"
 * Kept under 275 characters so it fits in a standard 280-char X reply without X Premium.
 *
 * @param {object} scoredResult
 * @param {object} options - { style: "full" | "compact" }
 * @returns {string} Formatted reply text
 */
export function formatAutoAnswer(scoredResult, options = { style: "full" }) {
  const stinkiness = scoredResult.stinkinessPct;
  const signature = `rated ${stinkiness}% on stinkiness by ${BRAND_DOMAIN}`;
  const verdict = scoredResult.verdictLabel || VERDICT_LABELS[scoredResult.primaryIntent] || "Unclassified";

  const rawSignals = scoredResult.signals || {};
  const sortedSignals = Object.entries(rawSignals).sort((a, b) => b[1] - a[1]);

  if (options.style === "compact") {
    const top2 = sortedSignals
      .slice(0, 2)
      .map(([k, v]) => `${Math.round(v * 100)}% ${SIGNAL_LABELS[k] || k}`)
      .join(", ");
    return `💩 ${verdict} (${top2}) — ${signature}`;
  }

  // Full style:
  const rawHandle = (scoredResult.handle || scoredResult.author || "").replace(/^@/, "").trim();
  const handlePart = rawHandle ? ` (@${rawHandle})` : "";
  const header = `💩 BS Audit${handlePart}:`;

  // Dynamically pack top 4 or top 3 signals so total length is strictly <= 275 characters
  for (let count = 4; count >= 2; count--) {
    const signalBullets = sortedSignals
      .slice(0, count)
      .map(([k, v]) => `• ${Math.round(v * 100)}% ${SIGNAL_LABELS[k] || k}`)
      .join("\n");

    const candidate = `${header}\n${signalBullets}\nVerdict: ${verdict}\n\n${signature}`;
    if (candidate.length <= 275) {
      return candidate;
    }
  }

  // Fallback if handle is unusually long:
  const shortBullets = sortedSignals
    .slice(0, 2)
    .map(([k, v]) => `• ${Math.round(v * 100)}% ${SIGNAL_LABELS[k] || k}`)
    .join("\n");
  const fallback = `💩 BS Audit:\n${shortBullets}\nVerdict: ${verdict}\n\n${signature}`;
  return fallback;
}

/**
 * Scores a batch of posts using validated Jev answers and deterministic policy.
 *
 * @param {Array<object>} posts - Array of input post records
 * @param {object} requestPayload - Jev request payload
 * @param {object} responseData - Jev response data
 * @returns {Array<object>} Array of scored post result objects
 */
export function scoreBatchFromJev(posts, requestPayload, responseData) {
  validateJevResponse(requestPayload, responseData);

  const results = [];
  const answers = responseData.answers;

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    const k = `p${i}`;

    const signals = {
      implausible_claim: answers[`${k}_implausible_claim`].noul,
      incoherent_mechanism: answers[`${k}_incoherent_mechanism`].noul,
      zero_verifiable_evidence: answers[`${k}_zero_verifiable_evidence`].noul,
      engagement_farming_gate: answers[`${k}_engagement_farming_gate`].noul,
      manufactured_rage_bait: answers[`${k}_manufactured_rage_bait`].noul
    };

    const tierAns = answers[`${k}_bullshit_tier`];
    const tierScore = tierAns.score;
    const tierNorm = tierScore / 4.0;

    const intentAns = answers[`${k}_primary_intent`];
    const intentChoice = intentAns.choice;
    const intentConfidence = intentAns.confidence;
    const intentProbs = intentAns.probabilities || {};

    const sortedProbs = Object.values(intentProbs).sort((a, b) => b - a);
    const topProb = sortedProbs[0] || 0;
    const secondProb = sortedProbs[1] || 0;
    const intentMargin = topProb - secondProb;

    // Weight combinations:
    const hustleScore =
      0.30 * signals.implausible_claim +
      0.30 * signals.incoherent_mechanism +
      0.20 * signals.zero_verifiable_evidence +
      0.20 * signals.engagement_farming_gate;

    const rageScore =
      0.45 * signals.manufactured_rage_bait +
      0.25 * signals.implausible_claim +
      0.20 * signals.zero_verifiable_evidence +
      0.10 * signals.incoherent_mechanism;

    let rawScore = Math.max(hustleScore, rageScore) * 0.85 + tierNorm * 0.15;

    // Satire damping policy:
    let isSatire = false;
    if (intentChoice === "satire" && intentConfidence >= 0.80 && intentMargin >= 0.15) {
      rawScore = rawScore * 0.35;
      isSatire = true;
    }

    const stinkinessPct = Math.max(1, Math.min(100, Math.round(rawScore * 100)));

    const uncertain =
      intentConfidence < 0.80 ||
      intentMargin < 0.15 ||
      ALWAYS_REVIEW_LABELS.has(intentChoice);

    const postHash = computePostHash(post);
    const verdictLabel = isSatire ? "Satire / Parody" : (VERDICT_LABELS[intentChoice] || intentChoice);

    const scoredResult = {
      id: post.id || `post-${i}`,
      author: post.author || "",
      handle: post.handle || post.author || "",
      stinkinessPct,
      rawScore: Math.round(rawScore * 1000) / 1000,
      hustleScore: Math.round(hustleScore * 1000) / 1000,
      rageScore: Math.round(rageScore * 1000) / 1000,
      signals,
      tier: tierScore,
      tierConfidence: tierAns.confidence,
      primaryIntent: intentChoice,
      intentConfidence,
      intentMargin: Math.round(intentMargin * 1000) / 1000,
      verdictLabel,
      isSatire,
      uncertain,
      postHash,
      questionVersion: QUESTION_VERSION,
      policyVersion: POLICY_VERSION,
      model: responseData.model,
      evaluatedAt: new Date().toISOString()
    };

    scoredResult.autoAnswerText = formatAutoAnswer(scoredResult, { style: "full" });
    scoredResult.autoAnswerCompact = formatAutoAnswer(scoredResult, { style: "compact" });

    results.push(scoredResult);
  }

  return results;
}

/**
 * Validates cache entry freshness against post hash, question version,
 * policy version, model prefix, and TTL.
 *
 * @param {object} entry - Cached verdict object
 * @param {string} expectedPostHash - Hash of the target post
 * @param {string} expectedModelPrefix - Model prefix (default: "jev-")
 * @param {number} maxAgeMs - Cache TTL in ms (default: 7 days)
 * @returns {boolean} true if cache entry is fresh and reusable
 */
export function isCacheEntryFresh(
  entry,
  expectedPostHash,
  expectedModelPrefix = "jev-",
  maxAgeMs = 7 * 24 * 60 * 60 * 1000
) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.postHash !== expectedPostHash) return false;
  if (entry.questionVersion !== QUESTION_VERSION) return false;
  if (entry.policyVersion !== POLICY_VERSION) return false;
  if (typeof entry.stinkinessPct !== "number") return false;
  if (typeof entry.model !== "string" || !entry.model.startsWith(expectedModelPrefix)) return false;
  if (!entry.evaluatedAt) return false;

  const age = Date.now() - new Date(entry.evaluatedAt).getTime();
  if (isNaN(age) || age < 0 || age > maxAgeMs) return false;

  return true;
}
