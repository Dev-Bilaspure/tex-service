# Third-party software in the tex-service image

The tex-service code is MIT-licensed (see [LICENSE](LICENSE)). The Docker image also contains other
software, each under its own license. Nothing here changes those licenses; this file says what's included
and where to find the sources.

| Component | What it's for | License | Source |
|---|---|---|---|
| TeX Live 2026 (full scheme), via the [`texlive/texlive`](https://hub.docker.com/r/texlive/texlive) image | TeX engines, latexmk, biber, SyncTeX, texcount, fonts and packages | Each package under its own free license (LPPL, GPL, OFL, public domain and others); see [TeX Live's licensing](https://tug.org/texlive/copying.html) | [tug.org/texlive](https://tug.org/texlive/), [CTAN](https://ctan.org), image build: [Island of TeX](https://gitlab.com/islandoftex/images/texlive) |
| Debian packages: `poppler-utils`, `fontconfig`, `fonts-liberation2`, `ca-certificates`, and the base system | PDF text and metadata, font lookup, metric-compatible fonts | Their Debian licenses (poppler: GPL-2.0/GPL-3.0; Liberation fonts: SIL OFL 1.1; others as listed in each package's `/usr/share/doc/<package>/copyright`) | [sources.debian.org](https://sources.debian.org) |
| Node.js 24, from the official [`node`](https://hub.docker.com/_/node) image | Runs the service | MIT, with bundled components under their own licenses | [github.com/nodejs/node](https://github.com/nodejs/node) |

Inside the image, each Debian package's license is at `/usr/share/doc/<package>/copyright`, and TeX Live's
documentation and license files are under its installation directory (`kpsewhich -var-value TEXMFDIST`).

The image pins its TeX Live base image by digest (see the Dockerfile), so a given tex-service version always
contains the same TeX Live.
