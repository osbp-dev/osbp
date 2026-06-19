import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OSBP_VERSION } from "./index.js";

// SemVer 2.0: major.minor.patch with optional pre-release label (-dev, -alpha.1, -rc.1, etc.)
// Valid:   "0.1.0", "0.2.0-dev", "0.2.0-alpha.1", "1.0.0-rc.2"
// Invalid: "0.1", "0.1.0.local", "v0.1.0", ""
const SEMVER = /^\d+\.\d+\.\d+(-[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)*)?$/;

describe("OSBP_VERSION", () => {
  it("is a valid SemVer string", () => {
    assert.match(
      OSBP_VERSION,
      SEMVER,
      `OSBP_VERSION "${OSBP_VERSION}" must be valid SemVer (e.g. "0.1.0" or "0.2.0-dev")`
    );
  });

  it("does not contain a bare deployment label", () => {
    // Guard against accidentally committing "0.1.0-local" or "0.1.0+dev"
    // instead of the canonical "-dev" / "-alpha.N" / "-rc.N" pre-release form.
    assert.doesNotMatch(OSBP_VERSION, /local/, "version must not contain 'local'");
    assert.doesNotMatch(OSBP_VERSION, /\+/, "use SemVer pre-release (-dev) not build metadata (+dev)");
  });
});
