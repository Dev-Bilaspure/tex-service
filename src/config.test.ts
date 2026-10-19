import assert from "node:assert/strict";
import { test } from "node:test";
import { configFromEnv } from "./config.ts";

test("defaults: loopback, no token, no shell escape", () => {
  const c = configFromEnv({});
  assert.deepEqual([c.host, c.port, c.token, c.allowShellEscape, c.allowUnauthenticated], ["127.0.0.1", 4380, undefined, false, false]);
});

test("a public address needs a token, or an explicit opt-out", () => {
  assert.throws(() => configFromEnv({ HOST: "0.0.0.0" }), /TEX_SERVICE_TOKEN/);
  assert.equal(configFromEnv({ HOST: "0.0.0.0", TEX_SERVICE_TOKEN: "s3cret" }).token, "s3cret");
  assert.equal(configFromEnv({ HOST: "0.0.0.0", TEX_SERVICE_ALLOW_UNAUTHENTICATED: "1" }).allowUnauthenticated, true);
  assert.doesNotThrow(() => configFromEnv({ HOST: "::1" }));
});

test("numbers are checked", () => {
  assert.throws(() => configFromEnv({ PORT: "abc" }), /PORT must be a number/);
  assert.throws(() => configFromEnv({ TEX_SERVICE_CONCURRENCY: "0" }), /TEX_SERVICE_CONCURRENCY/);
  assert.equal(configFromEnv({ TEX_SERVICE_ALLOW_SHELL_ESCAPE: "true" }).allowShellEscape, true);
});
