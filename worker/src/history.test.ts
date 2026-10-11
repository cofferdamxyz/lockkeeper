import { describe, expect, it } from "vitest";

import { splitChanges } from "./history";

describe("splitChanges", () => {
  it("separates added and deleted paths from the full list", () => {
    const r = splitChanges([
      { path: "src/a.ts", status: "M" },
      { path: "src/new.ts", status: "A" },
      { path: "old.md", status: "D" },
    ]);
    expect(r.files).toEqual(["src/a.ts", "src/new.ts", "old.md"]);
    expect(r.added).toEqual(["src/new.ts"]);
    expect(r.deleted).toEqual(["old.md"]);
  });
});
