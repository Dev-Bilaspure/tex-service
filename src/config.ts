// Service configuration, from the environment.
import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { DEFAULT_PORT } from "./protocol.ts";

export interface TexServiceConfig {
  host: string;
  port: number;
  /** Bearer token clients must send. Optional: in Docker Compose the port is published on loopback only. */
  token?: string;
  /** Projects, build files and TeX's caches. */
  dataDir: string;
  /** Builds running at once; more wait their turn. */
  concurrency: number;
  /** Upper limit for one build, whatever the client asks. */
  maxCompileMs: number;
  /** Largest request body, bytes. */
  maxBodyBytes: number;
  /** Projects not built for this long are deleted. */
  projectTtlMs: number;
  /** A line per request on stdout (errors are always logged). */
  logRequests: boolean;
}

const DAY = 24 * 60 * 60 * 1000;

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): TexServiceConfig {
  const num = (name: string, fallback: number, min: number) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min) throw new Error(`${name} must be a number ≥ ${min} (got "${raw}")`);
    return n;
  };
  return {
    host: env.HOST ?? "127.0.0.1",
    port: num("PORT", DEFAULT_PORT, 0),
    token: env.TEX_SERVICE_TOKEN || undefined,
    dataDir: resolve(env.TEX_SERVICE_DATA ?? "./tex-service-data"),
    concurrency: Math.floor(num("TEX_SERVICE_CONCURRENCY", Math.max(1, Math.min(4, availableParallelism())), 1)),
    maxCompileMs: num("TEX_SERVICE_MAX_COMPILE_SECONDS", 300, 1) * 1000,
    maxBodyBytes: num("TEX_SERVICE_MAX_BODY_MB", 64, 1) * 1024 * 1024,
    projectTtlMs: num("TEX_SERVICE_PROJECT_TTL_DAYS", 14, 0.001) * DAY,
    logRequests: !/^(0|false|no|off)$/i.test(env.TEX_SERVICE_LOG_REQUESTS ?? ""),
  };
}
