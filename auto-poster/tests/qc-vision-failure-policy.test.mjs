/**
 * QC vision-check failure policy.
 *
 * The split matters: a bad API key never self-heals, so failing open on it would
 * silently disable content checks on every future run while CI stayed green. A
 * timeout or a 503 does self-heal, and blocking a post over one is worse than
 * skipping one vision check.
 *
 * Misclassifying in either direction is a real incident:
 *   auth treated as transient  -> content checks silently off, indefinitely
 *   transient treated as auth  -> posts blocked during any Anthropic blip
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isAuthError } from "../src/quality-check.js";

/** Shape the Anthropic SDK produces for HTTP errors. */
const apiError = (status, body) => Object.assign(new Error(`${status} ${JSON.stringify(body)}`), { status });

describe("isAuthError — FATAL (credential problems)", () => {
  test("401 invalid api key", () => {
    assert.equal(isAuthError(apiError(401, { type: "error", error: { type: "authentication_error", message: "API key is invalid." } })), true);
  });

  test("403 permission denied", () => {
    assert.equal(isAuthError(apiError(403, { type: "error", error: { type: "permission_error", message: "denied" } })), true);
  });

  test("client constructed with no key (throws before any HTTP request)", () => {
    assert.equal(isAuthError(new Error("Could not resolve authentication method. Expected either apiKey or authToken to be set.")), true);
  });

  test("invalid x-api-key header", () => {
    assert.equal(isAuthError(new Error("invalid x-api-key")), true);
  });

  test("status carried on err.response.status instead of err.status", () => {
    assert.equal(isAuthError({ response: { status: 401 }, message: "nope" }), true);
  });
});

describe("isAuthError — TRANSIENT (must fail open)", () => {
  test("429 rate limit", () => {
    assert.equal(isAuthError(apiError(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } })), false);
  });

  test("500 internal error", () => {
    assert.equal(isAuthError(apiError(500, { type: "error", error: { type: "api_error", message: "oops" } })), false);
  });

  test("503 overloaded", () => {
    assert.equal(isAuthError(apiError(503, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } })), false);
  });

  test("connection error", () => {
    assert.equal(isAuthError(new Error("Connection error.")), false);
  });

  test("socket timeout", () => {
    assert.equal(isAuthError(Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" })), false);
  });

  test("400 bad request is not an auth problem", () => {
    assert.equal(isAuthError(apiError(400, { type: "error", error: { type: "invalid_request_error", message: "bad image" } })), false);
  });
});

describe("isAuthError — defensive", () => {
  for (const [label, value] of [["undefined", undefined], ["null", null], ["empty object", {}], ["bare string", "boom"]]) {
    test(`${label} does not throw and is not treated as auth`, () => {
      assert.equal(isAuthError(value), false);
    });
  }
});
