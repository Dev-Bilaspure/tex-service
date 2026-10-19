#!/usr/bin/env node
// tex-service: the compile service. Configured by the environment (see config.ts and the README).
import { mkdirSync } from "node:fs";
import { configFromEnv } from "./config.ts";
import { createTexService } from "./server.ts";

let config;
try {
  config = configFromEnv();
} catch (e) {
  console.error(`tex-service: ${(e as Error).message}`);
  process.exit(2);
}

// TeX and fontconfig write caches under these; they must exist (in the image they point into /data).
for (const dir of [process.env.HOME, process.env.TEXMFVAR, process.env.TEXMFCONFIG, process.env.XDG_CACHE_HOME, process.env.PAR_GLOBAL_TMPDIR]) {
  if (dir && dir.startsWith(config.dataDir)) mkdirSync(dir, { recursive: true });
}

const service = await createTexService(config);
const { tex, poppler, fontSubstitutes } = service.info;
if (!tex.latexmk) console.warn("[tex-service] latexmk isn't on PATH: builds will fail. Run the service from its Docker image.");
if (poppler.missing.length) console.warn(`[tex-service] missing ${poppler.missing.join(", ")} (poppler): PDF checks will fail.`);

service.server.on("error", (e) => {
  console.error(`tex-service: ${e.message}`);
  process.exit(1);
});
service.server.listen(config.port, config.host, () => {
  const subs = Object.entries(fontSubstitutes).map(([a, b]) => `${a}→${b}`);
  console.log(
    `[tex-service] listening on http://${config.host}:${config.port} · ${tex.version ?? "TeX not found"} · ${config.concurrency} at a time` +
      (config.token ? " · token required" : "") +
      (subs.length ? ` · font stand-ins: ${subs.join(", ")}` : ""),
  );
});

let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`[tex-service] ${sig}: finishing builds in progress…`);
    void service.close().then(() => process.exit(0));
  });
}
