/**
 * bullshtt.ai (Jevchrome) - Backend Proxy & Caching Server
 *
 * Exposes:
 *  - GET  /api/health -> Health status, model ID, cached verdict stats
 *  - POST /api/score  -> Batched scoring with disk caching & TypeSafe Jev systemone call
 *
 * Implements CORS for Chrome extension content scripts & service workers.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  JEV_ENDPOINT,
  JEV_MODEL,
  BRAND_DOMAIN,
  computePostHash,
  buildJevBatchRequest,
  scoreBatchFromJev,
  isCacheEntryFresh
} from "../engine/bs_scorer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CACHE_DIR = path.join(__dirname, ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "verdicts.json");
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8787;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

/**
 * Loads and validates TYPESAFE_API_KEY from environment or /mnt/c/Claudeprojects/.env.local.
 * Enforces ASCII characters and rejects whitespace per Jev rule #7.
 */
export function getTypesafeApiKey() {
  let key = process.env.TYPESAFE_API_KEY;

  if (!key) {
    const envPath = "/mnt/c/Claudeprojects/.env.local";
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf8");
      const match = content.match(/^TYPESAFE_API_KEY=(.*)$/m);
      if (match) {
        key = match[1].trim();
      }
    }
  }

  if (!key) {
    throw new Error(
      "TYPESAFE_API_KEY not found in environment or /mnt/c/Claudeprojects/.env.local"
    );
  }

  // Reject API key containing whitespace or non-ASCII characters
  if (!/^[\x21-\x7E]+$/.test(key)) {
    throw new Error(
      "Invalid TYPESAFE_API_KEY: contains whitespace or non-ASCII characters"
    );
  }

  return key;
}

/**
 * Loads verdicts cache from disk.
 */
export function loadCache() {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, "utf8");
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn("[bullshtt.ai] Failed to read disk cache, initializing empty cache:", err.message);
  }
  return {};
}

/**
 * Persists verdicts cache to disk.
 */
export function saveCache(cache) {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
  } catch (err) {
    console.error("[bullshtt.ai] Failed to persist disk cache:", err.message);
  }
}

/**
 * Calls Jev systemone endpoint with retry and backoff.
 * Pins model="jev-1.14.0", disables redirects (redirect: "error"),
 * and retries on 429, 5xx, and 529 honoring retry-after.
 */
export async function callJevBatch(payload, apiKey, maxRetries = 3) {
  let attempt = 0;
  let delayMs = 500;

  while (attempt < maxRetries) {
    attempt++;
    const res = await fetch(JEV_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload),
      redirect: "error"
    });

    if (res.ok) {
      return await res.json();
    }

    if (res.status === 401 || res.status === 422) {
      const errText = await res.text();
      throw new Error(`Jev API fatal error (${res.status}): ${errText}`);
    }

    if (res.status === 429 || res.status === 529 || res.status >= 500) {
      const retryAfter = res.headers.get("retry-after");
      const waitTime = retryAfter
        ? (parseInt(retryAfter, 10) * 1000 || delayMs)
        : delayMs;
      console.warn(
        `[bullshtt.ai] Jev API status ${res.status}, retrying after ${waitTime}ms (attempt ${attempt}/${maxRetries})...`
      );
      await new Promise(r => setTimeout(r, waitTime));
      delayMs *= 2;
      continue;
    }

    const errText = await res.text();
    throw new Error(`Jev API request failed with status ${res.status}: ${errText}`);
  }

  throw new Error(`Jev API call exceeded maximum retries (${maxRetries})`);
}

/**
 * Handles incoming HTTP requests.
 */
export async function handleRequest(req, res, cache, apiKey) {
  // CORS Preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  // Health endpoint
  if (req.method === "GET" && url.pathname === "/api/health") {
    res.writeHead(200, {
      ...CORS_HEADERS,
      "Content-Type": "application/json"
    });
    res.end(
      JSON.stringify({
        status: "ok",
        brand: BRAND_DOMAIN,
        model: JEV_MODEL,
        cachedEntries: Object.keys(cache).length
      })
    );
    return;
  }

  // Score endpoint
  if (req.method === "POST" && url.pathname === "/api/score") {
    let body;
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks).toString("utf8");
      body = JSON.parse(rawBody);
    } catch (err) {
      res.writeHead(400, {
        ...CORS_HEADERS,
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({ error: `Malformed JSON body: ${err.message}` }));
      return;
    }

    const posts = body?.posts;
    if (!Array.isArray(posts) || posts.length === 0) {
      res.writeHead(400, {
        ...CORS_HEADERS,
        "Content-Type": "application/json"
      });
      res.end(
        JSON.stringify({ error: "Invalid request: 'posts' must be a non-empty array" })
      );
      return;
    }

    try {
      const results = new Array(posts.length);
      const uncachedPosts = [];
      const uncachedIndexMap = [];

      for (let i = 0; i < posts.length; i++) {
        const post = posts[i];
        const hash = computePostHash(post);
        const cached = cache[hash];

        if (cached && isCacheEntryFresh(cached, hash)) {
          results[i] = { ...cached, fromCache: true };
        } else {
          uncachedPosts.push(post);
          uncachedIndexMap.push(i);
        }
      }

      let activeModel = JEV_MODEL;

      if (uncachedPosts.length > 0) {
        const batchReq = buildJevBatchRequest(uncachedPosts, JEV_MODEL);
        const jevData = await callJevBatch(batchReq, apiKey);

        // Required logging: exact model version returned
        console.log(`[bullshtt.ai] Scored ${uncachedPosts.length} posts via Jev model=${jevData.model}`);
        activeModel = jevData.model;

        const freshResults = scoreBatchFromJev(uncachedPosts, batchReq, jevData);

        for (let j = 0; j < freshResults.length; j++) {
          const freshItem = freshResults[j];
          cache[freshItem.postHash] = freshItem;
          const origIdx = uncachedIndexMap[j];
          results[origIdx] = { ...freshItem, fromCache: false };
        }

        saveCache(cache);
      } else {
        console.log(`[bullshtt.ai] Returned ${posts.length} posts from cache (0 live Jev calls)`);
      }

      res.writeHead(200, {
        ...CORS_HEADERS,
        "Content-Type": "application/json"
      });
      res.end(
        JSON.stringify({
          model: activeModel,
          results
        })
      );
    } catch (err) {
      console.error("[bullshtt.ai] Scoring error:", err);
      res.writeHead(500, {
        ...CORS_HEADERS,
        "Content-Type": "application/json"
      });
      res.end(
        JSON.stringify({
          error: `Scoring failed: ${err.message}`
        })
      );
    }
    return;
  }

  // Not found
  res.writeHead(404, {
    ...CORS_HEADERS,
    "Content-Type": "application/json"
  });
  res.end(JSON.stringify({ error: `Not found: ${req.method} ${url.pathname}` }));
}

/**
 * Creates and starts the HTTP server.
 */
export function createProxyServer(port = PORT) {
  const apiKey = getTypesafeApiKey();
  const cache = loadCache();

  const server = http.createServer((req, res) => {
    handleRequest(req, res, cache, apiKey).catch(err => {
      console.error("[bullshtt.ai] Unhandled server error:", err);
      if (!res.headersSent) {
        res.writeHead(500, {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  });

  return {
    server,
    start: () =>
      new Promise(resolve => {
        server.listen(port, () => {
          console.log(`[bullshtt.ai] Proxy server listening on http://localhost:${port}`);
          console.log(`[bullshtt.ai] Model: ${JEV_MODEL} | Cache entries: ${Object.keys(cache).length}`);
          resolve(server);
        });
      }),
    stop: () =>
      new Promise(resolve => {
        server.close(resolve);
      })
  };
}

// Auto-start when executed directly
if (process.argv[1] === __filename) {
  try {
    const app = createProxyServer(PORT);
    await app.start();
  } catch (err) {
    console.error("[bullshtt.ai] Fatal startup error:", err.message);
    process.exit(1);
  }
}
