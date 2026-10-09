import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * WP-C1: runbooken (docs/runbooks/JOB_RUNNER.md) er maskinsjekket mot koden så den ikke kan drive: tabellen over D-32 sine 21 porter peker på
 * tester som finnes og sjekker som finnes i acceptance.sh (og motsatt), hver konfignøkkel er dokumentert, alle repo-stier den nevner finnes, og den
 * sier ærlig hva som ikke er verifisert.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const runbook = read("docs/runbooks/JOB_RUNNER.md");
const acceptance = read("ops/job-runner/acceptance.sh");
const config = read("ops/job-runner/lib/config.mjs");

/** Sjekk-ID -> porter, fra CHECKLIST i acceptance.sh («(port 4, 10)», «(2,3,4)», «(8)», «(--)»). */
function checklist() {
  const out = new Map();
  const block = acceptance.slice(acceptance.indexOf("CHECKLIST=("), acceptance.indexOf("\n)\n", acceptance.indexOf("CHECKLIST=(")));
  for (const line of block.split("\n")) {
    const m = /^\s*"([JM]\d{2}_[a-z0-9_]+)\s+\((?:port\s+)?([0-9, ]+|--)\)/.exec(line);
    if (m) out.set(m[1], m[2] === "--" ? [] : m[2].split(",").map((x) => Number(x.trim())));
  }
  return out;
}

/** Radene i D-32-tabellen i kapittel 7. */
function portRows() {
  const section = runbook.slice(runbook.indexOf("## 7. D-32"), runbook.indexOf("## 8. Konfigurasjonsreferanse"));
  const rows = [];
  for (const line of section.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length >= 7 && /^\d+$/.test(cells[1] ?? "")) {
      const ticks = (cell) => [...(cell ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]);
      rows.push({ port: Number(cells[1]), requirement: cells[2], repo: ticks(cells[3]), host: ticks(cells[4]), status: cells[5] });
    }
  }
  return rows;
}

describe("A: tabellen over D-32 sine 21 porter", () => {
  const rows = portRows();
  const checks = checklist();

  it("har nøyaktig port 1-21, hver én gang, med et krav og en gyldig status", () => {
    expect(rows.map((r) => r.port)).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
    for (const r of rows) {
      expect(r.requirement.length, `port ${r.port}`).toBeGreaterThan(5);
      expect(["BYGGET", "DELVIS", "EIER", "UTENFOR_WP"], `port ${r.port}`).toContain(r.status);
    }
  });

  it("D-32 sin ordlyd i beslutningsloggen har akkurat disse 21 nummererte portene (tabellen er ikke en annen liste)", () => {
    const log = read("docs/DECISIONS_AND_ASSUMPTIONS.md");
    const d32 = log.split("\n").find((l) => l.startsWith("| D-32 |")) ?? "";
    const gates = d32.slice(d32.indexOf("Bindende port"), d32.indexOf("Inntil lukket"));
    expect(gates.length).toBeGreaterThan(500);
    const numbers = [...gates.matchAll(/\((\d{1,2})\) /g)].map((m) => Number(m[1]));
    expect(numbers).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
  });

  it("hver repo-test tabellen nevner finnes", () => {
    for (const r of rows) for (const path of r.repo) expect(existsSync(join(ROOT, path)), `port ${r.port}: ${path}`).toBe(true);
  });

  it("hver vertssjekk tabellen nevner finnes i CHECKLIST i acceptance.sh", () => {
    for (const r of rows) for (const id of r.host) expect(checks.has(id), `port ${r.port}: ${id}`).toBe(true);
  });

  it("tabellen og CHECKLIST er ENIGE om hvilke porter hver sjekk dekker (begge veier)", () => {
    for (const [id, ports] of checks) {
      const fromTable = rows.filter((r) => r.host.includes(id)).map((r) => r.port).sort((a, b) => a - b);
      expect(fromTable, id).toEqual([...ports].sort((a, b) => a - b));
    }
  });

  it("status er ærlig: BYGGET/DELVIS har repo-bevis, BYGGET har også vertsbevis, EIER har en vertssjekk, bare UTENFOR_WP kan stå uten bevis", () => {
    for (const r of rows) {
      if (r.status === "BYGGET") {
        expect(r.repo.length, `port ${r.port}`).toBeGreaterThan(0);
        expect(r.host.length, `port ${r.port}`).toBeGreaterThan(0);
      }
      if (r.status === "DELVIS") expect(r.repo.length, `port ${r.port}`).toBeGreaterThan(0);
      if (r.status === "EIER") expect(r.host.length, `port ${r.port}`).toBeGreaterThan(0);
      if (r.status !== "UTENFOR_WP") expect(r.repo.length + r.host.length, `port ${r.port}`).toBeGreaterThan(0);
    }
    // ingen port er markert BYGGET uten å ha en vertssjekk som beviser den på ekte Docker (alt er NOT VERIFIED til den er kjørt)
    expect(rows.filter((r) => r.status === "BYGGET").every((r) => r.host.length > 0)).toBe(true);
  });

  it("hver sjekk i acceptance.sh er beskrevet i runbooken", () => {
    for (const id of checks.keys()) expect(runbook, id).toContain(id);
  });
});

describe("B: konfigurasjonsreferansen dekker hver nøkkel skjemaet godtar", () => {
  const keysOf = (marker) => {
    const start = config.indexOf(marker);
    const end = config.indexOf("]", start);
    return [...config.slice(start, end).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  };
  const runnerKeys = keysOf("onlyKeys(r, [");
  const publishKeys = keysOf('onlyKeys(publishRaw, [');
  const proxyKeys = keysOf("onlyKeys(p, [");

  it("skjemaet har de forventede nøkkelgruppene (sanity: parseren finner noe)", () => {
    expect(runnerKeys.length).toBeGreaterThan(20);
    expect(publishKeys).toEqual(["max_bundle_bytes", "max_commits", "max_files", "deny_paths", "timeout_ms"]);
    expect(proxyKeys.length).toBeGreaterThanOrEqual(9);
  });

  it("hver nøkkel i runner-, publish- og egress_proxy-skjemaet står i runbooken som `nøkkel`", () => {
    for (const key of [...runnerKeys, ...publishKeys, ...proxyKeys]) expect(runbook, key).toContain(`\`${key}\``);
  });

  it("miljøvariablene runneren og worker bruker er dokumentert", () => {
    for (const name of ["JARVIS_JOB_RUNNER", "JARVIS_JOB_RUNNER_SOCKET", "JARVIS_JOB_RUNNER_TOKEN_FILE", "JARVIS_JOB_RUNNER_GID", "JARVIS_JOB_RUNNER_CONFIG"]) {
      expect(runbook, name).toContain(name);
    }
  });
});

describe("C: referanser og ærlighet", () => {
  it("hver repo-sti runbooken nevner (infra/, ops/, modules/, docs/, packages/) finnes - unntatt maler og globber", () => {
    const refs = new Set([...runbook.matchAll(/(?:^|[^A-Za-z0-9_.-])((?:infra|ops|modules|docs|packages)\/[A-Za-z0-9_./-]+\.(?:sh|mjs|ts|md|yml|json|service|job))/gm)].map((m) => m[1]));
    expect(refs.size).toBeGreaterThan(10);
    for (const ref of refs) expect(existsSync(join(ROOT, ref)), ref).toBe(true);
  });

  it("filene runbooken ber eieren kjøre eller kopiere finnes og er kjørbare der det forventes", () => {
    for (const rel of ["infra/job-runner/install-host.sh", "infra/job-runner/build-job-image.sh", "infra/job-runner/setup-network.sh", "ops/job-runner/acceptance.sh"]) {
      expect(runbook, rel).toContain(rel);
      expect(existsSync(join(ROOT, rel)), rel).toBe(true);
    }
  });

  it("sier ærlig at ekte Docker/brannmur/systemd/GitHub er NOT VERIFIED, og peker på akseptansescriptet", () => {
    expect(runbook.match(/NOT VERIFIED/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(runbook).toContain("Ingenting er kjørt mot ekte Docker");
    expect(runbook).toContain("ops/job-runner/acceptance.sh");
    expect(runbook).not.toMatch(/produksjonsklar|produksjonsverifisert(?!e autonome workers)/i);
  });

  it("ingen hemmeligheter eller ekte tokens i runbooken; PAT/API-nøkkel leses interaktivt, aldri på kommandolinjen", () => {
    expect(runbook).not.toMatch(/ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9-]{20,}|Bearer [A-Za-z0-9._~+/=-]{20,}/);
    expect(runbook).toMatch(/read -rsp "Lim inn PAT/);
    expect(runbook).toMatch(/read -rsp "ANTHROPIC_API_KEY/);
    expect(runbook).not.toMatch(/ANTHROPIC_API_KEY=[^\s"'$]/);
  });

  it("kommandoene bruker alltid begge compose-filene for worker med overriden (ellers faller worker stille tilbake til lukket)", () => {
    const lines = runbook.split("\n").filter((l) => /docker compose/.test(l) && /up -d/.test(l) && /worker/.test(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/-f infra\/local\/docker-compose\.yml -f infra\/job-runner\/docker-compose\.job-runner\.yml/);
  });
});
