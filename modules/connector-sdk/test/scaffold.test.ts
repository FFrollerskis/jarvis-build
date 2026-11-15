import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CONNECTOR_ID_PATTERN, VAULT_REF_PATTERN, validateConnectorManifest } from "../src/index.ts";
import { runConnectorContract } from "../src/testing.ts";

/**
 * WP-I (D-472): ende-til-ende-bevis for scaffold-generatoren. Genererer et utkast inn i en MIDLERTIDIG mappe (aldri inn i repoet), kobler SDK-kildene inn via symlinker så de genererte relative
 * importene løses, laster den GENERERTE manifest- og fake-filen, og kjører kontraktstest-kittet mot dem. Beviser at malene gir kode som faktisk validerer og er grønn mot kittet - ikke bare tekst.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
const ROOT = resolve(PKG, "..", "..");
const SCRIPT = join(ROOT, "ops", "connector", "new-connector.mjs");
const tmp: string[] = [];
afterEach(() => { while (tmp.length > 0) rmSync(tmp.pop()!, { recursive: true, force: true }); });

function generate(args: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "wpi-e2e-"));
  tmp.push(root);
  const r = spawnSync(process.execPath, [SCRIPT, ...args, "--root", root], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  // Koble SDK-ets kildefiler inn (enkeltvis: mappen src/ finnes allerede med manifests/ fra generatoren, og en symlink til hele src/ ville latt generatoren skrive inn i repoet).
  const src = join(PKG, "src");
  const dst = join(root, "modules", "connector-sdk", "src");
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name === "manifests") continue;
    symlinkSync(join(src, entry.name), join(dst, entry.name));
  }
  return root;
}

const load = async (root: string, rel: string): Promise<Record<string, unknown>> => (await import(/* @vite-ignore */ pathToFileURL(join(root, rel)).href)) as Record<string, unknown>;

describe.each([[false, "ren lesing (nivå R)", "R"], [true, "med skrivehandling (nivå A)", "A"]] as const)("generert utkast: %s", (write, _label, level) => {
  it("manifestet er et gyldig skeleton, fakeen følger det, og kontraktstest-kittet består uten feil", async () => {
    const root = generate(["--id", "zz_demo", "--name", "ZZ Demo", "--vendor", "ZZ Corp", ...(write ? ["--write"] : [])]);
    const manifestMod = await load(root, "modules/connector-sdk/src/manifests/zz_demo.ts");
    const manifest = manifestMod["ZZ_DEMO_MANIFEST"] as Parameters<typeof runConnectorContract>[0];
    const v = validateConnectorManifest(manifest);
    expect(v.issues).toEqual([]);
    expect(v.completeness).toBe("skeleton");
    expect(v.unknown_paths.length).toBeGreaterThan(10);
    const fakeMod = await load(root, "modules/connector-sdk/test/connectors/zz_demo.fake.ts");
    const create = fakeMod["createZzDemoFake"] as () => Parameters<typeof runConnectorContract>[1];
    const report = await runConnectorContract(manifest, create());
    expect(report.checks.filter((c) => c.status === "fail").map((c) => `${c.id}: ${c.detail ?? ""}`)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.acceptance.required_level).toBe(level);
    // Utkastet er ærlig: mange gap og ingenting bevist mot ekte leverandør - arbeidslisten for å gjøre det til en ekte connector.
    expect(report.acceptance.verdict).toBe("gaps");
    expect(report.acceptance.gaps.length).toBeGreaterThan(3);
    expect(report.acceptance.items.find((i) => i.id === "R.live_read_smoke")?.status).toBe("not_proven");
  });

  it("den genererte kontraktstesten og runbooken refererer filene som faktisk ble laget", () => {
    const root = generate(["--id", "zz_demo", "--name", "ZZ Demo", ...(write ? ["--write"] : [])]);
    const manifest = readFileSync(join(root, "modules/connector-sdk/src/manifests/zz_demo.ts"), "utf8");
    for (const m of manifest.matchAll(/"((?:docs|modules)\/[A-Za-z0-9_./-]+)"/g)) {
      if (m[1]!.includes("zz_demo") || m[1]!.includes("ZZ_DEMO")) expect(existsSync(join(root, m[1]!)), m[1]).toBe(true);
    }
  });
});

describe("det genererte utkastet er IKKE en ferdig connector (CI-vakten stopper det til arbeidet er gjort)", () => {
  it("en genererte manifestfil som ikke er registrert i FULL_MANIFESTS feiler vakten (unregisteredManifestFiles), og skeletonet er ikke «full»", async () => {
    const { unregisteredManifestFiles, FULL_MANIFESTS } = await import("../src/index.ts");
    expect(unregisteredManifestFiles(["github.ts", "zz_demo.ts", "index.ts"], FULL_MANIFESTS.map((m) => m.identity.id))).toEqual(["zz_demo"]);
    const root = generate(["--id", "zz_demo", "--name", "ZZ Demo"]);
    const mod = await load(root, "modules/connector-sdk/src/manifests/zz_demo.ts");
    expect((mod["ZZ_DEMO_MANIFEST"] as { completeness: string }).completeness).toBe("skeleton");
  });
});

describe("generatoren og skjemaet er enige om hva en connector-id er (review LOW)", () => {
  it("ID_PATTERN i generatoren og CONNECTOR_ID i manifestskjemaet godtar og avviser nøyaktig de samme id-ene, og hver godtatt id gir en gyldig hvelvreferanse JARVIS_<ID>_TOKEN", async () => {
    const gen = (await import(/* @vite-ignore */ pathToFileURL(SCRIPT).href)) as { ID_PATTERN: RegExp };
    const candidates = ["ab", "a_b", "a1_b2", "google_sheets", "a".repeat(41), "a", "ab_", "a__b", "_ab", "a_", "A_b", "a-b", "a b", "1ab", "a".repeat(42), "", "a_b_c_d", "x9", "ab\n", "aå"];
    for (const id of candidates) {
      expect(gen.ID_PATTERN.test(id), JSON.stringify(id)).toBe(CONNECTOR_ID_PATTERN.test(id));
      if (CONNECTOR_ID_PATTERN.test(id)) expect(VAULT_REF_PATTERN.test(`JARVIS_${id.toUpperCase()}_TOKEN`), id).toBe(true);
    }
    expect(candidates.filter((id) => CONNECTOR_ID_PATTERN.test(id))).toEqual(["ab", "a_b", "a1_b2", "google_sheets", "a".repeat(41), "a_b_c_d", "x9"]);
  });

  it("alle registerets connector-id-er oppfyller den strammere formen (ingen eksisterende id brytes)", async () => {
    const { CONNECTOR_REGISTRY } = await import("@jarvis/tool-gateway");
    for (const c of CONNECTOR_REGISTRY) expect(CONNECTOR_ID_PATTERN.test(c.id), c.id).toBe(true);
  });
});

