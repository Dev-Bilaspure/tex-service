// A client for the compile service (see protocol.ts). Keeps track of what each project on the service
// already has, so a build uploads only the files that changed since the last one.
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  CompileRequest,
  CompileResponse,
  ErrorBody,
  ErrorCode,
  InfoResponse,
  InspectOptions,
  InspectResponse,
  SyncResponse,
  SynctexRequest,
  SynctexResponse,
  ToolOutput,
} from "./protocol.ts";

export type TexServiceErrorCode = ErrorCode | "unreachable" | "timeout" | "protocol";

export class TexServiceError extends Error {
  readonly code: TexServiceErrorCode;
  readonly status: number | null;
  constructor(code: TexServiceErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "TexServiceError";
    this.code = code;
    this.status = status;
  }
}

export interface TexServiceClientOptions {
  /** e.g. http://127.0.0.1:4380 */
  url: string;
  token?: string;
  /** For tests. */
  fetch?: typeof fetch;
}

/** A file to send: its path in the project and a way to read it. */
export interface SourceEntry {
  path: string;
  read(): Promise<Buffer>;
  /** Known content hash (skips reading when the service already has it). */
  sha256?: string;
}

const UPLOAD_BATCH_BYTES = 8 * 1024 * 1024;

export interface TexServiceClient {
  readonly url: string;
  info(signal?: AbortSignal): Promise<InfoResponse>;
  /** Makes the project hold exactly these files (uploading only what changed). */
  sync(project: string, files: SourceEntry[], signal?: AbortSignal): Promise<void>;
  compile(project: string, req: CompileRequest, signal?: AbortSignal): Promise<CompileResponse>;
  texcount(project: string, main: string): Promise<ToolOutput>;
  synctex(req: SynctexRequest): Promise<SynctexResponse>;
  inspectPdf(pdf: Buffer, opts: InspectOptions): Promise<InspectResponse>;
  deleteProject(project: string): Promise<void>;
}

export function createTexServiceClient(opts: TexServiceClientOptions): TexServiceClient {
  const base = opts.url.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  // What each project on the service holds, as far as this process knows (path → sha256). Only a hint: the
  // service says what it's missing, e.g. after its data volume was reset.
  const known = new Map<string, Map<string, string>>();

  async function request<T>(method: string, path: string, init: { json?: unknown; pdf?: Buffer; signal?: AbortSignal; timeoutMs: number }): Promise<T> {
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    let body: string | Uint8Array<ArrayBuffer> | undefined;
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.json);
    } else if (init.pdf) {
      headers["content-type"] = "application/pdf";
      body = new Uint8Array(init.pdf);
    }
    const timeout = AbortSignal.timeout(init.timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await doFetch(base + path, { method, headers, body, signal });
    } catch (e) {
      if (timeout.aborted) throw new TexServiceError("timeout", `The compile service at ${base} didn't answer within ${Math.round(init.timeoutMs / 1000)}s`);
      if (init.signal?.aborted) throw e;
      throw new TexServiceError("unreachable", `Can't reach the compile service at ${base} (${describe(e)}). Start it with \`docker compose up -d\` in the repository folder.`);
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      let code: TexServiceErrorCode = res.status === 401 ? "unauthorized" : res.status >= 500 ? "internal" : "bad_request";
      try {
        const err = (JSON.parse(text) as ErrorBody).error;
        if (err?.message) msg = err.message;
        if (err?.code) code = err.code;
      } catch {
        // Not our JSON (a proxy's error page).
      }
      throw new TexServiceError(code, `Compile service: ${msg}`, res.status);
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new TexServiceError("protocol", `The compile service at ${base} sent something that isn't JSON. Is that the right URL?`, res.status);
    }
  }

  const project = (id: string) => `/v1/projects/${encodeURIComponent(id)}`;

  async function upload(id: string, entries: { path: string; sha: string; bytes: Buffer }[], signal?: AbortSignal) {
    let batch: Record<string, { sha256: string; data: string }> = {};
    let size = 0;
    const flush = async () => {
      if (!size && !Object.keys(batch).length) return;
      await request("PUT", `${project(id)}/files`, { json: { files: batch }, signal, timeoutMs: 120_000 });
      batch = {};
      size = 0;
    };
    for (const e of entries) {
      if (size && size + e.bytes.length > UPLOAD_BATCH_BYTES) await flush();
      batch[e.path] = { sha256: e.sha, data: e.bytes.toString("base64") };
      size += e.bytes.length;
    }
    await flush();
  }

  return {
    url: base,

    info: (signal) => request<InfoResponse>("GET", "/v1/info", { signal, timeoutMs: 10_000 }),

    async sync(id, files, signal) {
      const have = known.get(id) ?? new Map<string, string>();
      // Hash everything (cheap next to a TeX run); keep the bytes of what has to go up.
      const hashed = await Promise.all(
        files.map(async (f) => {
          if (f.sha256 && have.get(f.path) === f.sha256) return { path: f.path, sha: f.sha256, bytes: null as Buffer | null };
          const bytes = await f.read();
          return { path: f.path, sha: f.sha256 ?? sha256(bytes), bytes };
        }),
      );
      const manifest = Object.fromEntries(hashed.map((h) => [h.path, h.sha]));
      const byPath = new Map(hashed.map((h) => [h.path, h]));
      const bytesOf = async (p: string) => byPath.get(p)!.bytes ?? (await files.find((f) => f.path === p)!.read());

      await upload(
        id,
        hashed.filter((h) => have.get(h.path) !== h.sha && h.bytes).map((h) => ({ path: h.path, sha: h.sha, bytes: h.bytes! })),
        signal,
      );
      for (let attempt = 0; ; attempt++) {
        const { missing } = await request<SyncResponse>("POST", `${project(id)}/sync`, { json: { files: manifest }, signal, timeoutMs: 60_000 });
        if (!missing.length) break;
        if (attempt === 2) throw new TexServiceError("protocol", `The compile service kept asking for ${missing.slice(0, 3).join(", ")}`);
        await upload(id, await Promise.all(missing.map(async (p) => ({ path: p, sha: manifest[p], bytes: await bytesOf(p) }))), signal);
      }
      known.set(id, new Map(Object.entries(manifest)));
    },

    compile: (id, req, signal) =>
      // The build's own limit, plus time waiting for a free slot and moving the PDF.
      request<CompileResponse>("POST", `${project(id)}/compile`, { json: req, signal, timeoutMs: (req.timeoutMs ?? 300_000) + 180_000 }),

    texcount: (id, main) => request<ToolOutput>("POST", `${project(id)}/texcount`, { json: { main }, timeoutMs: 90_000 }),

    synctex: (req) => request<SynctexResponse>("POST", "/v1/synctex", { json: req, timeoutMs: 30_000 }),

    inspectPdf(pdf, o) {
      const q = new URLSearchParams();
      for (const k of ["text", "layout", "fonts", "info"] as const) if (o[k]) q.set(k, "");
      if (o.first) q.set("first", String(o.first));
      if (o.last) q.set("last", String(o.last));
      return request<InspectResponse>("POST", `/v1/pdf/inspect?${q}`, { pdf, timeoutMs: 60_000 });
    },

    async deleteProject(id) {
      known.delete(id);
      await request("DELETE", project(id), { timeoutMs: 30_000 });
    },
  };
}

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function describe(e: unknown): string {
  const cause = (e as { cause?: { code?: string; message?: string } }).cause;
  return cause?.code ?? cause?.message ?? (e as Error).message;
}

// ---- Folders -------------------------------------------------------------------------------------------------

/** Content hashes of files on disk, reused while a file's size and modification time are unchanged. */
const hashCache = new Map<string, { sig: string; sha: string }>();

/**
 * The files of a folder, as sync entries. `include(path, name, isDirectory)` decides what's part of the
 * project (default: everything but hidden files and folders).
 */
export async function folderEntries(dir: string, include: (path: string, name: string, isDirectory: boolean) => boolean = (_p, n) => !n.startsWith(".")): Promise<SourceEntry[]> {
  const out: SourceEntry[] = [];
  async function walk(rel: string) {
    for (const e of await readdir(join(dir, rel), { withFileTypes: true }).catch(() => [])) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (!include(path, e.name, e.isDirectory())) continue;
      if (e.isDirectory()) await walk(path);
      else if (e.isFile()) {
        const abs = join(dir, path);
        const st = await stat(abs).catch(() => null);
        if (!st) continue;
        const sig = `${st.size}:${st.mtimeMs}`;
        const cached = hashCache.get(abs);
        let sha = cached?.sig === sig ? cached.sha : undefined;
        if (!sha) {
          const bytes = await readFile(abs);
          sha = sha256(bytes);
          if (hashCache.size > 50_000) hashCache.clear();
          hashCache.set(abs, { sig, sha });
        }
        out.push({ path, sha256: sha, read: () => readFile(abs) });
      }
    }
  }
  await walk("");
  return out;
}

/** In-memory files (a tailoring draft) as sync entries. */
export function memoryEntries(files: Record<string, string | Buffer>): SourceEntry[] {
  return Object.entries(files).map(([path, content]) => {
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    return { path, sha256: sha256(bytes), read: async () => bytes };
  });
}
