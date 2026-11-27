import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { acquireLock, isStale, replaceFileAtomically, STALE_LOCK_MS } from "../src/program/file-lock.ts";
import { refreshFingerprints } from "../src/program/fingerprint-tool.ts";
import { recordGate, type RecordGateInput } from "../src/program/gate-recorder.ts";
import { EVIDENCE_AT, EVIDENCE_SHA, realEvidence } from "./program-index-evidence.ts";
import { json, miniRepo, put, tmp } from "./program-index-minirepo.ts";

/**
 * WP-PGA fiks 1 (M1, review-funn «tapt oppdatering i porteregistreringen»): to samtidige registreringer av samme port meldte begge `ok`, men bare den ene overgangen sto igjen i historikken
 * (15 av 30 forsøk i reviewerens prøve). Lukket med en eksklusiv lås (`.<PORT>.lock`, `wx`) og en re-lesing rett før rename, i BÅDE `gate-recorder.ts` og `fingerprint-tool.ts`.
 * Hver kontroll har en test som feiler uten den: låsen, den foreldede låsen (60 s), frigivelse i `finally`, re-lesingen og `wx` på midlertidig fil.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = resolve(HERE, "program-index-race-worker.ts");
const NOW = "2026-11-26T14:00:00.000Z";
const SHA_HEAD = "b".repeat(40);

const rec = (root: string, over: Partial<RecordGateInput> = {}) =>
  recordGate({ root, gate_id: "G01", status: "PASS", evidence_path: "docs/evidence/e1.md", reason: "bevist i testen", by: "owner", now: NOW, git_sha: SHA_HEAD, write: true, ...over });
const withEvidence = () => {
  const m = miniRepo();
  put(m.root, "docs/evidence/e1.md", realEvidence());
  return m;
};
const lockPath = (root: string, id: string) => join(root, "config/program", `.${id}.lock`);
const gateJson = (root: string, id = "G01") => JSON.parse(readFileSync(join(root, "config/program/gates", `${id}.json`), "utf8")) as { status: string; title: string; history: Array<{ prior_status: string; new_status: string }> };
const age = (path: string, ms: number, nowMs: number): void => {
  const t = (nowMs - ms) / 1000;
  utimesSync(path, t, t);
};

describe("file-lock: eksklusiv lås med foreldelse", () => {
  it("første får låsen, andre nektes (held), og etter release kan den tas igjen; release er idempotent", () => {
    const dir = tmp();
    const path = join(dir, ".x.lock");
    const a = acquireLock(path);
    expect(a.ok).toBe(true);
    expect(existsSync(path)).toBe(true);
    const b = acquireLock(path);
    expect(b.ok).toBe(false);
    expect(!b.ok && b.reason).toBe("held");
    if (a.ok) {
      a.release();
      a.release();
    }
    expect(existsSync(path)).toBe(false);
    const c = acquireLock(path);
    expect(c.ok).toBe(true);
    if (c.ok) c.release();
  });

  it("release rører aldri en lås man ikke lenger eier (den er overtatt av en annen)", () => {
    const dir = tmp();
    const path = join(dir, ".x.lock");
    const a = acquireLock(path);
    if (!a.ok) throw new Error("forventet lås");
    writeFileSync(path, "en-annens-token\n");
    a.release();
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("en-annens-token\n");
  });

  it("en lås i en mappe som ikke finnes er unavailable (ikke held, ikke et kast)", () => {
    const r = acquireLock(join(tmp(), "finnes-ikke", ".x.lock"));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("unavailable");
  });

  it("foreldelse: strengt eldre enn 60 s kan overtas (took_over_stale), ellers nektes den", () => {
    expect(STALE_LOCK_MS).toBe(60_000);
    expect(isStale(1_000, 61_000)).toBe(false);
    expect(isStale(1_000, 61_001)).toBe(true);
    expect(isStale(2_000, 1_000)).toBe(false);
    const dir = tmp();
    const path = join(dir, ".x.lock");
    const nowMs = Date.now();
    const first = acquireLock(path);
    expect(first.ok).toBe(true);
    age(path, 59_000, nowMs);
    expect(acquireLock(path, { now_ms: nowMs }).ok).toBe(false);
    age(path, 61_000, nowMs);
    const taken = acquireLock(path, { now_ms: nowMs });
    expect(taken.ok && taken.took_over_stale).toBe(true);
    if (taken.ok) taken.release();
    expect(existsSync(path)).toBe(false);
  });

  it("en fersk lås gir took_over_stale = false", () => {
    const r = acquireLock(join(tmp(), ".x.lock"));
    expect(r.ok && r.took_over_stale).toBe(false);
    if (r.ok) r.release();
  });
});

describe("replaceFileAtomically: re-lesing rett før rename og wx på midlertidig fil", () => {
  it("written: innholdet byttes, ingen midlertidig fil blir igjen", () => {
    const dir = tmp();
    const file = join(dir, "a.json");
    const t = join(dir, ".a.json.tmp-1");
    writeFileSync(file, "gammelt");
    expect(replaceFileAtomically({ file, tmp: t, text: "nytt", unchanged: () => true })).toBe("written");
    expect(readFileSync(file, "utf8")).toBe("nytt");
    expect(existsSync(t)).toBe(false);
  });

  it("changed_since_read: filen er rørt av en annen, så den skrives ikke og vår midlertidige fil ryddes", () => {
    const dir = tmp();
    const file = join(dir, "a.json");
    const t = join(dir, ".a.json.tmp-1");
    writeFileSync(file, "gammelt");
    expect(replaceFileAtomically({ file, tmp: t, text: "nytt", unchanged: () => false })).toBe("changed_since_read");
    expect(readFileSync(file, "utf8")).toBe("gammelt");
    expect(existsSync(t)).toBe(false);
  });

  it("kastes det i re-lesingen, ryddes den midlertidige filen og feilen går videre", () => {
    const dir = tmp();
    const file = join(dir, "a.json");
    const t = join(dir, ".a.json.tmp-1");
    writeFileSync(file, "gammelt");
    expect(() =>
      replaceFileAtomically({
        file,
        tmp: t,
        text: "nytt",
        unchanged: () => {
          throw new Error("boom");
        }
      })
    ).toThrow("boom");
    expect(existsSync(t)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("gammelt");
  });

  it("tmp_exists: en eksisterende midlertidig fil overskrives ALDRI (wx), og filen røres ikke", () => {
    const dir = tmp();
    const file = join(dir, "a.json");
    const t = join(dir, ".a.json.tmp-1");
    writeFileSync(file, "gammelt");
    writeFileSync(t, "en-annens-halvferdige-skriving");
    expect(replaceFileAtomically({ file, tmp: t, text: "nytt", unchanged: () => true })).toBe("tmp_exists");
    expect(readFileSync(t, "utf8")).toBe("en-annens-halvferdige-skriving");
    expect(readFileSync(file, "utf8")).toBe("gammelt");
  });
});

describe("recordGate: låsen i bruk (M1)", () => {
  it("en lås som holdes av en annen = concurrent_registration, ingenting skrives, og den andres lås røres ikke", () => {
    const { root } = withEvidence();
    const other = acquireLock(lockPath(root, "G01"));
    expect(other.ok).toBe(true);
    const r = rec(root);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problem).toBe("concurrent_registration");
    expect(gateJson(root).status).toBe("OPEN");
    expect(existsSync(lockPath(root, "G01"))).toBe(true);
    if (other.ok) other.release();
    expect(rec(root).ok).toBe(true);
    expect(gateJson(root).status).toBe("PASS");
  });

  it("låsen er per port: en annen port registreres uforstyrret mens G01 er låst", () => {
    const { root } = withEvidence();
    const other = acquireLock(lockPath(root, "G01"));
    expect(rec(root, { gate_id: "G02" }).ok).toBe(true);
    if (other.ok) other.release();
  });

  it("tørrkjøring tar ingen lås (og nektes ikke av en lås)", () => {
    const { root } = withEvidence();
    const other = acquireLock(lockPath(root, "G01"));
    const r = rec(root, { write: false });
    expect(r.ok && r.written).toBe(false);
    if (other.ok) other.release();
    expect(existsSync(lockPath(root, "G01"))).toBe(false);
  });

  it("låsen ryddes etter suksess, etter nektelse og når noe kaster (finally)", () => {
    const { root } = withEvidence();
    expect(rec(root).ok).toBe(true);
    expect(existsSync(lockPath(root, "G01"))).toBe(false);
    expect(rec(root).ok).toBe(false); // status_unchanged
    expect(existsSync(lockPath(root, "G01"))).toBe(false);
    expect(() =>
      rec(root, {
        status: "OPEN",
        evidence_path: null,
        now: "2026-11-26T15:00:00.000Z",
        _before_commit: () => {
          throw new Error("boom");
        }
      })
    ).toThrow("boom");
    expect(existsSync(lockPath(root, "G01"))).toBe(false);
    expect(readdirSync(join(root, "config/program/gates")).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("ugyldig manifest etter at låsen er tatt: data_invalid og låsen er ryddet", () => {
    const { root } = withEvidence();
    put(root, "config/program/manifest.json", "{ ikke json");
    const r = rec(root);
    expect(!r.ok && r.problem).toBe("data_invalid");
    expect(existsSync(lockPath(root, "G01"))).toBe(false);
  });

  it("en ugyldig port-id berører aldri filsystemet (ingen lås bygget av ukontrollert tekst)", () => {
    const { root } = withEvidence();
    const r = rec(root, { gate_id: "../G01" });
    expect(!r.ok && r.problem).toBe("gate_unknown");
    expect(readdirSync(join(root, "config/program")).filter((f) => f.endsWith(".lock"))).toEqual([]);
  });

  it("en foreldet lås (> 60 s) overtas med en tydelig advarsel; en lås på 59 s nektes", () => {
    const { root } = withEvidence();
    const path = lockPath(root, "G01");
    const stale = acquireLock(path);
    expect(stale.ok).toBe(true);
    age(path, 59_000, Date.now());
    expect(rec(root).ok).toBe(false);
    age(path, 120_000, Date.now());
    const r = rec(root);
    expect(r.ok).toBe(true);
    expect(r.ok && r.warnings.some((w) => w.includes("foreldet lås"))).toBe(true);
    expect(gateJson(root).status).toBe("PASS");
    expect(existsSync(path)).toBe(false);
  });

  it("re-lesing rett før rename: en annen skriver som rører port-filen etter at vi leste, gir concurrent_registration og den andres endring består", () => {
    const { root } = withEvidence();
    const r = rec(root, {
      _before_commit: () => {
        const g = JSON.parse(readFileSync(join(root, "config/program/gates/G01.json"), "utf8")) as Record<string, unknown>;
        put(root, "config/program/gates/G01.json", json({ ...g, title: "Endret av en annen skriver" }));
      }
    });
    expect(!r.ok && r.problem).toBe("concurrent_registration");
    const g = gateJson(root);
    expect(g.title).toBe("Endret av en annen skriver");
    expect(g.status).toBe("OPEN");
    expect(g.history).toEqual([]);
    expect(readdirSync(join(root, "config/program/gates")).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("uendret port-fil i re-lesingen: registreringen går gjennom (hooken alene stopper ingenting)", () => {
    const { root } = withEvidence();
    let called = 0;
    const r = rec(root, { _before_commit: () => void (called += 1) });
    expect(r.ok).toBe(true);
    expect(called).toBe(1);
  });

  it("en midlertidig fil med samme navn finnes fra før: nektes (wx) uten å overskrive den, og porten er uendret", () => {
    const { root } = withEvidence();
    const t = join(root, "config/program/gates", `.G01.json.tmp-${process.pid}`);
    writeFileSync(t, "halvferdig-fra-en-annen");
    const r = rec(root);
    expect(!r.ok && r.problem).toBe("concurrent_registration");
    expect(readFileSync(t, "utf8")).toBe("halvferdig-fra-en-annen");
    expect(gateJson(root).status).toBe("OPEN");
  });

  it("ORL-registrering bruker sin egen lås per nivå (orl-mappen)", () => {
    const { root } = withEvidence();
    const other = acquireLock(lockPath(root, "ORL0"));
    const r = rec(root, { gate_id: "ORL0" });
    expect(!r.ok && r.problem).toBe("concurrent_registration");
    if (other.ok) other.release();
    expect(rec(root, { gate_id: "ORL0" }).ok).toBe(true);
  });
});

describe("refreshFingerprints: samme lås og re-lesing per komponent (M1)", () => {
  const NOW_FP = "2026-12-01T08:00:00.000Z";
  const alphaPath = (root: string) => join(root, "config/program/components/core.alpha.json");
  const changeContract = (root: string) => put(root, "contracts/a.ts", "export const a = 2;\n");

  it("en lås som holdes: komponenten oppdateres ikke, problemet navngir samtidigheten, og den andres lås røres ikke", () => {
    const { root } = miniRepo();
    changeContract(root);
    const before = readFileSync(alphaPath(root), "utf8");
    const other = acquireLock(lockPath(root, "core.alpha"));
    const res = refreshFingerprints(root, { write: true, now: NOW_FP });
    expect(res[0]?.written).toBe(false);
    expect(res[0]?.problem).toContain("samtidig");
    expect(readFileSync(alphaPath(root), "utf8")).toBe(before);
    expect(existsSync(lockPath(root, "core.alpha"))).toBe(true);
    if (other.ok) other.release();
    expect(refreshFingerprints(root, { write: true, now: NOW_FP })[0]?.written).toBe(true);
    expect(existsSync(lockPath(root, "core.alpha"))).toBe(false);
  });

  it("tørrkjøring tar ingen lås", () => {
    const { root } = miniRepo();
    changeContract(root);
    const other = acquireLock(lockPath(root, "core.alpha"));
    const res = refreshFingerprints(root, { write: false, now: NOW_FP });
    expect(res[0]).toMatchObject({ changed: true, written: false, problem: null });
    if (other.ok) other.release();
  });

  it("foreldet lås overtas med en merknad", () => {
    const { root } = miniRepo();
    changeContract(root);
    const path = lockPath(root, "core.alpha");
    expect(acquireLock(path).ok).toBe(true);
    age(path, 120_000, Date.now());
    const res = refreshFingerprints(root, { write: true, now: NOW_FP });
    expect(res[0]).toMatchObject({ written: true, problem: null });
    expect(res[0]?.note).toContain("foreldet lås");
    expect(existsSync(path)).toBe(false);
  });

  it("re-lesing: en annen skriver endret skjerven etter at vi leste = samtidig endring, den andres versjon består", () => {
    const { root } = miniRepo();
    changeContract(root);
    const res = refreshFingerprints(root, {
      write: true,
      now: NOW_FP,
      _before_commit: () => {
        const s = JSON.parse(readFileSync(alphaPath(root), "utf8")) as Record<string, unknown>;
        put(root, "config/program/components/core.alpha.json", json({ ...s, title: "Endret av en annen skriver" }));
      }
    });
    expect(res[0]?.written).toBe(false);
    expect(res[0]?.problem).toContain("samtidig");
    expect((JSON.parse(readFileSync(alphaPath(root), "utf8")) as { title: string }).title).toBe("Endret av en annen skriver");
    expect(readdirSync(join(root, "config/program/components")).filter((f) => f.includes(".tmp-"))).toEqual([]);
    expect(existsSync(lockPath(root, "core.alpha"))).toBe(false);
  });

  it("en midlertidig fil med samme navn finnes fra før: nektes uten å overskrive den", () => {
    const { root } = miniRepo();
    changeContract(root);
    const t = join(root, "config/program/components", `.core.alpha.json.tmp-${process.pid}`);
    writeFileSync(t, "halvferdig-fra-en-annen");
    const res = refreshFingerprints(root, { write: true, now: NOW_FP });
    expect(res[0]?.written).toBe(false);
    expect(res[0]?.problem).toContain("samtidig");
    expect(readFileSync(t, "utf8")).toBe("halvferdig-fra-en-annen");
  });
});

/** Én løpsrunde: to ekte prosesser (PASS og FAIL) mot samme port, startet på samme tidspunkt etter at begge er klare. */
function raceTrial(): Promise<{ results: Array<{ ok: boolean; problem?: string }>; history: string[]; status: string }> {
  const { root } = withEvidence();
  const spawnOne = (status: "PASS" | "FAIL") =>
    new Promise<{ ready: Promise<void>; go: (t0: number) => void; done: Promise<{ ok: boolean; problem?: string }> }>((resolveSpawn) => {
      const child = spawn(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", WORKER, root, status, "docs/evidence/e1.md"], { stdio: ["pipe", "pipe", "inherit"], shell: false });
      let out = "";
      let readyResolve: () => void = () => undefined;
      const ready = new Promise<void>((r) => (readyResolve = r));
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString("utf8");
        if (out.includes("READY\n")) readyResolve();
      });
      const done = new Promise<{ ok: boolean; problem?: string }>((resolveDone, reject) => {
        child.on("error", reject);
        child.on("close", () => {
          const line = out.split("\n").filter((l) => l.startsWith("{"))[0];
          if (line === undefined) reject(new Error(`ingen resultatlinje fra barneprosessen: ${out}`));
          else resolveDone(JSON.parse(line) as { ok: boolean; problem?: string });
        });
      });
      resolveSpawn({ ready, go: (t0) => child.stdin.end(`GO ${t0}\n`), done });
    });
  return (async () => {
    const [a, b] = await Promise.all([spawnOne("PASS"), spawnOne("FAIL")]);
    await Promise.all([a.ready, b.ready]);
    const t0 = Date.now() + 150;
    a.go(t0);
    b.go(t0);
    const results = await Promise.all([a.done, b.done]);
    const g = gateJson(root);
    return { results, history: g.history.map((h) => `${h.prior_status}>${h.new_status}`), status: g.status };
  })();
}

describe("M1: løpstest med to ekte prosesser (reviewerens `race.ts`: 15 av 30 tapte en oppdatering uten låsen)", () => {
  it("12 samtidige PASS/FAIL-par: aldri to `ok` med bare én overgang i historikken; nøyaktig én ok + concurrent_registration, eller to ok med BEGGE overgangene", { timeout: 180_000 }, async () => {
    let conflicts = 0;
    for (let i = 0; i < 12; i += 1) {
      const t = await raceTrial();
      const oks = t.results.filter((r) => r.ok).length;
      const refused = t.results.filter((r) => !r.ok);
      for (const r of refused) expect(r.problem, `forsøk ${i}`).toBe("concurrent_registration");
      if (oks === 2) {
        expect(t.history.length, `forsøk ${i}: to ok men ${t.history.join(",")} (tapt oppdatering)`).toBe(2);
        expect(t.history[0]?.startsWith("OPEN>")).toBe(true);
      } else {
        expect(oks, `forsøk ${i}`).toBe(1);
        expect(refused).toHaveLength(1);
        expect(t.history, `forsøk ${i}`).toHaveLength(1);
        conflicts += 1;
      }
      expect(["PASS", "FAIL"]).toContain(t.status);
    }
    // Uten ekte samtidighet ville testen vært tom: startsignalet er felles, så minst én av 12 runder må ha kollidert.
    expect(conflicts).toBeGreaterThanOrEqual(1);
  });
});

void EVIDENCE_AT;
void EVIDENCE_SHA;
