// Runs a program with an argument array (never through a shell), in its own process group, so a timeout
// or a cancelled request kills it and everything it started (latexmk → xelatex → biber).
import { spawn } from "node:child_process";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The program couldn't be started (not installed). */
  error: NodeJS.ErrnoException | null;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
  /** Output beyond this is dropped (keeps the tail): a runaway TeX loop can print megabytes. */
  maxOutput?: number;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const max = opts.maxOutput ?? 2_000_000;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killGroup();
        }, opts.timeoutMs)
      : null;
    const onAbort = () => killGroup();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const done = (r: RunResult) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    const cap = (s: string) => (s.length > max ? s.slice(s.length - max) : s);
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout = cap(stdout + d)));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr = cap(stderr + d)));
    child.on("error", (error: NodeJS.ErrnoException) => done({ code: null, stdout, stderr, timedOut, error }));
    child.on("close", (code) => done({ code, stdout, stderr, timedOut, error: null }));
  });
}

/** The last `lines` non-empty lines of a program's output. */
export function tail(text: string, lines: number): string {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .slice(-lines)
    .join("\n");
}
