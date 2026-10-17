# tex-service

Resume Studio's compile service: the complete TeX Live 2026 (the distribution Overleaf and MacTeX use),
latexmk, SyncTeX, texcount and poppler in one container, behind a small HTTP API. The editor and the
tailoring engine use it to build resumes on any OS without installing TeX, and get the same results as
a local TeX Live. Builds are the same either way: the latexmk command line, the built-in latexmkrc and the
log handling are shared with local builds (`src/latexmk.ts`).

## Run

From the repository root:

```sh
docker compose up -d          # builds the image the first time (TeX Live is a few GB), then starts it
docker compose logs -f tex    # one line per request
docker compose down           # stop (build caches stay in the tex-data volume)
```

The app finds it on its own: with `RESUME_STUDIO_COMPILER=auto` (the default), it builds with this
machine's TeX when `latexmk` is installed and with the service otherwise. To always use the service,
put `RESUME_STUDIO_COMPILER=service` in `apps/web/.env.local`.

| App setting | |
|---|---|
| `RESUME_STUDIO_COMPILER` | `auto` (default), `local` or `service` |
| `RESUME_STUDIO_COMPILER_URL` | default `http://127.0.0.1:4380` |
| `RESUME_STUDIO_COMPILER_TOKEN` | if the service has a token |

The CLI, the MCP server and the evaluation harness use it the same way: when `TAILOR_TEX_SERVICE_URL`
is set, or when TeX isn't installed (then at the default address).

## What's in the image

- TeX Live 2026, full scheme, pinned by digest (`texlive/texlive:latest-full`), native on amd64 and arm64.
- poppler (pdftotext, pdfinfo, pdffonts) for page counts and the ATS checks.
- Fonts: TeX Live's own fonts registered with fontconfig, as on Overleaf, so XeLaTeX finds Roboto, Lato,
  Fira, Source Sans and the rest by name. Commercial fonts a resume may name (Arial, Helvetica, Times New
  Roman, Courier New, Calibri, Cambria) aren't there; the build uses a free font with the same character
  widths (Liberation, Carlito, Caladea), so lines and pages break the same way, and says so in the build's
  notes. Your file is not changed.

## Security

The service compiles whatever it's sent, so it's meant for this machine only:

- Compose publishes the port on `127.0.0.1` only.
- Requests from web pages are refused: anything with an `Origin` or `Sec-Fetch-Site` header gets 403, and
  bodies must be `application/json` or `application/pdf`, which a page can't send cross-site without a
  CORS preflight the service never approves.
- `TEX_SERVICE_TOKEN` adds a bearer token, for anything beyond loopback.
- In the container: an unprivileged user, a read-only root filesystem, no capabilities, no privilege
  escalation, a process limit, and `init` to reap TeX's processes. TeX's own protections stay on: it
  writes only inside the project (`openout_any=p`), with restricted shell escape unless the project is
  trusted.
- Paths are checked (relative, no `..`), files are verified by sha256, bodies are size-limited, and a
  build is killed with everything it started when it runs past its time limit or the client gives up.

## Service settings

| | default | |
|---|---|---|
| `PORT`, `HOST` | `4380`, `127.0.0.1` (`0.0.0.0` in the image) | |
| `TEX_SERVICE_TOKEN` | none | bearer token clients must send |
| `TEX_SERVICE_DATA` | `./tex-service-data` (`/data` in the image) | projects and TeX's caches |
| `TEX_SERVICE_CONCURRENCY` | CPUs, at most 4 | builds at once; more wait their turn |
| `TEX_SERVICE_MAX_COMPILE_SECONDS` | 300 | per build, whatever the client asks |
| `TEX_SERVICE_MAX_BODY_MB` | 64 | per request |
| `TEX_SERVICE_PROJECT_TTL_DAYS` | 14 | projects not built for this long are deleted |
| `TEX_SERVICE_LOG_REQUESTS` | on | `0` for errors only |

## API

| | |
|---|---|
| `GET /health` | liveness, no token needed |
| `GET /v1/info` | TeX Live version, engines, SyncTeX, texcount, poppler, font stand-ins, limits |
| `PUT /v1/projects/:id/files` | upload `{ files: { path: { sha256, data } } }` (base64) |
| `POST /v1/projects/:id/sync` | `{ files: { path: sha256 } }`: deletes files not listed, returns `{ missing }` |
| `POST /v1/projects/:id/compile` | `{ main, engine, force?, trusted?, haltOnError?, timeoutMs? }` → exit code, log, `.blg`, PDF and SyncTeX (base64, only what this build wrote) and the project's path on the service |
| `POST /v1/projects/:id/texcount` | `{ main }` → texcount's output |
| `DELETE /v1/projects/:id` | drop the project and its build files |
| `POST /v1/synctex` | `{ project, synctex, view: { file, line, column? } }` or `{ …, edit: { page, x, y } }` |
| `POST /v1/pdf/inspect?text&layout&fonts&info&first=&last=` | body: a PDF → pdftotext / pdffonts / pdfinfo output |

A project is a folder on the service holding your sources and what TeX generated, so builds are
incremental. Files are content-addressed: a client uploads what changed, then syncs the full list, and
uploads whatever the service says it's missing (after its volume was reset, say). `src/client.ts` does
all of this; `src/protocol.ts` has the types. Errors are `{ error: { code, message } }`.

## Develop

```sh
pnpm --filter @resume-studio/tex-service test   # the API over real HTTP with real TeX builds (needs TeX Live)
node packages/tex-service/src/main.ts           # run it without Docker, on this machine's TeX
```

To move to a newer TeX Live, update the digest in the Dockerfile, rebuild, and compare builds before and
after (every project should build with the same pages and text).
