// Service configuration, from the environment.
import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { DEFAULT_PORT } from "./protocol.ts";

export interface TexServiceConfig {
  host: string;
  port: number;
  /** Bearer token clients must send. Required on any address other than loopback (see checkConfig). */
  token?: string;
  /** Serve without a token on a non-loopback address anyway (the port is only reachable from this machine). */
  allowUnauthenticated: boolean;
  /**
   * Let clients build with full shell escape (\write18, for minted, svg, gnuplot), i.e. run any command
   * inside the container. Off by default: builds get TeX's restricted shell escape.
   */
  allowShellEscape: boolean;
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

const yes = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v ?? "");
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|::1)$/;

export function isLoopback(host: string) {
  return LOOPBACK.test(host);
}

/** Refuses a configuration that would let anyone on the network run TeX here. */
export function checkConfig(c: TexServiceConfig) {
  if (!c.token && !c.allowUnauthenticated && !isLoopback(c.host)) {
    throw new Error(
      `Listening on ${c.host} without a token would let anyone who can reach this port run TeX here. Set TEX_SERVICE_TOKEN ` +
        "(clients send it as a bearer token), or, if the port is only reachable from this machine (e.g. docker run -p 127.0.0.1:4380:4380), " +
        "set TEX_SERVICE_ALLOW_UNAUTHENTICATED=1.",
    );
  }
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): TexServiceConfig {
  const num = (name: string, fallback: number, min: number) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min) throw new Error(`${name} must be a number ≥ ${min} (got "${raw}")`);
    return n;
  };
  const config: TexServiceConfig = {
    host: env.HOST ?? "127.0.0.1",
    port: num("PORT", DEFAULT_PORT, 0),
    token: env.TEX_SERVICE_TOKEN || undefined,
    allowUnauthenticated: yes(env.TEX_SERVICE_ALLOW_UNAUTHENTICATED),
    allowShellEscape: yes(env.TEX_SERVICE_ALLOW_SHELL_ESCAPE),
    dataDir: resolve(env.TEX_SERVICE_DATA ?? "./tex-service-data"),
    concurrency: Math.floor(num("TEX_SERVICE_CONCURRENCY", Math.max(1, Math.min(4, availableParallelism())), 1)),
    maxCompileMs: num("TEX_SERVICE_MAX_COMPILE_SECONDS", 300, 1) * 1000,
    maxBodyBytes: num("TEX_SERVICE_MAX_BODY_MB", 64, 1) * 1024 * 1024,
    projectTtlMs: num("TEX_SERVICE_PROJECT_TTL_DAYS", 14, 0.001) * DAY,
    logRequests: !/^(0|false|no|off)$/i.test(env.TEX_SERVICE_LOG_REQUESTS ?? ""),
  };
  checkConfig(config);
  return config;
}
