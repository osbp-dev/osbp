import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildLabel } from "./build-label.js";

describe("buildLabel", () => {
  it("reports the build timestamp and git hash for a real binary URL", () => {
    const label = buildLabel(import.meta.url);
    assert.match(label, /^built \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC \| git:[0-9a-f]{7,}$/);
  });

  it("returns an empty string when the file is unreadable and git cannot run", () => {
    // A path that does not exist: statSync throws and git rev-parse cannot run
    // because its cwd (the file's parent) does not exist either, so both parts
    // are dropped and the joined result is empty.
    assert.equal(buildLabel("file:///osbp-nonexistent-dir/missing-binary.js"), "");
  });
});
