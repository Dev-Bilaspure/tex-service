// The service end to end over real HTTP, through its client, with real TeX builds (skipped without TeX).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { after, before, test } from "node:test";
import { createTexServiceClient, memoryEntries, sha256, TexServiceError, type TexServiceClient } from "./client.ts";
import type { TexServiceConfig } from "./config.ts";
import { createTexService, type TexService } from "./server.ts";

const hasTex = (() => {
  try {
    execFileSync("latexmk", ["-v"], { env: { ...process.env, PATH: `/Library/TeX/texbin:/opt/homebrew/bin:${process.env.PATH}` }, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const needsTex = { skip: !hasTex && "TeX isn't installed" };

const sample = readFileSync(new URL("./fixtures/sample.tex", import.meta.url), "utf8");

let dataDir = "";
let svc: TexService;
let base = "";
let client: TexServiceClient;

async function start(extra: Partial<TexServiceConfig> = {}) {
  const config: TexServiceConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir: realpathSync(mkdtempSync(join(tmpdir(), "tex-service-test-"))),
    concurrency: 2,
    maxCompileMs: 120_000,
    maxBodyBytes: 4 * 1024 * 1024,
    projectTtlMs: 60_000,
    logRequests: false,
    ...extra,
  };
  const s = await createTexService(config);
  await new Promise<void>((r) => s.server.listen(0, "127.0.0.1", r));
  return { s, config, url: `http://127.0.0.1:${(s.server.address() as AddressInfo).port}` };
}

before(async () => {
  const started = await start();
  svc = started.s;
  dataDir = started.config.dataDir;
  base = started.url;
  client = createTexServiceClient({ url: base });
});
after(async () => {
  await svc.close(0);
  rmSync(dataDir, { recursive: true, force: true });
});

test("health is open; info describes the toolchain", async () => {
  assert.equal((await fetch(`${base}/health`)).status, 200);
  const info = await client.info();
  assert.equal(info.service.api, 1);
  assert.equal(info.tex.latexmk, hasTex);
  assert.deepEqual(Object.keys(info.tex.engines).sort(), ["latex", "lualatex", "pdflatex", "xelatex"]);
});

test("browser requests and wrong content types are refused", async () => {
  const fromPage = await fetch(`${base}/v1/info`, { headers: { origin: "https://evil.example" } });
  assert.equal(fromPage.status, 403);
  const plain = await fetch(`${base}/v1/projects/p1/compile`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
  assert.equal(plain.status, 415);
});

test("a token, when set, is required", async () => {
  const { s, config, url } = await start({ token: "s3cret" });
  try {
    const anon = createTexServiceClient({ url });
    await assert.rejects(anon.info(), (e: TexServiceError) => e.code === "unauthorized");
    assert.equal((await createTexServiceClient({ url, token: "s3cret" }).info()).service.api, 1);
  } finally {
    await s.close(0);
    rmSync(config.dataDir, { recursive: true, force: true });
  }
});

test("paths, ids and hashes are checked", async () => {
  await assert.rejects(client.sync("p-bad", memoryEntries({ "../escape.tex": "x" })), (e: TexServiceError) => e.status === 400 && /Invalid file path/.test(e.message));
  await assert.rejects(client.sync("p-bad", memoryEntries({ "/etc/passwd": "x" })), (e: TexServiceError) => e.status === 400);
  await assert.rejects(client.compile("..", { main: "main.tex", engine: "pdflatex" }), (e: TexServiceError) => e.status === 400 || e.status === 404);
  const wrong = await fetch(`${base}/v1/projects/p-bad/files`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ files: { "a.tex": { sha256: sha256("other"), data: Buffer.from("a").toString("base64") } } }),
  });
  assert.equal(wrong.status, 400);
  await assert.rejects(client.compile("p-empty", { main: "main.tex", engine: "pdflatex" }), /sync it first/);
});

test("too-large requests are refused", async () => {
  await assert.rejects(client.sync("p-big", memoryEntries({ "big.bin": Buffer.alloc(5 * 1024 * 1024) })), (e: TexServiceError) => e.status === 413);
});

test("an unreachable service is explained", async () => {
  const gone = createTexServiceClient({ url: "http://127.0.0.1:9" });
  await assert.rejects(gone.info(), (e: TexServiceError) => e.code === "unreachable" && /Is it running\?/.test(e.message));
  const hinted = createTexServiceClient({ url: "http://127.0.0.1:9", unreachableHint: "Start it with docker compose up -d." });
  await assert.rejects(hinted.info(), /Start it with docker compose up -d\./);
});

test("sync uploads only what changed and deletes what's gone", async () => {
  const urls: string[] = [];
  const counting = createTexServiceClient({ url: base, fetch: (input, init) => (urls.push(`${init?.method} ${String(input).replace(base, "")}`), fetch(input, init)) });
  await counting.sync("p-sync", memoryEntries({ "main.tex": "a", "sub/part.tex": "b" }));
  assert.ok(existsSync(join(dataDir, "projects/p-sync/sub/part.tex")));
  urls.length = 0;
  await counting.sync("p-sync", memoryEntries({ "main.tex": "a2" }));
  assert.deepEqual(urls, ["PUT /v1/projects/p-sync/files", "POST /v1/projects/p-sync/sync"]);
  assert.equal(readFileSync(join(dataDir, "projects/p-sync/main.tex"), "utf8"), "a2");
  assert.ok(!existsSync(join(dataDir, "projects/p-sync/sub/part.tex")), "a deleted source is deleted");
  urls.length = 0;
  await counting.sync("p-sync", memoryEntries({ "main.tex": "a2" }));
  assert.deepEqual(urls, ["POST /v1/projects/p-sync/sync"], "nothing changed: nothing uploaded");
  // A fresh client (an app restart) learns from the service what it's missing.
  const fresh = createTexServiceClient({ url: base });
  await fresh.sync("p-sync", memoryEntries({ "main.tex": "a2", "new.tex": "n" }));
  assert.equal(readFileSync(join(dataDir, "projects/p-sync/new.tex"), "utf8"), "n");
});

test("a build returns the log, PDF and SyncTeX; SyncTeX and PDF queries work", needsTex, async () => {
  await client.sync("p-sample", memoryEntries({ "main.tex": sample }));
  const r = await client.compile("p-sample", { main: "main.tex", engine: "pdflatex" });
  assert.equal(r.code, 0, r.stdout);
  assert.ok(r.pdf && Buffer.from(r.pdf, "base64").subarray(0, 5).toString() === "%PDF-");
  assert.match(r.log ?? "", /Output written on main\.pdf/);
  assert.ok(r.root.endsWith("/projects/p-sample"));
  const stx = gunzipSync(Buffer.from(r.synctex!, "base64")).toString();
  assert.match(stx, new RegExp(`Input:1:${r.root}/\\./main\\.tex`));

  // Unchanged sources: latexmk has nothing to do and writes no new PDF.
  const again = await client.compile("p-sample", { main: "main.tex", engine: "pdflatex" });
  assert.equal(again.code, 0);
  assert.equal(again.pdf, null);
  // Forced: it really runs TeX.
  assert.ok((await client.compile("p-sample", { main: "main.tex", engine: "pdflatex", force: true })).pdf);

  const line = sample.split("\n").findIndex((l) => l.includes("\\item")) + 1;
  const view = await client.synctex({ project: "p-sample", synctex: r.synctex!, view: { file: "main.tex", line } });
  assert.match(view.stdout, /Page:1/);
  const edit = await client.synctex({ project: "p-sample", synctex: r.synctex!, edit: { page: 1, x: 100, y: 200 } });
  assert.match(edit.stdout, new RegExp(`Input:${view.root}\\./main\\.tex`));

  const pdf = Buffer.from(r.pdf!, "base64");
  const inspected = await client.inspectPdf(pdf, { text: true, info: true, fonts: true });
  assert.equal(inspected.text?.code, 0);
  assert.ok((inspected.text?.stdout.length ?? 0) > 200);
  assert.match(inspected.info?.stdout ?? "", /Pages:\s+1/);
  assert.equal(inspected.layout, undefined);
  const page1 = await client.inspectPdf(pdf, { text: true, first: 1, last: 1 });
  assert.equal(page1.text?.stdout.trim(), inspected.text?.stdout.trim(), "a page range: the one page");
  const none = await client.inspectPdf(pdf, { text: true, first: 2, last: 2 });
  assert.notEqual(none.text?.code, 0, "no page 2");
  await assert.rejects(client.inspectPdf(Buffer.from("not a pdf"), { text: true }), /isn't a PDF/);

  const wc = await client.texcount("p-sample", "main.tex");
  assert.match(wc.stdout, /Words in text: \d+/);
});

test("a broken document reports its errors and no PDF", needsTex, async () => {
  await client.sync("p-broken", memoryEntries({ "main.tex": "\\documentclass{article}\n\\begin{document}\n\\undefinedmacro\n\\end{document}\n" }));
  const r = await client.compile("p-broken", { main: "main.tex", engine: "pdflatex", haltOnError: true });
  assert.notEqual(r.code, 0);
  assert.equal(r.pdf, null);
  assert.match(r.log ?? "", /main\.tex:3: Undefined control sequence/);
});

test("a main file in a subfolder builds in its folder", needsTex, async () => {
  await client.sync("p-nested", memoryEntries({ "cv/main.tex": "\\documentclass{article}\n\\begin{document}\n\\input{part}\n\\end{document}\n", "cv/part.tex": "Hello." }));
  const r = await client.compile("p-nested", { main: "cv/main.tex", engine: "pdflatex" });
  assert.equal(r.code, 0, r.stdout);
  assert.ok(r.pdf);
});

test("a deleted project is gone", async () => {
  await client.sync("p-del", memoryEntries({ "main.tex": "x" }));
  await client.deleteProject("p-del");
  assert.ok(!existsSync(join(dataDir, "projects/p-del")));
  assert.ok(!existsSync(join(dataDir, "projects/p-del.json")));
});

test("a build that never ends is stopped at its time limit", needsTex, async () => {
  await client.sync("p-loop", memoryEntries({ "main.tex": "\\documentclass{article}\n\\begin{document}\n\\loop\\iftrue\\repeat\n\\end{document}\n" }));
  const t0 = Date.now();
  const r = await client.compile("p-loop", { main: "main.tex", engine: "pdflatex", timeoutMs: 3000 });
  assert.equal(r.timedOut, true);
  assert.equal(r.pdf, null);
  assert.ok(Date.now() - t0 < 15_000, "killed, not left running");
  const ps = execFileSync("ps", ["-axo", "command"]).toString();
  assert.ok(!/pdflatex.*p-loop|projects\/p-loop/.test(ps), "no TeX process left behind");
});
