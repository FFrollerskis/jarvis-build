import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  const credentialKeys = keysOf("onlyKeys(e, [");

  it("skjemaet har de forventede nøkkelgruppene (sanity: parseren finner noe)", () => {
    expect(runnerKeys.length).toBeGreaterThan(20);
    expect(publishKeys).toEqual(["max_bundle_bytes", "max_commits", "max_files", "deny_paths", "timeout_ms"]);
    expect(proxyKeys.length).toBeGreaterThanOrEqual(9);
    expect(credentialKeys).toEqual(["token_file", "source"]);
  });

  it("hver nøkkel i runner-, publish-, git_credentials- og egress_proxy-skjemaet står i runbooken som `nøkkel`", () => {
    for (const key of [...runnerKeys, ...publishKeys, ...credentialKeys, ...proxyKeys]) expect(runbook, key).toContain(`\`${key}\``);
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

  it("B-M3: standard allowlist er KUN api.anthropic.com:443 i kode, eksempel og runbook, og §16.8 beskriver eksfiltrering ærlig (angriper-PAT, høy båndbredde, restrisiko også med api.anthropic.com)", () => {
    expect(config).toContain('const DEFAULT_ALLOW = ["api.anthropic.com:443"];');
    expect(JSON.parse(read("infra/job-runner/job-runner.example.json")).egress_proxy.allow).toEqual(["api.anthropic.com:443"]);
    expect(runbook).toMatch(/\| `allow` \| `api\.anthropic\.com:443` \|/);
    expect(runbook).not.toContain("allowlist github.com / api.github.com / api.anthropic.com");
    const section = runbook.slice(runbook.indexOf("8. **Egress-proxyen er den eneste veien ut"), runbook.indexOf("9. **Logg og feil"));
    expect(section.length).toBeGreaterThan(1500);
    for (const phrase of ["angriper-eid", "HVILKEN SOM HELST PAT", "Båndbredden er høy", "Files-API", "ikke bygget", "ADVARSEL"]) expect(section, phrase).toContain(phrase);
    expect(section).not.toContain("lav båndbredde");
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

describe("D: nft-eksempelet i runbooken", () => {
  // Blokken står inne i en punktliste i runbooken (innrykket): finn den uavhengig av innrykk og fjern innrykket før den brukes/sjekkes.
  const found = /^([ \t]*)```\n\1(table inet jarvis_jobs \{[\s\S]*?\n\1\})\n\1```/m.exec(runbook);
  const indent = found?.[1] ?? "";
  const block = (found?.[2] ?? "").split("\n").map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line)).join("\n");

  it("finnes, og verdiene (bridge, gateway, port) er de samme som setup-network.sh og eksempelkonfigen bruker", () => {
    expect(block.length).toBeGreaterThan(100);
    const example = JSON.parse(read("infra/job-runner/job-runner.example.json"));
    const script = read("infra/job-runner/setup-network.sh");
    const bridge = /^BRIDGE_NAME="([^"]+)"$/m.exec(script)?.[1];
    expect(block).toContain(`iifname "${bridge}"`);
    expect(block).toContain(`ip daddr ${example.egress_proxy.listen_host} tcp dport ${example.egress_proxy.listen_port} accept`);
    expect(block).toMatch(/reject with tcp reset/);
  });

  it("er gyldig syntaks for ekte nft (-c = kun sjekk, laster ingenting); hoppes over uten nft eller netlink-tilgang", () => {
    const nft = ["/usr/sbin/nft", "/sbin/nft", "/usr/bin/nft"].find((p) => existsSync(p));
    if (!nft) return;
    // nft nekter /dev/stdin som kilde («Not a regular file»): skriv regelteksten til en midlertidig fil (kun lesing/sjekk, ingenting lastes).
    const dir = mkdtempSync(join(tmpdir(), "jr-nft-"));
    try {
      const check = (text) => {
        const file = join(dir, "rules.nft");
        writeFileSync(file, text, { mode: 0o600 });
        return spawnSync(nft, ["-c", "-f", file], { encoding: "utf8", timeout: 30_000 });
      };
      const good = check(`${block}\n`);
      if (good.error || /operation not permitted|cache initialization failed|permission denied/i.test(good.stderr ?? "")) return; // krever netlink (root)
      expect(good.status, good.stderr).toBe(0);
      // negativ kontroll: ødelagt syntaks avvises (probeen er følsom)
      expect(check(`${block.replace("tcp dport 3128 accept", "tcp dport accept")}\n`).status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("E: kapittel 15 (kortlevd git-token fra worker) stemmer med koden", () => {
  const lib = (name) => read(`ops/job-runner/lib/${name}`);
  const sources = `${lib("jobs.mjs")}\n${lib("schemas.mjs")}\n${lib("credentials.mjs")}`;
  const chapter = runbook.slice(runbook.indexOf("## 15. "));

  it("kapittelet finnes, er AV som standard og sier ærlig hva som ikke er verifisert", () => {
    expect(chapter.length).toBeGreaterThan(1500);
    expect(chapter).toMatch(/AV som standard/);
    expect(chapter).toContain("NOT VERIFIED");
    expect(chapter).toContain("tillitsutvidelse");
    expect(chapter).toContain("ikke gjort i WP-C1");
  });

  it("hver feilkode runbooken nevner for git_token finnes i koden, og hver slik kode i koden står i runbooken", () => {
    // `git_token_file` er etiketten på PAT-fil-lesingen (ikke en feilkode)
    const inCode = new Set([...sources.matchAll(/"(git_token_[a-z_]+)"/g)].map((m) => m[1]).filter((x) => x !== "git_token_file"));
    expect([...inCode].sort()).toEqual(["git_token_in_env", "git_token_invalid", "git_token_not_accepted", "git_token_required"]);
    for (const code of inCode) expect(runbook, code).toContain(code);
    const inDoc = new Set([...runbook.matchAll(/\bgit_token_[a-z_]+\b/g)].map((m) => m[0]).filter((x) => !["git_token_file"].includes(x)));
    for (const code of inDoc) expect(inCode.has(code), `${code} står i runbooken men ikke i koden`).toBe(true);
  });

  it("standarden i koden er `file` (PAT-fil), og `request` er en eksplisitt, per-repo opt-in som kapittelet beskriver", async () => {
    const { validateConfig } = await import("../lib/config.mjs");
    const base = { token_file: "/etc/jarvis/job-runner.token", image: `sha256:${"a".repeat(64)}`, network: "jarvis-jobs", egress_proxy_url: "http://172.30.77.1:3128", allowed_repos: ["a/b"] };
    expect(validateConfig({ version: 1, runner: { ...base, git_credentials: { "a/b": { token_file: "/etc/x" } } } }, { require: ["runner"] }).runner.gitCredentials["a/b"].source).toBe("file");
    expect(chapter).toContain('{ "source": "request" }');
    expect(chapter).toContain("sudo systemctl restart jarvis-job-runner");
  });

  it("ACCEPTANCE_GIT_TOKEN_FILE finnes i scriptet og i runbooken; enhetene har LimitCORE=0 som kapittelet sier", () => {
    expect(acceptance).toContain("ACCEPTANCE_GIT_TOKEN_FILE");
    expect(runbook).toContain("ACCEPTANCE_GIT_TOKEN_FILE");
    for (const unit of ["jarvis-job-runner.service", "jarvis-egress-proxy.service"]) expect(read(`infra/job-runner/${unit}`)).toMatch(/^LimitCORE=0$/m);
    expect(chapter).toContain("LimitCORE=0");
  });

  it("kapittelet viser aldri et ekte token (bare plassholdere som ghs_…)", () => {
    expect(chapter).not.toMatch(/gh[sp]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}/);
  });

  it("kapittel 16 (sikkerhetsantagelser) finnes, nevner deny-listen for env-navn ærlig og peker på koden som håndhever den", () => {
    const section = runbook.slice(runbook.indexOf("## 16. "));
    expect(section.length).toBeGreaterThan(2000);
    expect(section).toContain("deny-liste");
    expect(section).toContain("--env-file");
    expect(section).toContain("HOST_RUNNER_FORBIDDEN_ENV");
    expect(read("modules/tasks/src/job-container-spec.mjs")).toContain("HOST_RUNNER_FORBIDDEN_ENV");
    expect(section).toContain("NOT VERIFIED");
  });
});
