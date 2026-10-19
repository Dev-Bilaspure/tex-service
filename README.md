# tex-service

**TeX Live as an HTTP compile service.** The complete TeX Live 2026, latexmk, SyncTeX, texcount and poppler
in one container, behind a small JSON API, with a typed TypeScript client. Send a project's files, get back
the PDF, the log and SyncTeX data. Builds are incremental and the same on every machine.

- **The real thing:** TeX Live 2026, full scheme (what Overleaf and MacTeX ship), pinned by digest.
  pdfLaTeX, XeLaTeX, LuaLaTeX and LaTeX → DVI → PDF; biber and BibTeX, makeindex, glossaries and
  nomenclature through latexmk.
- **Incremental:** each project keeps its build files between compiles, and uploads are content-addressed,
  so a rebuild sends only the files that changed.
- **More than a PDF:** SyncTeX in both directions (source line ↔ PDF position), word counts (texcount) and
  PDF inspection (text, layout text, fonts, page count) with poppler.
- **Fonts that work:** TeX Live's own fonts are registered with fontconfig, as on Overleaf, so XeLaTeX finds
  Roboto, Lato, Fira and the rest by name. Documents that name Arial, Helvetica, Times New Roman, Courier New,
  Calibri or Cambria build with metric-compatible free fonts (same line and page breaks), and the build says
  so.
- **Safe by default:** restricted shell escape, a token required off loopback, browser requests refused,
  time, size and process limits, and an unprivileged, read-only container.
- **amd64 and arm64**, native on both.

## Quick start

```sh
docker run -d --name tex -p 127.0.0.1:4380:4380 \
  -e TEX_SERVICE_ALLOW_UNAUTHENTICATED=1 \
  -v tex-data:/data \
  devbilaspure/tex-service:0.1

curl http://127.0.0.1:4380/health        # {"ok":true}
curl http://127.0.0.1:4380/v1/info       # TeX Live version, engines, fonts, limits
```

`TEX_SERVICE_ALLOW_UNAUTHENTICATED=1` is safe here only because the port is published on `127.0.0.1`.
Anywhere others can reach it, use a token instead:

```sh
docker run -d -p 4380:4380 -e TEX_SERVICE_TOKEN="$(openssl rand -hex 32)" -v tex-data:/data \
  devbilaspure/tex-service:0.1
```

Or with Docker Compose, using the hardened settings in [docker-compose.yml](docker-compose.yml)
(read-only filesystem, no capabilities, process and memory limits):

```sh
docker compose up -d
```

The image is about 2.8 GB to download (the full TeX Live).

## Compiling a document

With the TypeScript client (Node 24+):

```ts
import { writeFile } from "node:fs/promises";
import { createTexServiceClient, memoryEntries } from "tex-service";

const tex = createTexServiceClient({ url: "http://127.0.0.1:4380", token: process.env.TEX_SERVICE_TOKEN });

// A project is a folder on the service; "report" is your name for it.
await tex.sync("report", memoryEntries({ "main.tex": "\\documentclass{article}\\begin{document}Hello\\end{document}" }));
const build = await tex.compile("report", { main: "main.tex", engine: "pdflatex" });

if (build.code === 0 && build.pdf) {
  await writeFile("main.pdf", Buffer.from(build.pdf, "base64"));
} else {
  console.error(build.log); // TeX's log: errors with file:line
}
```

`folderEntries(dir)` syncs a folder from disk instead, re-hashing only files whose size or time changed. The
client remembers what each project already has, so later syncs upload only what changed, and the service
tells it if anything's missing (after its volume was reset, say).

Until the npm package is published, install the client from GitHub: `npm install github:Dev-Bilaspure/tex-service`.

### Over plain HTTP

Upload files, sync the full list, compile:

```sh
B64=$(base64 < main.tex | tr -d '\n') SHA=$(shasum -a 256 main.tex | cut -d' ' -f1)
curl -X PUT  localhost:4380/v1/projects/report/files   -H 'content-type: application/json' \
     -d "{\"files\":{\"main.tex\":{\"sha256\":\"$SHA\",\"data\":\"$B64\"}}}"
curl -X POST localhost:4380/v1/projects/report/sync    -H 'content-type: application/json' \
     -d "{\"files\":{\"main.tex\":\"$SHA\"}}"            # → {"missing":[]}
curl -X POST localhost:4380/v1/projects/report/compile -H 'content-type: application/json' \
     -d '{"main":"main.tex","engine":"pdflatex"}' | jq -r .pdf | base64 -d > main.pdf
```

Add `-H "authorization: Bearer $TEX_SERVICE_TOKEN"` when the service has a token.

## API

All bodies are JSON (`application/json`), except `/v1/pdf/inspect`, which takes the PDF itself
(`application/pdf`). Errors are `{ "error": { "code", "message" } }` with a matching status. Types:
[`src/protocol.ts`](src/protocol.ts).

| Method and path | Body → response |
|---|---|
| `GET /health` | → `{ ok: true }`. No token needed: for health checks. |
| `GET /v1/info` | → TeX Live version, engines, SyncTeX and texcount availability, missing poppler tools, font stand-ins, limits, security settings |
| `PUT /v1/projects/:id/files` | `{ files: { "<path>": { sha256, data } } }` (data in base64) → 204. Paths are relative; files are checked against their SHA-256. |
| `POST /v1/projects/:id/sync` | `{ files: { "<path>": "<sha256>" } }`: the project's complete file list. Deletes files no longer listed (build files are kept) → `{ missing: [paths] }`: upload those, then sync again. |
| `POST /v1/projects/:id/compile` | `{ main, engine, force?, haltOnError?, trusted?, timeoutMs? }` → `{ code, timedOut, durationMs, stdout, stderr, root, log, blg, pdf, synctex, substitutions }`. `engine`: `pdflatex`, `xelatex`, `lualatex` or `latex`. `pdf` and `synctex` (base64) are only present when this build wrote them. `root` is the project's path on the service: paths in the log and SyncTeX data start with it. `trusted` (full shell escape and the project's own latexmkrc) is refused unless the service allows it. |
| `POST /v1/projects/:id/texcount` | `{ main }` → texcount's output (words in text, headers, captions) |
| `DELETE /v1/projects/:id` | → 204: drops the project and its build files |
| `POST /v1/synctex` | `{ project, synctex, view: { file, line, column? } }` (source → PDF boxes) or `{ project, synctex, edit: { page, x, y } }` (PDF point → source) → SyncTeX's output and the project root. `synctex` is a build's `.synctex.gz` in base64, so old builds can be queried too. |
| `POST /v1/pdf/inspect?text&layout&fonts&info&first=&last=` | body: a PDF → `pdftotext` (reading order, and `layout`), `pdffonts` and `pdfinfo` output; `first`/`last` select pages |

Project ids are 1–128 characters of letters, digits, `.`, `_` and `-`. A project is a folder holding your
sources and what TeX generated; it lives until it's deleted, or until it hasn't been built for
`TEX_SERVICE_PROJECT_TTL_DAYS`.

Builds run latexmk in the main file's folder, like Overleaf (`latexmk -cd`), carry on past errors unless
`haltOnError` is set (so the PDF is as complete as it can be), and load built-in rules for glossaries,
nomenclature and DVI → PDF with dvipdfmx. `force` makes latexmk rebuild even when it thinks nothing changed.

## Configuration

Environment variables:

| Variable | Default | |
|---|---|---|
| `TEX_SERVICE_TOKEN` | none | Bearer token clients must send (`Authorization: Bearer …`). Required on any address but loopback. |
| `TEX_SERVICE_ALLOW_UNAUTHENTICATED` | off | Serve without a token on a non-loopback address. Only when the port is reachable from this machine alone. |
| `TEX_SERVICE_ALLOW_SHELL_ESCAPE` | off | Allow `trusted` builds: full shell escape, so a document can run any command in the container. |
| `TEX_SERVICE_CONCURRENCY` | CPUs, at most 4 | Builds running at once; more wait their turn (and a long queue is refused with 503). |
| `TEX_SERVICE_MAX_COMPILE_SECONDS` | 300 | Upper limit for one build, whatever the client asks. |
| `TEX_SERVICE_MAX_BODY_MB` | 64 | Largest request. |
| `TEX_SERVICE_PROJECT_TTL_DAYS` | 14 | Projects not built for this long are deleted. |
| `TEX_SERVICE_LOG_REQUESTS` | on | One line per request on stdout; `0` for errors only. |
| `TEX_SERVICE_DATA` | `/data` in the image | Projects and TeX's caches. Mount a volume here to keep them across restarts. |
| `HOST`, `PORT` | `0.0.0.0`, `4380` in the image | |

## Security

TeX is a programming language, and this service runs whatever it's sent. Read [SECURITY.md](SECURITY.md)
before exposing it to anyone else; in short: keep shell escape off unless you trust every client, always use
a token off loopback, give the container memory and CPU limits, and run separate services for parties that
must not see each other's files.

## Operating it

- **Data:** `/data` holds every project's sources and build files, plus TeX's caches (LuaTeX's font database
  takes a minute to build the first time). Keep it on a volume. It's a cache: deleting it costs one full
  rebuild per project, and the client re-uploads what's missing.
- **Limits:** a build that runs too long is killed with everything it started. Set memory and CPU limits on
  the container (`--memory 4g --cpus 2`, or `mem_limit` in Compose), since a document can be made to use a
  lot of either.
- **Health:** the image has a `HEALTHCHECK` on `/health`; use it, or `GET /health`, from your orchestrator.
- **Signals:** on `SIGTERM` the service stops accepting requests and lets running builds finish (up to 10 s).
  Run with `--init` (or `init: true`) so TeX's processes are reaped.
- **Updating TeX Live:** each release pins its TeX Live by digest. A new TeX Live comes as a new version of
  this image, never silently.

## Tags

| Tag | |
|---|---|
| `0.1.0` | exactly this release |
| `0.1`, `0` | the latest release in that series |
| `latest` | the latest release |

Images are published to [Docker Hub](https://hub.docker.com/r/devbilaspure/tex-service)
(`devbilaspure/tex-service`) and GitHub Container Registry (`ghcr.io/dev-bilaspure/tex-service`), for
`linux/amd64` and `linux/arm64`, with provenance and an SBOM.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test          # the API over real HTTP with real builds; needs TeX Live and poppler (tests that need TeX skip without it)
pnpm docker:test   # builds the image and runs the tests inside it, no local TeX needed
pnpm start         # runs the service from source on 127.0.0.1:4380 with this machine's TeX
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). The image also contains TeX Live, poppler, fonts and Node.js under their own licenses: see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
