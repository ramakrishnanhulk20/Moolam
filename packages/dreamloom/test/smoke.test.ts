import { describe, expect, it } from "vitest";
import * as platform from "@moolam/platform";

describe("workspace link", () => {
  it("reads the platform kit from the workspace", () => {
    expect(typeof platform.registerAsPlatform).toBe("function");
  });
});
