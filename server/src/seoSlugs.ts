const RU_MAP: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

const COLOR_SEO_SLUGS: Record<string, string> = {
  white: "belaya",
  black: "chernaya",
  blue: "sinyaya",
  "washed-grey": "varenaya-seraya",
  "washed-beige": "varenaya-bezhevaya",
};

const DECORATION_SEO_SLUGS: Record<string, string> = {
  print: "print",
  embroidery: "vyshivka",
};

export function slugifySeoText(value: string): string {
  const lower = value.trim().toLowerCase();
  let out = "";
  for (const ch of lower) {
    if (/[a-z0-9]/.test(ch)) out += ch;
    else if (RU_MAP[ch] !== undefined) out += RU_MAP[ch];
    else if (/[\s._/|–—-]/.test(ch)) out += "-";
  }
  return out.replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function hasSlugToken(slug: string, token: string): boolean {
  return new RegExp(`(^|-)${token}($|-)`).test(slug);
}

function compactColorSuffix(base: string, color: string): string {
  const missingTokens = color
    .split("-")
    .filter((token) => token && !hasSlugToken(base, token));
  return missingTokens.join("-");
}

function decorationAlreadyInSlug(base: string, decoration: string): boolean {
  if (decoration === "print") return base.includes("print");
  if (decoration === "vyshivka") return base.includes("vyshiv");
  return hasSlugToken(base, decoration);
}

function compactDecorationSuffix(base: string, decoration: string): string {
  return decorationAlreadyInSlug(base, decoration) ? "" : decoration;
}

export function buildSeoProductSlug(input: {
  name?: string | null;
  suggestedName?: string | null;
  decorationSlug?: string | null;
  colorSlug?: string | null;
}): string {
  const base = slugifySeoText(input.suggestedName || input.name || "");
  const parts = base ? [base] : [];

  const decoration = input.decorationSlug
    ? DECORATION_SEO_SLUGS[input.decorationSlug]
    : "";
  const decorationSuffix = decoration
    ? compactDecorationSuffix(base, decoration)
    : "";
  if (decorationSuffix) parts.push(decorationSuffix);

  const color = input.colorSlug ? COLOR_SEO_SLUGS[input.colorSlug] : "";
  const colorSuffix = color ? compactColorSuffix(base, color) : "";
  if (colorSuffix) parts.push(colorSuffix);

  return parts.join("-") || "product";
}
