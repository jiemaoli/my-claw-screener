import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createSessionToken, verifyCredentials, verifySessionToken } from "../src/auth.js";

describe("auth", () => {
  const original = { ...process.env };

  before(() => {
    process.env.APP_USERNAME = "jerry";
    process.env.APP_PASSWORD = "correct-password";
    process.env.APP_SESSION_SECRET = "0123456789abcdef0123456789abcdef";
  });

  after(() => {
    process.env = original;
  });

  it("validates credentials", () => {
    assert.equal(verifyCredentials("jerry", "correct-password"), true);
    assert.equal(verifyCredentials("jerry", "wrong-password"), false);
  });

  it("creates signed expiring sessions", () => {
    const token = createSessionToken("jerry", 1_000);
    assert.equal(verifySessionToken(token, 2_000), true);
    assert.equal(verifySessionToken(token, 8 * 24 * 60 * 60 * 1000), false);
    assert.equal(verifySessionToken(`${token}x`, 2_000), false);
  });
});
