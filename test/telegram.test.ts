import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitTelegramMessage } from "../src/telegram.js";

describe("splitTelegramMessage", () => {
  it("keeps short messages intact", () => {
    assert.deepEqual(splitTelegramMessage("hello", 10), ["hello"]);
  });

  it("splits messages at line boundaries", () => {
    assert.deepEqual(splitTelegramMessage("alpha\nbeta\ngamma", 10), ["alpha\nbeta", "gamma"]);
  });

  it("splits a single long line", () => {
    assert.deepEqual(splitTelegramMessage("abcdefghij", 4), ["abcd", "efgh", "ij"]);
  });
});
