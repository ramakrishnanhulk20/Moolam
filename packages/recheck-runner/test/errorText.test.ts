// Covers the runner's copy of the verify service's error text rule (review pass 7, V66): every
// address in a logged reason is cut to its origin and every "URL:" or "Request body:" line goes.
// Does NOT cover each log line one by one; test/runner.test.ts proves one real logging site.

import { describe, expect, it } from "vitest";
import { safeReason } from "../src/errorText.js";

describe("safeReason", () => {
  it("cuts every address to its origin and drops the lines that name one", () => {
    const error = new Error(
      ["the RPC call eth_call failed at https://rpc.example/TOKEN123?key=abc", "URL: rpc.example/TOKEN123", 'Request body: {"id":1}'].join("\n"),
    );

    expect(safeReason(error)).toBe("the RPC call eth_call failed at https://rpc.example");
  });

  it("tells an error with a short message by its name and that message", () => {
    const error = Object.assign(new Error("HTTP request failed.\n\nURL: https://rpc.example/TOKEN123"), {
      name: "HttpRequestError",
      shortMessage: "HTTP request failed.",
    });

    expect(safeReason(error)).toBe("HttpRequestError: HTTP request failed.");
    expect(safeReason("the index timed out")).toBe("the index timed out");
  });
});
