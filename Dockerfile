# The compile service: the official, complete TeX Live (the same distribution as Overleaf and MacTeX),
# latexmk, SyncTeX, texcount and poppler, behind a small HTTP API. Build from the repository root:
#   docker build -f packages/tex-service/Dockerfile -t resume-studio-tex .
# or just `docker compose up -d` (see docker-compose.yml).

# Node, copied into the TeX Live image below. The service has no dependencies: Node runs its TypeScript
# sources directly (type stripping).
FROM node:24-bookworm-slim AS node

# TeX Live 2026, full scheme. Pinned by digest: update it deliberately, then rebuild and run the tests.
FROM texlive/texlive:latest-full@sha256:0f4884ca7d287f47ab466d2dd405d4c901c576585363f628863a7ca7eea21301
# poppler: pdftotext/pdfinfo/pdffonts for page counts and the ATS checks. Fonts, for XeLaTeX, which finds
# fonts by name through fontconfig:
#  - TeX Live's own fonts (Roboto, Lato, Fira, Source Sans, Carlito, Caladea…) registered with fontconfig,
#    as Overleaf does, so CV templates that ask for them by name build as they do there;
#  - Liberation, the metric-compatible stand-ins for Arial, Helvetica, Times New Roman and Courier New, so
#    documents that name those build with the same line and page breaks.
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils fontconfig fonts-liberation2 ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && cp "$(kpsewhich -var-value TEXMFSYSVAR)/fonts/conf/texlive-fontconfig.conf" /etc/fonts/conf.d/09-texlive.conf \
 && fc-cache -f
COPY --from=node /usr/local/bin/node /usr/local/bin/node

WORKDIR /app
COPY packages/tex-service/package.json ./package.json
COPY packages/tex-service/src ./src

RUN useradd --create-home --uid 10001 tex && mkdir -p /data && chown tex:tex /data
# Everything the service and TeX write goes under /data: projects, and TeX's own caches (LuaTeX's font
# database takes a minute to build the first time; keeping it makes later starts fast). biber unpacks
# itself and runs from PAR_GLOBAL_TMPDIR, which can't be /tmp: Docker mounts tmpfs noexec.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4380 \
    TEX_SERVICE_DATA=/data \
    HOME=/data/home \
    TEXMFVAR=/data/texmf-var \
    TEXMFCONFIG=/data/texmf-config \
    XDG_CACHE_HOME=/data/cache \
    PAR_GLOBAL_TMPDIR=/data/cache/par
VOLUME /data
EXPOSE 4380
USER tex
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4380/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/main.ts"]
