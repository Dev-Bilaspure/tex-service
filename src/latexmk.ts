// How a resume is built: the one latexmk command line, shared by local builds (the editor running TeX on
// this machine) and the compile service, so a document builds the same way in both.

export type TexEngine = "pdflatex" | "xelatex" | "lualatex" | "latex";
export const TEX_ENGINES: readonly TexEngine[] = ["pdflatex", "xelatex", "lualatex", "latex"];

const ENGINE_FLAG: Record<TexEngine, string> = { pdflatex: "-pdf", xelatex: "-xelatex", lualatex: "-lualatex", latex: "-pdfdvi" };

/** A project's own latexmkrc, as Overleaf honours it (only for trusted projects: it's Perl code). */
export const PROJECT_RC_FILES = ["latexmkrc", ".latexmkrc"] as const;

/**
 * Rules every build loads, written to a file and passed with -r (the user's ~/.latexmkrc is not loaded:
 * builds are the same on every machine). They match what Overleaf sets up, so projects that build there
 * build here.
 */
export const BUILTIN_LATEXMKRC = String.raw`# Written by Resume Studio; loaded for every build.

# latex (DVI) engine: DVI → PDF with dvipdfmx, which keeps SyncTeX positions and needs no Ghostscript.
$dvipdf = 'dvipdfmx %O -o %D %S';

# glossaries / acronyms (makeglossaries), run on the files in the output directory.
add_cus_dep('glo', 'gls', 0, 'run_makeglossaries');
add_cus_dep('acn', 'acr', 0, 'run_makeglossaries');
add_cus_dep('slo', 'sls', 0, 'run_makeglossaries');
sub run_makeglossaries {
  my ($base_name, $path) = fileparse($_[0]);
  my @args = ('-q', '-d', $path, $base_name);
  return system('makeglossaries', @args);
}
push @generated_exts, 'glo', 'gls', 'glg', 'acn', 'acr', 'alg', 'slo', 'sls', 'slg', 'ist';

# nomenclature (nomencl)
add_cus_dep('nlo', 'nls', 0, 'run_nomencl');
sub run_nomencl {
  return system('makeindex', "$_[0].nlo", '-s', 'nomencl.ist', '-o', "$_[0].nls", '-t', "$_[0].nlg");
}
push @generated_exts, 'nlo', 'nls', 'nlg';

# Index files from imakeidx/index with custom names are handled by latexmk itself.
`;

export interface LatexmkOptions {
  engine: TexEngine;
  /** The main file's name, without its folder: latexmk runs in the main file's folder. */
  mainFile: string;
  /** Really run TeX even when latexmk thinks nothing changed (Recompile; a draft built twice). */
  force?: boolean;
  /** -shell-escape and the project's latexmkrc. Untrusted builds get TeX's restricted shell escape. */
  trusted?: boolean;
  haltOnError?: boolean;
  /** Path of the file holding BUILTIN_LATEXMKRC. */
  builtinRc?: string;
  /** Paths of the project's own latexmkrc files that exist (loaded only when trusted). */
  projectRcs?: string[];
}

/** The latexmk arguments and the environment TeX needs, for a build run in the main file's folder. */
export function latexmkInvocation(o: LatexmkOptions): { args: string[]; env: Record<string, string> } {
  const args = [
    ENGINE_FLAG[o.engine],
    "-norc", // no user/system latexmkrc: every machine builds the same way
    ...(o.builtinRc ? ["-r", o.builtinRc] : []),
    ...(o.trusted ? (o.projectRcs ?? []).flatMap((f) => ["-r", f]) : []),
    ...(o.trusted ? ["-shell-escape"] : []),
    // Overleaf's default: carry on past errors (latexmk -f), so bibliography and cross-reference passes
    // still run and the partial PDF is as complete as it can be.
    ...(o.haltOnError ? ["-halt-on-error"] : ["-f"]),
    "-interaction=nonstopmode",
    "-file-line-error",
    "-synctex=1",
    "-recorder",
    // A forced build (Recompile) must really run TeX: without -g, latexmk sees unchanged sources after a
    // failure and just reports the old errors, e.g. after you've installed a missing package.
    ...(o.force ? ["-g"] : []),
    o.mainFile,
  ];
  const env = {
    // Unwrapped log lines (TeX wraps at 79 columns by default) make the log parseable.
    max_print_line: "10000",
    error_line: "254",
    half_error_line: "238",
    // Restricted \write18 (TeX Live's default): only the vetted commands TeX Live lists (epstopdf for EPS
    // images, bibtex, kpsewhich, …). Full shell escape only for trusted projects (-shell-escape).
    shell_escape: o.trusted ? "t" : "p",
    // TeX may only write files under the working directory (the build folder).
    openout_any: "p",
  };
  return { args, env };
}

/** The main file's name without its extension: TeX names the .log, .pdf and .synctex.gz after it. */
export function jobName(mainFile: string): string {
  return (mainFile.split("/").pop() ?? mainFile).replace(/\.(tex|xtx|ltx)$/, "");
}
