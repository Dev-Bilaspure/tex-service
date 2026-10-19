# Changelog

All notable changes are listed here. Versions follow [Semantic Versioning](https://semver.org): the HTTP API
(`/v1`) and the client's exports don't break within a major version.

## 0.1.0 (2026-10-19)

First public release.

- HTTP API: upload and sync project files (content-addressed), compile with latexmk (pdfLaTeX, XeLaTeX,
  LuaLaTeX, LaTeX → DVI → PDF), SyncTeX queries both ways, texcount, and PDF inspection with poppler.
- Incremental builds: each project keeps its build files between compiles.
- Fonts: TeX Live's fonts registered with fontconfig; metric-compatible stand-ins for Arial, Helvetica, Times
  New Roman, Courier New, Calibri and Cambria.
- Safe defaults: restricted shell escape unless the operator allows more; a token is required off loopback;
  browser requests refused; time, size and process limits.
- TypeScript client with incremental sync, typed errors and the shared latexmk invocation.
- Image: TeX Live 2026 (full), pinned by digest, for linux/amd64 and linux/arm64.
