#!/usr/bin/env node
// WP-EV0 (H2-0.1/C1): UTKAST til CODEOWNERS generert fra det signerte manifestets beskyttede stier (config/evolution/constitution.v1.json) - så draften aldri kan
// avvike fra det kjøretiden og konstitusjonen faktisk beskytter. Filen er IKKE aktiv: `.github/` er en beskyttet sti (E3), så EIEREN kopierer utkastet til
// `.github/CODEOWNERS` i en egen eier-PR når han/hun vil slå det på (se README.md i denne mappen). Avhengighetsfritt (kun node: innebygde moduler).
//   node ops/security/github-governance/codeowners.mjs            # skriv utkastet til stdout
//   node ops/security/github-governance/codeowners.mjs --write    # oppdater CODEOWNERS.draft ved siden av skriptet
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Plassholder: eieren bytter den med sin egen GitHub-bruker (eller et team) når utkastet aktiveres. Aldri et ekte brukernavn i et offentlig repo-utkast. */
export const OWNER_PLACEHOLDER = "@PLATFORM-OPERATOR";

/** Manifest-regel -> CODEOWNERS-mønster (gitignore-syntaks: ledende `/` forankrer i rot; uten `/` treffer mønsteret på alle nivåer). Prefiks uten `/` på slutten (f.eks. `.env`) blir `/.env*`. */
export function codeownersPattern(rule) {
  switch (rule.kind) {
    case "prefix": return rule.value.endsWith("/") ? `/${rule.value}` : `/${rule.value}*`;
    case "exact": return `/${rule.value}`;
    case "suffix": return `*${rule.value}`;
    case "basename": return rule.value;
    default: throw new Error(`ukjent regeltype: ${String(rule.kind)}`);
  }
}

export function renderCodeowners(manifest, owner = OWNER_PLACEHOLDER) {
  const patterns = [...new Set(manifest.protected_paths.map(codeownersPattern))];
  return [
    "# UTKAST til CODEOWNERS (WP-EV0, H2-0.1/C1) - GENERERT av ops/security/github-governance/codeowners.mjs fra det signerte manifestets beskyttede stier.",
    "# IKKE AKTIV: `.github/` er en beskyttet sti. Eieren kopierer denne filen til `.github/CODEOWNERS` i en egen eier-PR og bytter plassholderen under med sin egen",
    "# GitHub-bruker (eller et team) - se ops/security/github-governance/README.md (forutsetninger, fallgruver, hva som er uverifisert).",
    "# Med regelsettet `ruleset-main.draft.json` slått på krever GitHub review fra kodeeieren for enhver endring av disse stiene, uavhengig av hvem som har skrevet den.",
    "# Rekkefølge: siste treff vinner; alle linjene her har samme eier, så rekkefølgen er likegyldig.",
    "",
    ...patterns.map((p) => `${p} ${owner}`),
    ""
  ].join("\n");
}

const HERE = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(readFileSync(resolve(HERE, "../../../config/evolution/constitution.v1.json"), "utf8"));
  const text = renderCodeowners(manifest);
  if (process.argv.includes("--write")) {
    writeFileSync(join(HERE, "CODEOWNERS.draft"), text);
    console.log("oppdaterte ops/security/github-governance/CODEOWNERS.draft");
  } else {
    process.stdout.write(text);
  }
}
