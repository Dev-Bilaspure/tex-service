// The compile service's HTTP API: request and response bodies, shared by the server and the client.
//
//   GET    /health                          liveness (no auth)
//   GET    /v1/info                         what the toolchain has: TeX Live version, engines, poppler
//   PUT    /v1/projects/:id/files           upload files  { files: { path: { sha256, data (base64) } } }
//   POST   /v1/projects/:id/sync            the full file list { files: { path: sha256 } } → { missing }
//   POST   /v1/projects/:id/compile         run latexmk → log, PDF, SyncTeX
//   POST   /v1/projects/:id/texcount        word count
//   DELETE /v1/projects/:id                 drop the project and its build files
//   POST   /v1/synctex                      SyncTeX query against a build's .synctex.gz
//   POST   /v1/pdf/inspect                  pdftotext / pdffonts / pdfinfo on a PDF (body: the PDF)
//
// A project is a folder on the service: your sources plus what TeX generated, kept between builds so
// they're incremental. Files are content-addressed (sha256), so a build uploads only what changed.

import type { TexEngine } from "./latexmk.ts";

export const DEFAULT_PORT = 4380;
export const API_VERSION = 1;

/** Project ids: chosen by the client, one per build folder. */
export const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ErrorBody {
  error: { code: ErrorCode; message: string };
}
export type ErrorCode = "bad_request" | "unauthorized" | "forbidden" | "not_found" | "too_large" | "busy" | "internal";

export interface InfoResponse {
  service: { version: string; api: number };
  tex: {
    /** e.g. "TeX Live 2026". */
    version: string | null;
    latexmk: boolean;
    engines: Record<TexEngine, boolean>;
    synctex: boolean;
    texcount: boolean;
  };
  poppler: { missing: string[] };
  /** Fonts this image doesn't have, and the metric-compatible stand-in a build uses instead. */
  fontSubstitutes: Record<string, string>;
  limits: { maxBodyBytes: number; maxCompileMs: number; concurrency: number };
}

export interface UploadRequest {
  files: Record<string, { sha256: string; data: string }>;
}

export interface SyncRequest {
  /** Every source file the project should have; the service deletes the ones it had that aren't listed. */
  files: Record<string, string>;
}
export interface SyncResponse {
  /** Listed files the service doesn't have with that content: upload them, then sync again. */
  missing: string[];
}

export interface CompileRequest {
  /** The main file, relative to the project root (may be in a subfolder). */
  main: string;
  engine: TexEngine;
  force?: boolean;
  trusted?: boolean;
  haltOnError?: boolean;
  /** Capped by the service's own limit. */
  timeoutMs?: number;
}

export interface CompileResponse {
  /** latexmk's exit code (null if it was killed). */
  code: number | null;
  timedOut: boolean;
  durationMs: number;
  /** The end of latexmk's output. */
  stdout: string;
  stderr: string;
  /**
   * The project's absolute path on the service. Paths in the log and the SyncTeX data start with it;
   * a client maps them back to its own folder.
   */
  root: string;
  /** TeX's log and the bibliography tool's (.blg), when this build wrote them. */
  log: string | null;
  blg: string | null;
  /** Written by this build (base64), or null. */
  pdf: string | null;
  synctex: string | null;
  /** Fonts named in the sources that this build replaced with a metric-compatible stand-in. */
  substitutions: { from: string; to: string }[];
}

export interface TexcountRequest {
  main: string;
}
export interface ToolOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface SynctexRequest {
  /** The project the SyncTeX data was built in (it records the project's paths). */
  project: string;
  /** The build's .synctex.gz, base64. */
  synctex: string;
  /** Source position → PDF boxes. `file` is relative to the project root. */
  view?: { file: string; line: number; column?: number };
  /** PDF point (page, x, y in points from the top left) → source position. */
  edit?: { page: number; x: number; y: number };
}
export interface SynctexResponse extends ToolOutput {
  /** The project root (with a trailing slash) as the SyncTeX output names it. */
  root: string;
}

/** Query flags for /v1/pdf/inspect, e.g. ?text&layout&fonts&info&first=2&last=3. */
export interface InspectOptions {
  text?: boolean;
  layout?: boolean;
  fonts?: boolean;
  info?: boolean;
  /** Page range for text and layout. */
  first?: number;
  last?: number;
}
export interface InspectResponse {
  text?: ToolOutput;
  layout?: ToolOutput;
  fonts?: ToolOutput;
  info?: ToolOutput;
}

/** A relative path inside a project: no absolute paths, no "..", no hidden tricks. */
export function isSafeRelativePath(p: string): boolean {
  if (!p || p.length > 1024 || p.includes("\0") || p.includes("\\")) return false;
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}
