import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

function writeConfig(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ethproxy-config-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, body);
  return path;
}

const BASE = `
upstreams:
  - name: a
    url: http://127.0.0.1:8545
`;

describe("config cross-field validation", () => {
  it("rejects reorg.windowSize below cache.finalityDepth when detection is on", () => {
    const path = writeConfig(
      `${BASE}cache:\n  finalityDepth: 64\nreorg:\n  enabled: true\n  windowSize: 32\n`,
    );
    expect(() => loadConfig(path)).toThrow(/windowSize/);
  });

  it("accepts a window covering finalityDepth", () => {
    const path = writeConfig(
      `${BASE}cache:\n  finalityDepth: 64\nreorg:\n  enabled: true\n  windowSize: 128\n`,
    );
    const config = loadConfig(path);
    expect(config.reorg.windowSize).toBe(128);
    expect(config.cache.unfinalizedTtlMs).toBe(900000);
  });

  it("allows a small window when detection is disabled", () => {
    const path = writeConfig(
      `${BASE}cache:\n  finalityDepth: 64\nreorg:\n  enabled: false\n  windowSize: 32\n`,
    );
    expect(() => loadConfig(path)).not.toThrow();
  });
});
