import { spawnSync } from "node:child_process";
import type { JsonValue } from "@jarvis/contracts";
import type { ToolTransport } from "./gateway.ts";

/**
 * D-105 (UA-5 kriterium 1+3): Docker Engine-transport - SAMME `docker`-CLI-
 * subprosess-mønster som `DockerSandboxRunner` allerede bruker (modules/
 * tasks/src/sandbox.ts, D-32), INGEN ny SDK. D-64: Docker-daemonen er
 * HYBRID_WITH_CLEAR_AUTHORITY - autoritativ for "hva kjører faktisk nå",
 * Jarvis forblir kanonisk for hendelse/diagnose/eksekusjonsjournal/policy
 * (se D-105 i DECISIONS_AND_ASSUMPTIONS.md).
 *
 * Lese-handlinger (`list_containers`/`inspect_container`/`get_logs`) virker
 * mot ETHVERT containernavn - reell driftsverdi for FAKTISK produksjons-
 * diagnostikk (Tobias sin ekte api/worker/postgres-stack, se `infra/local/
 * docker-compose.yml`). Den ENE MUTERENDE handlingen (`redeploy_container`)
 * er derimot HARDT begrenset til `jarvis-sentinel-*`-navn (se
 * `assertSentinelTarget()`) - en strukturell nektelse UAVHENGIG av policy/
 * risikoklasse (forsvar-i-dybden, samme prinsipp som GitHub-transportens
 * `PROTECTED_BRANCHES`-sperre mot main/master). Ingen ekte produksjons-
 * container kan noensinne muteres av denne transporten.
 */
const SENTINEL_PREFIX = "jarvis-sentinel-";

function assertSentinelTarget(name: string): void {
  if (!name.startsWith(SENTINEL_PREFIX)) {
    throw new Error(`docker_redeploy_refused_unsafe_target:${name}`);
  }
}

interface ContainerState {
  id: string;
  name: string;
  image: string;
  status: string;
  health: string | null;
  started_at: string | null;
  created_at: string | null;
  restart_count: number;
}

function run(bin: string, args: string[], timeoutMs: number): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(bin, args, { timeout: timeoutMs, encoding: "utf8", shell: false });
  if (result.error) {
    throw new Error(`docker_spawn_failed:${result.error.message}`);
  }
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function parseInspect(stdout: string): ContainerState {
  const raw = JSON.parse(stdout) as {
    Id: string; Name: string; Config: { Image: string };
    State: { Status: string; Health?: { Status: string }; StartedAt: string };
    Created: string; RestartCount: number;
  };
  return {
    id: raw.Id.slice(0, 12),
    name: raw.Name.replace(/^\//, ""),
    image: raw.Config.Image,
    status: raw.State.Status,
    health: raw.State.Health?.Status ?? null,
    started_at: raw.State.StartedAt ?? null,
    created_at: raw.Created ?? null,
    restart_count: raw.RestartCount ?? 0
  };
}

function redactSecretsInline(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]")
    .replace(/Authorization:\s*.*/gi, "Authorization: [REDACTED]")
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/sk-ant-[A-Za-z0-9\-_]{10,}/g, "[REDACTED_ANTHROPIC_KEY]")
    .replace(/((?:[A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*)(\S+)/gi, "$1[REDACTED]");
}

export class DockerTransport implements ToolTransport {
  constructor(private readonly timeoutMs = 15_000) {}

  /**
   * `credential` er den binære Docker-CLI-en (verdien av `JARVIS_DOCKER_BIN`,
   * hentet via `SecretProvider` av `ToolGateway` FØR dette kallet - IKKE en
   * hemmelighet i vanlig forstand, men gjenbruk av DEN SAMME "kreves
   * konfigurert for å være tilgjengelig"-porten som enhver annen tool_id
   * (samme mønster som `JARVIS_VERCEL_TOKEN`) - uten den er `docker`
   * strukturelt `credential_unavailable`, ALDRI et stille fall til en
   * ambient/uverifisert binærsti).
   */
  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string): Promise<{ external_id?: string; data?: JsonValue }> {
    const dockerBin = credential;
    if (action === "list_containers") {
      const labelFilter = typeof parameters["label_filter"] === "string" ? (parameters["label_filter"] as string) : undefined;
      const args = ["ps", "--format", "{{json .}}", ...(labelFilter ? ["--filter", `label=${labelFilter}`] : [])];
      const { code, stdout, stderr } = run(dockerBin, args, this.timeoutMs);
      if (code !== 0) throw new Error(`docker_ps_failed:${stderr.slice(0, 160)}`);
      const containers = stdout
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as JsonValue);
      return { data: containers as JsonValue };
    }

    if (action === "inspect_container") {
      const name = parameters["name"] as string;
      const { code, stdout, stderr } = run(dockerBin, ["inspect", name, "--format", "{{json .}}"], this.timeoutMs);
      if (code !== 0) {
        if (/No such (container|object)/i.test(stderr)) {
          // D-105: "finnes ikke ennå" er en GYLDIG tilstand (f.eks. FØRSTE
          // deploy av en sentinel) - ALDRI kastet som feil. Dette er
          // AVGJØRENDE for at ToolGateway sin D-pipeline-preflight (klasse D,
          // fail-closed på kastet feil) ikke stille NEKTER den aller
          // FØRSTE `redeploy_container`-mutasjonen mot et mål som
          // strukturelt ikke kan ha noen forutgående tilstand.
          return { data: null };
        }
        throw new Error(`docker_inspect_failed:${stderr.slice(0, 160)}`);
      }
      return { data: parseInspect(stdout) as unknown as JsonValue };
    }

    if (action === "get_logs") {
      const name = parameters["name"] as string;
      const since = typeof parameters["since"] === "string" ? (parameters["since"] as string) : undefined;
      const until = typeof parameters["until"] === "string" ? (parameters["until"] as string) : undefined;
      const requestedTail = typeof parameters["tail"] === "number" ? (parameters["tail"] as number) : 200;
      const tail = Math.min(Math.max(Math.trunc(requestedTail), 1), 200); // D-105 §D: hard grense, ALDRI ubegrenset rå loggdumping
      const args = [
        "logs", "--timestamps", "--tail", String(tail),
        ...(since ? ["--since", since] : []), ...(until ? ["--until", until] : []),
        name
      ];
      const { code, stdout, stderr } = run(dockerBin, args, this.timeoutMs);
      if (code !== 0) throw new Error(`docker_logs_failed:${stderr.slice(0, 160)}`);
      const lines = (stdout + stderr)
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          const spaceIdx = line.indexOf(" ");
          const timestamp = spaceIdx > 0 ? line.slice(0, spaceIdx) : new Date().toISOString();
          const message = spaceIdx > 0 ? line.slice(spaceIdx + 1) : line;
          return { timestamp, message: redactSecretsInline(message) };
        });
      return { data: lines as unknown as JsonValue };
    }

    if (action === "redeploy_container") {
      const name = parameters["name"] as string;
      const image = parameters["image"] as string;
      assertSentinelTarget(name);
      run(dockerBin, ["rm", "-f", name], this.timeoutMs); // best-effort - "finnes ikke" er OK (første deploy)
      const started = run(dockerBin, ["run", "-d", "--name", name, "--label", "jarvis.sentinel=true", "--label", "jarvis.managed=true", image, "sleep", "999999999"], this.timeoutMs);
      if (started.code !== 0) throw new Error(`docker_run_failed:${started.stderr.slice(0, 160)}`);
      const containerId = started.stdout.trim().slice(0, 12);
      const inspected = run(dockerBin, ["inspect", name, "--format", "{{json .}}"], this.timeoutMs);
      if (inspected.code !== 0) throw new Error(`docker_post_deploy_inspect_failed:${inspected.stderr.slice(0, 160)}`);
      return { external_id: containerId, data: parseInspect(inspected.stdout) as unknown as JsonValue };
    }

    throw new Error(`docker_unknown_action:${action}`);
  }
}
