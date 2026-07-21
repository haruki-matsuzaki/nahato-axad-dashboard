import assert from "node:assert/strict";
import test from "node:test";

import { createFetchWithRetry } from "./fetch-with-retry.mjs";

test("retries a 429 response and respects Retry-After", async () => {
  const calls = [];
  const sleeps = [];
  const fetchWithRetry = createFetchWithRetry({
    fetchImpl: sequenceFetch(calls, [
      new Response("rate limited", { status: 429, headers: { "retry-after": "0" } }),
      new Response("ok", { status: 200 }),
    ]),
    retryDelaysMs: [5, 15],
    sleepImpl: async (delay) => sleeps.push(delay),
    logger: silentLogger,
  });

  const response = await fetchWithRetry("https://sheets.googleapis.com/test");

  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [0]);
});

test("retries 5xx responses with configured delays", async () => {
  const calls = [];
  const sleeps = [];
  const fetchWithRetry = createFetchWithRetry({
    fetchImpl: sequenceFetch(calls, [
      new Response("unavailable", { status: 503 }),
      new Response("gateway", { status: 502 }),
      new Response("ok", { status: 200 }),
    ]),
    retryDelaysMs: [5, 15],
    sleepImpl: async (delay) => sleeps.push(delay),
    logger: silentLogger,
  });

  const response = await fetchWithRetry("https://sheets.googleapis.com/test");

  assert.equal(response.status, 200);
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [5, 15]);
});

test("retries transport failures", async () => {
  const calls = [];
  const fetchWithRetry = createFetchWithRetry({
    fetchImpl: sequenceFetch(calls, [new TypeError("socket disconnected"), new Response("ok", { status: 200 })]),
    retryDelaysMs: [0],
    sleepImpl: async () => {},
    logger: silentLogger,
  });

  const response = await fetchWithRetry("https://sheets.googleapis.com/test");

  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
});

test("does not retry permanent 4xx responses", async () => {
  const calls = [];
  const fetchWithRetry = createFetchWithRetry({
    fetchImpl: sequenceFetch(calls, [new Response("forbidden", { status: 403 })]),
    retryDelaysMs: [0, 0],
    sleepImpl: async () => {},
    logger: silentLogger,
  });

  const response = await fetchWithRetry("https://sheets.googleapis.com/test");

  assert.equal(response.status, 403);
  assert.equal(calls.length, 1);
});

function sequenceFetch(calls, responses) {
  return async (url, options) => {
    calls.push({ url: String(url), options });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (!response) throw new Error(`Unexpected fetch: ${url}`);
    return response;
  };
}

const silentLogger = { warn() {} };
