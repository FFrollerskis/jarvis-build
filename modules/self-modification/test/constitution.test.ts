import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConstitutionError, REQUIRED_E3_ACTIONS, buildConstitution, canonicalizeManifest, classifySelfModification, loadConstitution,
  publicKeyFingerprint, verifyConstitution
} from "../src/index.ts";
// @ts-expect-error - ren .mjs-verktøy uten typer
import { canonicalize as scriptCanonicalize, fingerprint as scriptFingerprint } from "../../../ops/security/sign-constitution.mjs";

/** EV-0 (D-406): signert Safety Constitution - ren verifisering, ingen DB. */
const MANIFEST_PATH = new URL("../../../config/evolution/constitution.v1.json", import.meta.url);
const repoManifest = (): Record<string, unknown> => JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey, publicKey,
    pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    fp: publicKeyFingerprint(publicKey)
  };
}
const signed = (manifest: unknown, kp: ReturnType<typeof keypair>) =>
  sign(null, Buffer.from(canonicalizeManifest(manifest), "utf8"), kp.privateKey).toString("base64");

function verifyOk(manifest: unknown = repoManifest(), kp = keypair(), over: Record<string, unknown> = {}) {
  return verifyConstitution({
    manifestJson: JSON.stringify(manifest), signatureB64: signed(manifest, kp), publicKeyPem: kp.pem, pinnedPublicKeySha256: kp.fp, ...over
  } as Parameters<typeof verifyConstitution>[0]);
}
const code = (fn: () => unknown): string => {
  try { fn(); } catch (err) { return (err as ConstitutionError).code ?? `other:${(err as Error).message}`; }
  return "no_error";
};

describe("A: verifisering - fail-closed", () => {
  it("A1: gyldig signatur + festet nøkkel -> Constitution med versjon og digest", () => {
    const c = verifyOk();
    expect(c.version).toBe(1);
    expect(c.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("A2: manglende signatur -> constitution_unsigned", () => {
    const kp = keypair();
    expect(code(() => verifyConstitution({ manifestJson: JSON.stringify(repoManifest()), signatureB64: null, publicKeyPem: kp.pem, pinnedPublicKeySha256: kp.fp }))).toBe("constitution_unsigned");
  });

  it("A3: ingen festet nøkkel i miljøet -> constitution_key_not_pinned (repoets egen nøkkel er ikke nok)", () => {
    expect(code(() => verifyOk(repoManifest(), keypair(), { pinnedPublicKeySha256: null }))).toBe("constitution_key_not_pinned");
    expect(code(() => verifyOk(repoManifest(), keypair(), { pinnedPublicKeySha256: "abc" }))).toBe("constitution_key_not_pinned");
  });

  it("A4: en annen nøkkel enn den eieren festet (angriper byttet manifest+sig+pub i repoet) -> constitution_key_mismatch", () => {
    const attacker = keypair();
    const owner = keypair();
    expect(code(() => verifyOk(repoManifest(), attacker, { pinnedPublicKeySha256: owner.fp }))).toBe("constitution_key_mismatch");
  });

  it("A5: manifest endret etter signering -> constitution_signature_invalid", () => {
    const kp = keypair();
    const sig = signed(repoManifest(), kp);
    const tampered = { ...repoManifest(), issued_by: "someone-else" };
    expect(code(() => verifyConstitution({ manifestJson: JSON.stringify(tampered), signatureB64: sig, publicKeyPem: kp.pem, pinnedPublicKeySha256: kp.fp }))).toBe("constitution_signature_invalid");
  });

  it("A6: søppel-signatur -> constitution_signature_invalid (kaster ikke noe annet)", () => {
    const kp = keypair();
    expect(code(() => verifyOk(repoManifest(), kp, { signatureB64: "###" }))).toBe("constitution_signature_invalid");
  });

  it("A7: rollback-vern - lavere versjon enn minVersion avvises", () => {
    expect(code(() => verifyOk(repoManifest(), keypair(), { minVersion: 2 }))).toBe("constitution_rollback");
    expect(code(() => verifyOk(repoManifest(), keypair(), { minVersion: 1 }))).toBe("no_error");
  });

  it("A8: ikke-Ed25519-nøkkel avvises", () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(code(() => verifyConstitution({ manifestJson: "{}", signatureB64: "AA==", publicKeyPem: pem, pinnedPublicKeySha256: publicKeyFingerprint(publicKey) }))).toBe("constitution_invalid");
  });
});

describe("B: signert, men svekket manifest avvises", () => {
  it("B1: fjernet beskyttelse av policy-modulen", () => {
    const m = repoManifest() as { protected_paths: { value: string }[] };
    m.protected_paths = m.protected_paths.filter((r) => r.value !== "modules/policy/");
    expect(code(() => verifyOk(m))).toBe("constitution_weakened");
  });

  it("B2: constitution-filene selv er ubeskyttet", () => {
    const m = repoManifest() as { protected_paths: { value: string }[] };
    m.protected_paths = m.protected_paths.filter((r) => r.value !== "config/evolution/");
    expect(code(() => verifyOk(m))).toBe("constitution_weakened");
  });

  it("B3: manglende E3-handling", () => {
    for (const action of REQUIRED_E3_ACTIONS) {
      const m = repoManifest() as { e3_actions: string[] };
      m.e3_actions = m.e3_actions.filter((a) => a !== action);
      expect(code(() => verifyOk(m))).toBe("constitution_weakened");
    }
  });

  it("B4: E1-allowlist utover den hardkodede avvises", () => {
    const m = repoManifest() as { e1_allowlist: string[] };
    m.e1_allowlist = ["config/charlie-personality.json", "apps/api/src/server.ts"];
    expect(code(() => verifyOk(m))).toBe("constitution_weakened");
  });

  it("B5: ukjent felt / feil skjema -> constitution_invalid", () => {
    expect(code(() => buildConstitution({ ...repoManifest(), extra: 1 }))).toBe("constitution_invalid");
    expect(code(() => buildConstitution({ ...repoManifest(), version: 0 }))).toBe("constitution_invalid");
  });
});

describe("C: klassifisering E1/E2/E3 - aldri svakere enn policy.ts", () => {
  const c = verifyOk();
  const rank = { E0: 0, E1: 1, E2: 2, E3: 3 } as const;
  const legacyRank = { zero_review: 1, requires_approval: 2, forbidden: 3 } as const;

  it("C1: personlighets-konfig alene = E1; blandet med annen fil = E2", () => {
    expect(c.classify(["config/charlie-personality.json"])).toBe("E1");
    expect(c.classify(["config/charlie-personality.json", "apps/api/src/server.ts"])).toBe("E2");
  });

  it("C2: vanlig kode = E2; tom diff = E3; sti-utbryting = E3-nær (ikke E1)", () => {
    expect(c.classify(["apps/api/src/server.ts"])).toBe("E2");
    expect(c.classify([])).toBe("E3");
    expect(c.classify(["../etc/passwd", "config/charlie-personality.json"])).not.toBe("E1");
  });

  it("C3: constitution-filene, signeringsverktøyet og backup-ops er E3", () => {
    for (const p of [
      "config/evolution/constitution.v1.json", "config/evolution/constitution.v1.sig", "config/evolution/constitution.pub.pem",
      "ops/security/sign-constitution.mjs", "ops/backup/run.sh", "docs/remediation/FINDINGS_LEDGER.md"
    ]) {
      expect(c.classify([p]), p).toBe("E3");
    }
  });

  it("C4: paritet - ingen kombinasjon er svakere enn den eksisterende klassifiseringen", () => {
    const corpus = [
      "config/charlie-personality.json", "apps/api/src/server.ts", "modules/policy/src/gateway.ts", "modules/owner-controls/src/x.ts",
      "modules/core/src/db/migrations/070_x.sql", ".github/workflows/ci.yml", "infra/local/docker-compose.yml", "package.json",
      "apps/web/package.json", "pnpm-lock.yaml", ".env.example", "docs/security/X.md", "CLAUDE.md", "docs/CLAUDE.md",
      "modules/tool-gateway/src/gateway.ts", "modules/tool-gateway/src/other.ts", "modules/memory/src/x.ts", "README.md",
      "./config/charlie-personality.json", "/abs/path", "a/../b"
    ];
    for (const a of corpus) {
      for (const b of [undefined, ...corpus]) {
        const paths = b === undefined ? [a] : [a, b];
        const legacy = legacyRank[classifySelfModification(paths)];
        expect(rank[c.classify(paths)], paths.join(" + ")).toBeGreaterThanOrEqual(legacy);
      }
    }
  });

  it("C5: E3-handlinger", () => {
    expect(c.isActionForbidden("grant_self_root")).toBe(true);
    expect(c.isActionForbidden("send_status_email")).toBe(false);
  });
});

describe("D: repoets manifest og signeringsverktøy", () => {
  it("D1: det innsjekkede manifestet er gyldig og ikke svekket (selv om det ennå ikke er signert)", () => {
    expect(() => buildConstitution(repoManifest())).not.toThrow();
  });

  it("D2: verktøyets kanonisering og fingeravtrykk er identiske med modulens", () => {
    const m = repoManifest();
    expect(scriptCanonicalize(m)).toBe(canonicalizeManifest(m));
    const kp = keypair();
    expect(scriptFingerprint(kp.pem)).toBe(kp.fp);
  });

  it("D3: loadConstitution fra disk - gyldig, manglende manifest, manglende signatur", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ev0-"));
    const kp = keypair();
    const manifest = repoManifest();
    await writeFile(join(dir, "m.json"), JSON.stringify(manifest));
    await writeFile(join(dir, "k.pem"), kp.pem);
    const base = { manifestPath: join(dir, "m.json"), signaturePath: join(dir, "s.sig"), publicKeyPath: join(dir, "k.pem"), pinnedPublicKeySha256: kp.fp };
    await expect(loadConstitution(base)).rejects.toMatchObject({ code: "constitution_unsigned" });
    await writeFile(join(dir, "s.sig"), `${signed(manifest, kp)}\n`);
    await expect(loadConstitution(base)).resolves.toMatchObject({ version: 1 });
    await expect(loadConstitution({ ...base, manifestPath: join(dir, "nope.json") })).rejects.toMatchObject({ code: "constitution_missing" });
  });
});
