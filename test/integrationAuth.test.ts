import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { IncomingMessage } from "node:http";
import { assertIntegrationAuthConfigured, isFinTwtAuthenticated } from "../src/integrationAuth.js";

describe("fin_twt integration auth", () => {
  const original = process.env.SCREENER_API_TOKEN;

  before(() => {
    process.env.SCREENER_API_TOKEN = "0123456789abcdef0123456789abcdef";
  });

  after(() => {
    if (original === undefined) delete process.env.SCREENER_API_TOKEN;
    else process.env.SCREENER_API_TOKEN = original;
  });

  it("requires a sufficiently long configured token", () => {
    assert.doesNotThrow(() => assertIntegrationAuthConfigured());
    process.env.SCREENER_API_TOKEN = "short";
    assert.throws(() => assertIntegrationAuthConfigured(), /at least 32/);
    process.env.SCREENER_API_TOKEN = "0123456789abcdef0123456789abcdef";
  });

  it("accepts only the matching bearer token", () => {
    const request = (authorization?: string) =>
      ({ headers: authorization ? { authorization } : {} }) as IncomingMessage;
    assert.equal(isFinTwtAuthenticated(request("Bearer 0123456789abcdef0123456789abcdef")), true);
    assert.equal(isFinTwtAuthenticated(request("Bearer wrong")), false);
    assert.equal(isFinTwtAuthenticated(request("Basic 0123456789abcdef0123456789abcdef")), false);
    assert.equal(isFinTwtAuthenticated(request()), false);
  });
});
