// The compile service: TeX Live, latexmk, SyncTeX, texcount and poppler behind a small HTTP API (see
// protocol.ts), so an app can build LaTeX documents on any OS without installing
// TeX. It's meant to run in its container next to the app, on loopback; the token is for anything else.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { delimiter, dirname, join } from "node:path";
import type { TexServiceConfig } from "./config.ts";
import { METRIC_COMPATIBLE, substituteFontIn } from "./fonts.ts";
import { BUILTIN_LATEXMKRC, PROJECT_RC_FILES, TEX_ENGINES, jobName, latexmkInvocation, type TexEngine } from "./latexmk.ts";
import {
  API_VERSION,
  PROJECT_ID,
  isSafeRelativePath,
  type CompileRequest,
  type CompileResponse,
  type ErrorCode,
  type InfoResponse,
  type InspectResponse,
  type SyncRequest,
  type SynctexRequest,
  type SynctexResponse,
  type TexcountRequest,
  type ToolOutput,
  type UploadRequest,
} from "./protocol.ts";
import { run, tail } from "./run.ts";

export const SERVICE_VERSION = "0.1.0";

const POPPLER = ["pdftotext", "pdffonts", "pdfinfo"] as const;
const TEXT_FILE = /\.(tex|cls|sty)$/;
const MAX_FILES = 5000;

class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const bad = (message: string) => new HttpError(400, "bad_request", message);

// TeX Live installs outside the default PATH on macOS; the container has it on PATH already.
const PATH = [...(process.env.PATH ?? "").split(delimiter), "/Library/TeX/texbin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].filter(Boolean).join(delimiter);
const toolEnv = { PATH };

function findTool(name: string): boolean {
  return PATH.split(delimiter).some((d) => existsSync(join(d, name)));
}

/** Files a project tracks: what the client uploaded, by content, and the fonts swapped in each. */
interface ProjectState {
  files: Record<string, string>;
  substituted: Record<string, string[]>;
  usedAt: number;
}

export interface TexService {
  server: Server;
  info: InfoResponse;
  /** Stops accepting requests and waits (up to `graceMs`) for builds in progress. */
  close(graceMs?: number): Promise<void>;
}

export async function createTexService(config: TexServiceConfig): Promise<TexService> {
  // The real path: TeX records the real working directory in logs and SyncTeX data (/private/var, not
  // /var, on macOS), and the root reported to clients must match it.
  await mkdir(config.dataDir, { recursive: true });
  const dataDir = await realpath(config.dataDir);
  const projectsDir = join(dataDir, "projects");
  const tmpDir = join(dataDir, "tmp");
  const rcPath = join(dataDir, "latexmkrc");
  await mkdir(projectsDir, { recursive: true });
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });
  await writeFile(rcPath, BUILTIN_LATEXMKRC);

  const info = await probe(config);
  const substitutes = info.fontSubstitutes;

  // ---- Concurrency: one operation per project at a time, and at most `concurrency` TeX runs overall.
  const projectLocks = new Map<string, Promise<unknown>>();
  function withProject<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = projectLocks.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.catch(() => {});
    projectLocks.set(id, settled);
    void settled.then(() => {
      if (projectLocks.get(id) === settled) projectLocks.delete(id);
    });
    return next;
  }
  let active = 0;
  const waiting: (() => void)[] = [];
  const maxWaiting = config.concurrency * 32;
  async function slot<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= config.concurrency) {
      if (waiting.length >= maxWaiting) throw new HttpError(503, "busy", "Too many builds are waiting; try again shortly.");
      await new Promise<void>((r) => waiting.push(r));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  }
  const inFlight = new Set<Promise<unknown>>();

  // ---- Projects on disk ------------------------------------------------------------------------------------
  const projectDir = (id: string) => join(projectsDir, id);
  const statePath = (id: string) => join(projectsDir, `${id}.json`);
  function checkId(id: string) {
    if (!PROJECT_ID.test(id)) throw bad(`Invalid project id "${id}"`);
    return id;
  }
  async function loadState(id: string): Promise<ProjectState> {
    try {
      const s = JSON.parse(await readFile(statePath(id), "utf8")) as ProjectState;
      return { files: s.files ?? {}, substituted: s.substituted ?? {}, usedAt: s.usedAt ?? 0 };
    } catch {
      return { files: {}, substituted: {}, usedAt: 0 };
    }
  }
  async function saveState(id: string, s: ProjectState) {
    s.usedAt = Date.now();
    const tmp = `${statePath(id)}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(s));
    await rename(tmp, statePath(id));
  }

  async function upload(id: string, body: UploadRequest) {
    if (!body || typeof body.files !== "object" || body.files === null) throw bad("Expected { files: { path: { sha256, data } } }");
    const entries = Object.entries(body.files);
    if (entries.length > MAX_FILES) throw bad(`At most ${MAX_FILES} files per project`);
    const state = await loadState(id);
    const root = projectDir(id);
    for (const [path, f] of entries) {
      if (!isSafeRelativePath(path)) throw bad(`Invalid file path "${path}"`);
      if (typeof f?.data !== "string" || typeof f.sha256 !== "string") throw bad(`File "${path}" needs sha256 and data`);
      const bytes = Buffer.from(f.data, "base64");
      const sha = createHash("sha256").update(bytes).digest("hex");
      if (sha !== f.sha256) throw bad(`File "${path}" doesn't match its sha256 (got ${sha})`);
      // Fonts this image doesn't have are swapped for their stand-ins in the build copy; the client's copy
      // stays as written, and the state remembers the client's content hash.
      let out: Buffer | string = bytes;
      const swapped: string[] = [];
      if (TEXT_FILE.test(path) && Object.keys(substitutes).length) {
        let text = bytes.toString("utf8");
        for (const [from, to] of Object.entries(substitutes)) {
          const next = substituteFontIn(text, from, to);
          if (next !== text) swapped.push(from);
          text = next;
        }
        if (swapped.length) out = text;
      }
      const abs = join(root, path);
      await mkdir(dirname(abs), { recursive: true });
      // A directory where a file now goes (a folder renamed to a file): replace it.
      if ((await stat(abs).catch(() => null))?.isDirectory()) await rm(abs, { recursive: true, force: true });
      await writeFile(abs, out);
      state.files[path] = sha;
      if (swapped.length) state.substituted[path] = swapped;
      else delete state.substituted[path];
    }
    await saveState(id, state);
  }

  async function sync(id: string, body: SyncRequest) {
    if (!body || typeof body.files !== "object" || body.files === null) throw bad("Expected { files: { path: sha256 } }");
    const wanted = body.files;
    if (Object.keys(wanted).length > MAX_FILES) throw bad(`At most ${MAX_FILES} files per project`);
    for (const p of Object.keys(wanted)) if (!isSafeRelativePath(p)) throw bad(`Invalid file path "${p}"`);
    const state = await loadState(id);
    const root = projectDir(id);
    // Source files that were deleted: delete their copies. Files TeX generated are left alone.
    for (const p of Object.keys(state.files)) {
      if (p in wanted) continue;
      await rm(join(root, p), { force: true });
      delete state.files[p];
      delete state.substituted[p];
    }
    const missing = Object.entries(wanted)
      .filter(([p, sha]) => state.files[p] !== sha || !existsSync(join(root, p)))
      .map(([p]) => p);
    await saveState(id, state);
    return { missing };
  }

  async function compile(id: string, body: CompileRequest, signal: AbortSignal): Promise<CompileResponse> {
    if (!body || typeof body.main !== "string" || !isSafeRelativePath(body.main)) throw bad("`main` must be a relative path in the project");
    if (!TEX_ENGINES.includes(body.engine)) throw bad(`\`engine\` must be one of ${TEX_ENGINES.join(", ")}`);
    const state = await loadState(id);
    if (!(body.main in state.files)) throw bad(`The project has no file "${body.main}": sync it first`);
    const root = projectDir(id);
    const cwd = join(root, dirname(body.main));
    const base = jobName(body.main);
    const out = (ext: string) => join(cwd, `${base}.${ext}`);
    const timeoutMs = Math.min(Math.max(1000, body.timeoutMs ?? config.maxCompileMs), config.maxCompileMs);
    const { args, env } = latexmkInvocation({
      engine: body.engine as TexEngine,
      mainFile: body.main.split("/").pop()!,
      force: !!body.force,
      trusted: !!body.trusted,
      haltOnError: !!body.haltOnError,
      builtinRc: rcPath,
      projectRcs: PROJECT_RC_FILES.filter((f) => f in state.files).map((f) => join(root, f)),
    });
    // Only files this build wrote: a failed build, or one with nothing to do, leaves the previous ones behind.
    const OUTPUTS = ["log", "blg", "pdf", "synctex.gz"];
    const mtime = async (ext: string) => (await stat(out(ext)).catch(() => null))?.mtimeMs ?? null;
    const before = new Map(await Promise.all(OUTPUTS.map(async (ext) => [ext, await mtime(ext)] as const)));
    const started = Date.now();
    const res = await slot(() => run("latexmk", args, { cwd, timeoutMs, signal, env: { ...toolEnv, ...env } }));
    if (res.error) throw new HttpError(500, "internal", `Couldn't run latexmk: ${res.error.message}`);
    const read = async (ext: string, enc: "utf8" | "base64") => {
      const now = await mtime(ext);
      return now !== null && now !== before.get(ext) ? (await readFile(out(ext))).toString(enc) : null;
    };
    const [log, blg, pdf, synctex] = await Promise.all([read("log", "utf8"), read("blg", "utf8"), read("pdf", "base64"), read("synctex.gz", "base64")]);
    await saveState(id, state);
    const substitutions = [...new Set(Object.values(state.substituted).flat())].map((from) => ({ from, to: substitutes[from] }));
    return {
      code: res.code,
      timedOut: res.timedOut,
      durationMs: Date.now() - started,
      stdout: tail(res.stdout, 60),
      stderr: tail(res.stderr, 60),
      root,
      log,
      blg,
      pdf,
      synctex,
      substitutions,
    };
  }

  async function texcount(id: string, body: TexcountRequest): Promise<ToolOutput> {
    if (!body || typeof body.main !== "string" || !isSafeRelativePath(body.main)) throw bad("`main` must be a relative path in the project");
    const state = await loadState(id);
    if (!(body.main in state.files)) throw bad(`The project has no file "${body.main}": sync it first`);
    const r = await slot(() => run("texcount", ["-inc", "-total", "-merge", "-utf8", "-sum=1,1,1", body.main], { cwd: projectDir(id), timeoutMs: 30_000, env: toolEnv }));
    if (r.error) throw new HttpError(500, "internal", "texcount isn't available");
    return { code: r.code, stdout: r.stdout, stderr: tail(r.stderr, 20) };
  }

  async function synctex(body: SynctexRequest): Promise<SynctexResponse> {
    if (!body || typeof body.synctex !== "string") throw bad("Expected { project, synctex, view | edit }");
    checkId(body.project);
    const dir = join(tmpDir, `q-${randomBytes(6).toString("hex")}`);
    await mkdir(dir);
    try {
      // SyncTeX reads <name>.synctex.gz next to the PDF path it's given; the PDF itself isn't needed.
      await writeFile(join(dir, "doc.synctex.gz"), Buffer.from(body.synctex, "base64"));
      const pdf = join(dir, "doc.pdf");
      const root = projectDir(body.project);
      let args: string[];
      if (body.view) {
        const { file, line, column = 0 } = body.view;
        if (!isSafeRelativePath(file) || !Number.isInteger(line) || line < 1 || !Number.isInteger(column)) throw bad("`view` needs a relative file and a line");
        args = ["view", "-i", `${line}:${column}:${join(root, file)}`, "-o", pdf];
      } else if (body.edit) {
        const { page, x, y } = body.edit;
        if (!Number.isInteger(page) || page < 1 || !Number.isFinite(x) || !Number.isFinite(y)) throw bad("`edit` needs a page and a point");
        args = ["edit", "-o", `${page}:${x.toFixed(2)}:${y.toFixed(2)}:${pdf}`];
      } else throw bad("Expected `view` or `edit`");
      const r = await run("synctex", args, { cwd: dir, timeoutMs: 10_000, env: toolEnv });
      if (r.error) throw new HttpError(500, "internal", "synctex isn't available");
      return { code: r.code, stdout: r.stdout, stderr: tail(r.stderr, 20), root: `${root}/` };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async function inspect(pdf: Buffer, q: URLSearchParams): Promise<InspectResponse> {
    if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw bad("The body isn't a PDF");
    const page = (name: string) => {
      const v = q.get(name);
      if (v === null) return null;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw bad(`\`${name}\` must be a page number`);
      return n;
    };
    const first = page("first");
    const last = page("last");
    const range = [...(first ? ["-f", String(first)] : []), ...(last ? ["-l", String(last)] : [])];
    const dir = join(tmpDir, `p-${randomBytes(6).toString("hex")}`);
    await mkdir(dir);
    try {
      const file = join(dir, "doc.pdf");
      await writeFile(file, pdf);
      const tool = async (cmd: string, args: string[]): Promise<ToolOutput> => {
        const r = await run(cmd, args, { timeoutMs: 15_000, env: toolEnv });
        return { code: r.error ? null : r.code, stdout: r.stdout, stderr: r.error ? `${cmd} isn't available` : tail(r.stderr, 20) };
      };
      const out: InspectResponse = {};
      await Promise.all([
        q.has("text") && tool("pdftotext", ["-enc", "UTF-8", "-nopgbrk", ...range, file, "-"]).then((r) => (out.text = r)),
        q.has("layout") && tool("pdftotext", ["-enc", "UTF-8", "-nopgbrk", "-layout", ...range, file, "-"]).then((r) => (out.layout = r)),
        q.has("fonts") && tool("pdffonts", [file]).then((r) => (out.fonts = r)),
        q.has("info") && tool("pdfinfo", ["-enc", "UTF-8", file]).then((r) => (out.info = r)),
      ]);
      return out;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async function deleteProject(id: string) {
    await rm(projectDir(id), { recursive: true, force: true });
    await rm(statePath(id), { force: true });
  }

  // Projects nobody has built for a while (the client moved on, or deleted its document).
  async function collectGarbage() {
    const cutoff = Date.now() - config.projectTtlMs;
    for (const name of await readdir(projectsDir).catch(() => [] as string[])) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      if (!PROJECT_ID.test(id) || projectLocks.has(id)) continue;
      if ((await loadState(id)).usedAt < cutoff) await withProject(id, () => deleteProject(id)).catch(() => {});
    }
    // Folders without a state file are leftovers of an interrupted delete.
    for (const name of await readdir(projectsDir).catch(() => [] as string[])) {
      if (!name.endsWith(".json") && !existsSync(statePath(name)) && !projectLocks.has(name)) await rm(projectDir(name), { recursive: true, force: true });
    }
  }
  void collectGarbage();
  const gc = setInterval(() => void collectGarbage(), 60 * 60 * 1000);
  gc.unref();

  // ---- HTTP ------------------------------------------------------------------------------------------------
  const tokenBuf = config.token ? Buffer.from(`Bearer ${config.token}`) : null;
  function authorized(req: IncomingMessage) {
    if (!tokenBuf) return true;
    const got = Buffer.from(req.headers.authorization ?? "");
    return got.length === tokenBuf.length && timingSafeEqual(got, tokenBuf);
  }

  async function body(req: IncomingMessage, type: "application/json" | "application/pdf"): Promise<Buffer> {
    // Requiring the type keeps a web page from posting here: a browser can't send these types cross-site
    // without a CORS preflight, which this service never approves.
    if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith(type)) throw new HttpError(415, "bad_request", `Expected Content-Type: ${type}`);
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > config.maxBodyBytes) throw new HttpError(413, "too_large", `The request is larger than ${config.maxBodyBytes} bytes`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > config.maxBodyBytes) throw new HttpError(413, "too_large", `The request is larger than ${config.maxBodyBytes} bytes`);
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }
  async function json<T>(req: IncomingMessage): Promise<T> {
    const raw = await body(req, "application/json");
    try {
      return JSON.parse(raw.toString("utf8")) as T;
    } catch {
      throw bad("The body isn't valid JSON");
    }
  }

  function send(res: ServerResponse, status: number, payload?: unknown) {
    if (res.headersSent || res.destroyed) return;
    if (payload === undefined) {
      res.writeHead(status, { "cache-control": "no-store" }).end();
      return;
    }
    const text = JSON.stringify(payload);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), "cache-control": "no-store" }).end(text);
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const path = url.pathname;
    if (method === "GET" && path === "/health") return send(res, 200, { ok: true });
    // Browsers attach Origin (and Sec-Fetch-Site) to cross-site requests; nothing legitimate here is a browser.
    if (req.headers.origin || req.headers["sec-fetch-site"]) throw new HttpError(403, "forbidden", "Browser requests aren't accepted");
    if (!authorized(req)) throw new HttpError(401, "unauthorized", "Missing or wrong bearer token (TEX_SERVICE_TOKEN)");

    if (method === "GET" && path === "/v1/info") return send(res, 200, info);

    // A request the client gave up on stops its build.
    const ctl = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) ctl.abort();
    });

    if (method === "POST" && path === "/v1/synctex") return send(res, 200, await synctex(await json<SynctexRequest>(req)));
    if (method === "POST" && path === "/v1/pdf/inspect") return send(res, 200, await inspect(await body(req, "application/pdf"), url.searchParams));

    const m = /^\/v1\/projects\/([^/]+)(\/(files|sync|compile|texcount))?$/.exec(path);
    if (m) {
      const id = checkId(decodeURIComponent(m[1]));
      const action = m[3];
      if (!action && method === "DELETE") {
        await withProject(id, () => deleteProject(id));
        return send(res, 204);
      }
      if (action === "files" && method === "PUT") {
        const b = await json<UploadRequest>(req);
        await withProject(id, () => upload(id, b));
        return send(res, 204);
      }
      if (action === "sync" && method === "POST") {
        const b = await json<SyncRequest>(req);
        return send(res, 200, await withProject(id, () => sync(id, b)));
      }
      if (action === "compile" && method === "POST") {
        const b = await json<CompileRequest>(req);
        return send(res, 200, await withProject(id, () => compile(id, b, ctl.signal)));
      }
      if (action === "texcount" && method === "POST") {
        const b = await json<TexcountRequest>(req);
        return send(res, 200, await withProject(id, () => texcount(id, b)));
      }
    }
    throw new HttpError(404, "not_found", `No route for ${method} ${path}`);
  }

  const server = createServer((req, res) => {
    const started = Date.now();
    const p = route(req, res).catch((e: unknown) => {
      if (e instanceof HttpError) return send(res, e.status, { error: { code: e.code, message: e.message } });
      console.error("[tex-service]", e);
      send(res, 500, { error: { code: "internal", message: "Internal error" } });
    });
    inFlight.add(p);
    void p.finally(() => {
      inFlight.delete(p);
      if (config.logRequests && req.url !== "/health") console.log(`[tex-service] ${req.method} ${req.url?.split("?")[0]} ${res.statusCode} ${Date.now() - started}ms`);
    });
  });
  // Builds can take minutes: don't let Node's defaults cut a request off.
  server.requestTimeout = config.maxCompileMs + 120_000;
  server.headersTimeout = 60_000;

  return {
    server,
    info,
    async close(graceMs = 10_000) {
      clearInterval(gc);
      await new Promise<void>((r) => server.close(() => r()));
      await Promise.race([Promise.allSettled([...inFlight]), new Promise((r) => setTimeout(r, graceMs).unref())]);
    },
  };
}

/** What this machine's toolchain has, checked once at startup. */
async function probe(config: TexServiceConfig): Promise<InfoResponse> {
  const engines = Object.fromEntries(TEX_ENGINES.map((e) => [e, findTool(e)])) as Record<TexEngine, boolean>;
  let version: string | null = null;
  if (engines.pdflatex) {
    const v = await run("pdflatex", ["--version"], { timeoutMs: 10_000, env: toolEnv });
    version = /TeX Live \d{4}/.exec(v.stdout)?.[0] ?? v.stdout.split("\n")[0] ?? null;
  }
  // Fonts fontconfig doesn't know (XeTeX looks fonts up by name through it), with a stand-in it does know.
  const fontSubstitutes: Record<string, string> = {};
  const fc = await run("fc-list", ["--format", "%{family}\n"], { timeoutMs: 20_000, env: toolEnv });
  if (!fc.error && fc.code === 0) {
    const families = new Set(fc.stdout.split(/[\n,]/).map((f) => f.trim().toLowerCase()));
    for (const [from, to] of Object.entries(METRIC_COMPATIBLE)) {
      if (!families.has(from.toLowerCase()) && families.has(to.toLowerCase())) fontSubstitutes[from] = to;
    }
  }
  return {
    service: { version: SERVICE_VERSION, api: API_VERSION },
    tex: { version, latexmk: findTool("latexmk"), engines, synctex: findTool("synctex"), texcount: findTool("texcount") },
    poppler: { missing: POPPLER.filter((t) => !findTool(t)) },
    fontSubstitutes,
    limits: { maxBodyBytes: config.maxBodyBytes, maxCompileMs: config.maxCompileMs, concurrency: config.concurrency },
  };
}
