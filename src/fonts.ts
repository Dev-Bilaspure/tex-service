// Commercial fonts a resume may ask for by name that a Linux TeX Live doesn't have, and their free stand-ins.

/** Free fonts with the same character widths as common commercial ones: same line breaks, same page count. */
export const METRIC_COMPATIBLE: Record<string, string> = {
  Arial: "Liberation Sans",
  Helvetica: "Liberation Sans",
  "Helvetica Neue": "Liberation Sans",
  "Times New Roman": "Liberation Serif",
  Times: "Liberation Serif",
  "Courier New": "Liberation Mono",
  Calibri: "Carlito",
  Cambria: "Caladea",
};

/** Replaces a font name where fontspec takes one (\setmainfont, \newfontfamily, \fontspec…), in every TeX file. */
export function substituteFont(files: Record<string, string>, from: string, to: string): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([p, t]) => [p, /\.(tex|cls|sty)$/.test(p) ? substituteFontIn(t, from, to) : t]));
}

/** substituteFont for one file's text. */
export function substituteFontIn(text: string, from: string, to: string): string {
  const name = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `(\\\\(?:setmainfont|setsansfont|setmonofont|setmathfont|fontspec|newfontfamily\\s*\\\\[A-Za-z@]+|newfontface\\s*\\\\[A-Za-z@]+|setfontfamily\\s*\\\\[A-Za-z@]+)\\s*(?:\\[[^\\]]*\\]\\s*)?\\{\\s*)${name}(\\s*\\})`,
    "g",
  );
  return text.replace(re, `$1${to}$2`);
}
