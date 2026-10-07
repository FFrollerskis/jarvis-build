import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-423: produksjonsimagene installerer med `pnpm install --prod`. En pakke som koden i `src/` importerer, men som kun står i `devDependencies`
 * (eller mangler), virker i CI/lokalt (dev-avhengigheter finnes der) og krasjer ved oppstart i containeren: `ERR_MODULE_NOT_FOUND` (observert på NAS
 * 2026-10-07: `zod` importert fra `apps/api/src/chat-jobs.ts`, kun i devDependencies -> api-containeren ble aldri frisk). Denne vakten feiler CI i stedet.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "test" || name === "tests" || name === "scripts") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|mts|mjs)$/.test(name) && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function bareImports(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const specs = new Set<string>();
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^"'`;]*?from\s+["']([^"']+)["']/g)) specs.add(m[1]!);
  for (const m of src.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) specs.add(m[1]!);
  for (const m of src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) specs.add(m[1]!);
  return [...specs].filter((s) => !s.startsWith(".") && !s.startsWith("/") && !BUILTINS.has(s) && !s.startsWith("node:"));
}

const pkgName = (spec: string): string => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!);

describe("D-423: alt `src/` importerer er en runtime-avhengighet (ikke bare devDependencies)", () => {
  const roots = ["apps", "modules", "packages"].flatMap((group) => {
    const base = join(ROOT, group);
    if (!existsSync(base)) return [];
    return readdirSync(base).map((n) => join(base, n)).filter((d) => existsSync(join(d, "package.json")) && existsSync(join(d, "src")));
  });

  it("fant arbeidsområder å sjekke", () => {
    expect(roots.length).toBeGreaterThan(20);
  });

  it.each(roots.map((r) => [r.slice(ROOT.length + 1), r] as const))("%s", (_name, dir) => {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, Record<string, string> | string | undefined>;
    const runtime = new Set([...Object.keys((pkg["dependencies"] as Record<string, string>) ?? {}), ...Object.keys((pkg["optionalDependencies"] as Record<string, string>) ?? {}), ...Object.keys((pkg["peerDependencies"] as Record<string, string>) ?? {})]);
    const self = pkg["name"] as string | undefined;
    const missing = new Set<string>();
    for (const file of walk(join(dir, "src"))) {
      for (const spec of bareImports(file)) {
        const name = pkgName(spec);
        if (name === self || runtime.has(name)) continue;
        missing.add(name);
      }
    }
    expect([...missing].sort(), `${dir.slice(ROOT.length + 1)}: importert i src/ men ikke i dependencies`).toEqual([]);
  });
});
