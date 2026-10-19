# Security

## What tex-service runs

tex-service compiles the LaTeX documents it's sent. TeX is a programming language: a document can loop, read
files the TeX process can read, and (with shell escape) run commands. The service is built to keep that
contained:

- **Shell escape is off.** Builds get TeX Live's *restricted* shell escape (only vetted helpers such as
  `epstopdf`). Full shell escape (`\write18`, needed by `minted`, `svg`, `gnuplot`) is refused unless the
  operator sets `TEX_SERVICE_ALLOW_SHELL_ESCAPE=1`; then a document can run any command inside the container.
- **A token is required** on any address other than loopback (`TEX_SERVICE_TOKEN`). The service refuses to
  start without one unless the operator sets `TEX_SERVICE_ALLOW_UNAUTHENTICATED=1`, which is only safe when
  the port is reachable from that machine alone (`-p 127.0.0.1:4380:4380`).
- **Browsers are refused**: requests with an `Origin` or `Sec-Fetch-Site` header get 403, and request bodies
  must be `application/json` or `application/pdf`, so a web page can't drive the service.
- **Paths are checked** (relative, no `..`), uploads are verified by SHA-256, bodies are size-limited, and a
  build is killed with every process it started when it runs past its time limit or its client disconnects.
- **TeX writes only inside its project** (`openout_any=p`).
- **The container runs as an unprivileged user.** The example `docker-compose.yml` also makes the root
  filesystem read-only, drops all capabilities, forbids privilege escalation and limits processes and
  memory. Use the same settings wherever you run it.

Projects of different clients share one service: treat clients of one service as one trust domain, and run
separate services (or containers) for parties that must not see each other's build files.

## Reporting a vulnerability

Please report security problems privately, through GitHub's
[private vulnerability reporting](https://github.com/Dev-Bilaspure/tex-service/security/advisories/new) for
this repository, not in a public issue. You'll get an answer within a week.
