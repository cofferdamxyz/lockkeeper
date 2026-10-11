import { describe, expect, it } from "vitest";

import { pickNext } from "./lock";

describe("pickNext", () => {
  const t = (id: string, lock_order: number | null = null) => ({ id, lock_order });
  it("takes Clef's choice when nothing is pinned", () => {
    expect(pickNext([t("a"), t("b")], "b")).toBe("b");
  });
  it("lets a pinned order win over Clef", () => {
    expect(pickNext([t("a"), t("b", 2), t("c", 1)], "a")).toBe("c");
  });
  it("falls back to the oldest candidate", () => {
    expect(pickNext([t("a"), t("b")], null)).toBe("a");
    expect(pickNext([t("a"), t("b")], "zzz")).toBe("a");
  });
});
