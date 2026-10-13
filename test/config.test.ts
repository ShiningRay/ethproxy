import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

describe("auth config", () => {
  it("defaults to disabled with /healthz exempt", () => {
    const path = writeConfig(BASE);
    const config = loadConfig(path);
    expect(config.auth.enabled).toBe(false);
    expect(config.auth.realm).toBe("ethproxy");
    expect(config.auth.exemptPaths).toEqual(["/healthz"]);
  });

  it("treats empty credentials as unset so the example config loads", () => {
    const path = writeConfig(`${BASE}auth:\n  enabled: false\n  username: ""\n  password: ""\n`);
    const config = loadConfig(path);
    expect(config.auth.enabled).toBe(false);
    expect(config.auth.username).toBeUndefined();
    expect(config.auth.password).toBeUndefined();
  });

  it("still rejects enabled auth with empty credentials", () => {
    const path = writeConfig(`${BASE}auth:\n  enabled: true\n  username: ""\n  password: ""\n`);
    expect(() => loadConfig(path)).toThrow(/auth\.username/);
  });

  it("loads the shipped example config", () => {
    const example = fileURLToPath(new URL("../config.example.yaml", import.meta.url));
    const config = loadConfig(example);
    expect(config.auth.enabled).toBe(false);
  });

  it("rejects enabled without username/password", () => {
    const path = writeConfig(`${BASE}auth:\n  enabled: true\n  username: user\n`);
    expect(() => loadConfig(path)).toThrow(/auth\.username/);
  });

  it("accepts enabled with credentials", () => {
    const path = writeConfig(
      `${BASE}auth:\n  enabled: true\n  username: user\n  password: pass\n`,
    );
    const config = loadConfig(path);
    expect(config.auth.enabled).toBe(true);
  });

  it("rejects a non-ASCII realm", () => {
    const path = writeConfig(`${BASE}auth:\n  enabled: true\n  username: u\n  password: p\n  realm: "以大坊"\n`);
    expect(() => loadConfig(path)).toThrow(/printable ASCII/);
  });
});
