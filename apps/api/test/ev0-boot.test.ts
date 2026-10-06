import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalizeManifest, publicKeyFingerprint } from "@jarvis/self-modification";
import { checkEv0Boot, getLastEv0BootStatus, logEv0Boot } from "../src/ev0-boot.ts";

/** EV-0 (D-411): oppstartssjekken er observasjon - den kaster aldri og gir presise statuser. */
const REPO_CONFIG = fileURLToPath(new URL("../../../config/evolution/", import.meta.url));
const emptyLedgerPool = {
  query: async (sql: string) => (sql.includes("evolution_ledger_verify") ? { rows: [{ broken: null }] } : { rows: [] })
};

async function signedDir() {
  const dir = await mkdtemp(join(tmpdir(), "ev0-boot-"));
  const manifest = await readFile(join(REPO_CONFIG, "constitution.v1.json"), "utf8");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  await writeFile(join(dir, "constitution.v1.json"), manifest);
  await writeFile(join(dir, "constitution.pub.pem"), publicKey.export({ type: "spki", format: "pem" }).toString());
  await writeFile(join(dir, "constitution.v1.sig"), sign(null, Buffer.from(canonicalizeManifest(JSON.parse(manifest)), "utf8"), privateKey).toString("base64"));
  return { dir, fp: publicKeyFingerprint(publicKey) };
}

describe("checkEv0Boot", () => {
  it("A1: repoets innsjekkede (usignerte) konstitusjon gir not_verified/constitution_unsigned - og kaster ikke", async () => {
    const r = await checkEv0Boot({ pool: emptyLedgerPool as never, pinnedPublicKeySha256: null, configDir: REPO_CONFIG });
    expect(r.constitution).toEqual({ status: "not_verified", code: "constitution_unsigned" });
    expect(r.ledger).toMatchObject({ status: "ok", count: 0 });
  });

  it("A2: signert + festet nøkkel -> verified med versjon og digest", async () => {
    const { dir, fp } = await signedDir();
    const r = await checkEv0Boot({ pool: emptyLedgerPool as never, pinnedPublicKeySha256: fp, configDir: dir });
    expect(r.constitution).toMatchObject({ status: "verified", version: 1 });
    expect((r.constitution as { digest: string }).digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("A3: signert men ingen festet nøkkel i miljøet -> constitution_key_not_pinned; feil festet nøkkel -> constitution_key_mismatch", async () => {
    const { dir, fp } = await signedDir();
    expect((await checkEv0Boot({ pool: emptyLedgerPool as never, pinnedPublicKeySha256: null, configDir: dir })).constitution)
      .toEqual({ status: "not_verified", code: "constitution_key_not_pinned" });
    expect((await checkEv0Boot({ pool: emptyLedgerPool as never, pinnedPublicKeySha256: fp.replace(/^./, fp[0] === "a" ? "b" : "a"), configDir: dir })).constitution)
      .toEqual({ status: "not_verified", code: "constitution_key_mismatch" });
  });

  it("A4: manglende katalog -> constitution_missing (ikke et kast)", async () => {
    const r = await checkEv0Boot({ pool: emptyLedgerPool as never, pinnedPublicKeySha256: null, configDir: join(tmpdir(), "finnes-ikke-ev0") });
    expect(r.constitution).toEqual({ status: "not_verified", code: "constitution_missing" });
  });

  it("B1: databasen sier kjeden er ødelagt -> ledger broken med seq; feil ved spørring -> unavailable", async () => {
    const broken = { query: async (sql: string) => (sql.includes("evolution_ledger_verify") ? { rows: [{ broken: "3" }] } : { rows: [] }) };
    expect((await checkEv0Boot({ pool: broken as never, pinnedPublicKeySha256: null, configDir: REPO_CONFIG })).ledger)
      .toMatchObject({ status: "broken", broken_seq: "3" });
    const down = { query: async () => { throw new Error('relation "evolution_change_ledger" does not exist'); } };
    expect((await checkEv0Boot({ pool: down as never, pinnedPublicKeySha256: null, configDir: REPO_CONFIG })).ledger)
      .toMatchObject({ status: "unavailable" });
  });
});

describe("logEv0Boot", () => {
  const capture = () => {
    const lines: Array<{ level: string; line: Record<string, unknown> }> = [];
    const mk = (level: string) => (s: string) => { lines.push({ level, line: JSON.parse(s) as Record<string, unknown> }); };
    return { lines, out: { log: mk("log"), warn: mk("warn"), error: mk("error") } };
  };

  it("C1: alt ok -> info; ikke verifisert -> warn; ødelagt kjede -> error (høyt)", () => {
    const a = capture();
    logEv0Boot({ constitution: { status: "verified", version: 1, digest: "d" }, ledger: { status: "ok", count: 0, head_hash: "h" } }, a.out);
    expect(a.lines.map((l) => l.level)).toEqual(["log", "log"]);
    const b = capture();
    logEv0Boot({ constitution: { status: "not_verified", code: "constitution_unsigned" }, ledger: { status: "broken", broken_seq: "2", count: 5 } }, b.out);
    expect(b.lines.map((l) => l.level)).toEqual(["warn", "error"]);
    expect(b.lines[1]!.line).toMatchObject({ msg: "ev0_change_ledger_boot", status: "broken", broken_seq: "2" });
  });
});

describe("D: komposisjonsroten (statisk)", () => {
  const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
  it("D1: main.ts kjører sjekken ÉN gang, uten await (blokkerer ikke oppstart), og konstruerer IKKE SelfModificationService", () => {
    const main = read("../src/main.ts");
    expect(main.match(/checkEv0Boot\(/g)).toHaveLength(1);
    expect(main).toMatch(/void checkEv0Boot\(/);
    expect(main).toContain("JARVIS_CONSTITUTION_PUBKEY_SHA256");
    expect(main).not.toMatch(/new SelfModificationService\(/);
  });

  it("D2: fingeravtrykk-variabelen når api-containeren (compose) og er dokumentert i .env.example - men aldri en privatnøkkel", () => {
    expect(read("../../../infra/local/docker-compose.yml")).toContain("JARVIS_CONSTITUTION_PUBKEY_SHA256");
    expect(read("../../../.env.example")).toMatch(/^JARVIS_CONSTITUTION_PUBKEY_SHA256=$/m);
  });
});

describe("E: siste resultat for selvdiagnosen (EV-1)", () => {
  it("E1: getLastEv0BootStatus er null før første sjekk og gir siste resultat etterpå", async () => {
    const r = await checkEv0Boot({ pool: emptyLedgerPool as never, pinnedPublicKeySha256: null, configDir: REPO_CONFIG });
    expect(getLastEv0BootStatus()).toEqual(r);
  });

  it("E2: main.ts kobler selvmodellens ev0Status til siste oppstartsresultat", () => {
    const main = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");
    expect(main).toContain("ev0Status: () => getLastEv0BootStatus()");
  });
});
