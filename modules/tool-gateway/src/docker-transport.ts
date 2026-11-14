import { execFile } from "node:child_process";
import { scanForSecrets } from "@jarvis/core";
import type { JsonValue } from "@jarvis/contracts";
import type { ToolInvocationContext, ToolTransport } from "./gateway.ts";
import { abortReason, currentCallSignal } from "./call-signal.ts";

/**
 * D-105 (UA-5 kriterium 1+3): Docker Engine-transport - SAMME `docker`-CLI-
 * subprosess-mønster som `DockerSandboxRunner` allerede bruker (modules/
 * tasks/src/sandbox.ts, D-32), INGEN ny SDK. D-64: Docker-daemonen er
 * HYBRID_WITH_CLEAR_AUTHORITY - autoritativ for "hva kjører faktisk nå",
 * Jarvis forblir kanonisk for hendelse/diagnose/eksekusjonsjournal/policy
 * (se D-105 i DECISIONS_AND_ASSUMPTIONS.md).
 *
 * D-105 HOST-FIX (D-41-korreksjon, Tobias sin eksplisitte avgjørelse):
 * denne transporten TRANSPORTERER KUN - den inneholder INGEN permanent
 * mål-autorisasjonsregel (verken sentinel-only eller noe annet). Hvilke mål
 * en muterende handling faktisk får LOV til å nå avgjøres FØR transporten
 * i det hele tatt nås, av `docker-target-policy.ts` sin `authorizeDockerTarget()`
 * (håndhevet av `ToolGateway.execute()` via `ToolDefinition.parameter
 * Authorizer` - se gateway.ts og integrations.ts). Denne filen validerer KUN
 * at navn/image-parametre er strukturelt trygge argv-verdier (kommando-
 * injeksjons-/flagg-forveksling-forsvar - se `assertValidContainerName()`/
 * `assertValidImageRef()`), ALDRI en forretningsregel om HVEM som får mutere.
 */

/** Docker sitt eget navnealfabet. Avviser OGSÅ en ledende "-" (ellers tolkbar som et docker-CLI-flagg av selve docker-binæren, uavhengig av at spawnSync({shell:false}) allerede hindrer SHELL-injeksjon). */
const VALID_CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
/** Bevisst konservativt: registry/repo/tag-tegnsettet Docker faktisk bruker, ingen ledende "-". */
const VALID_IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9_./:@-]{0,255}$/;

function assertValidContainerName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !VALID_CONTAINER_NAME.test(name)) {
    throw new Error(`docker_invalid_container_name:${JSON.stringify(name).slice(0, 80)}`);
  }
}

function assertValidImageRef(image: unknown): asserts image is string {
  if (typeof image !== "string" || !VALID_IMAGE_REF.test(image)) {
    throw new Error(`docker_invalid_image_ref:${JSON.stringify(image).slice(0, 80)}`);
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

/**
 * D-394 (JARVIS-023): asynkron prosesskjøring. `spawnSync` blokkerte HELE Node-event-loopen (API HTTP/SSE/voice, worker-heartbeat) i opptil
 * `timeoutMs` per docker-kall; `execFile` lar resten av prosessen leve mens docker svarer. Samme semantikk som før: ikke-null exit-kode returneres,
 * spawn-feil/tidsavbrudd kaster `docker_spawn_failed`, utdata er begrenset (8 MB).
 */
function run(bin: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // WP-K (D-471, JARVIS-018): gatewayens kallsignal avbryter prosessen (SIGKILL) og hindrer at neste steg i en flertrinns-handling (rm -> run -> inspect) startes etter et tidsavbrudd.
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    execFile(bin, args, { timeout: timeoutMs, encoding: "utf8", killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024, ...(signal ? { signal } : {}) }, (error, stdout, stderr) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
        if (typeof code === "number" && !(error as { killed?: boolean }).killed) {
          resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
          return;
        }
        reject(new Error(`docker_spawn_failed:${error.message}`));
        return;
      }
      resolve({ code: 0, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
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
  // D-394 (JARVIS-069): lokale mønstre + den sentrale skanneren (JWT, private nøkler, Stripe/Slack/AWS/Google/Telegram, passordfraser, kortnumre).
  const local = text
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]")
    .replace(/Authorization:\s*.*/gi, "Authorization: [REDACTED]")
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/sk-ant-[A-Za-z0-9\-_]{10,}/g, "[REDACTED_ANTHROPIC_KEY]")
    .replace(/((?:[A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*)(\S+)/gi, "$1[REDACTED]");
  return scanForSecrets(local).text;
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
  async invoke(
    action: string, parameters: Record<string, JsonValue>, credential: string, _context?: ToolInvocationContext, signal?: AbortSignal
  ): Promise<{ external_id?: string; data?: JsonValue }> {
    const dockerBin = credential;
    const callSignal = signal ?? currentCallSignal();
    if (action === "list_containers") {
      const labelFilter = typeof parameters["label_filter"] === "string" ? (parameters["label_filter"] as string) : undefined;
      const args = ["ps", "--format", "{{json .}}", ...(labelFilter ? ["--filter", `label=${labelFilter}`] : [])];
      const { code, stdout, stderr } = await run(dockerBin, args, this.timeoutMs, callSignal);
      if (code !== 0) throw new Error(`docker_ps_failed:${stderr.slice(0, 160)}`);
      const containers = stdout
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as JsonValue);
      return { data: containers as JsonValue };
    }

    if (action === "inspect_container") {
      const name = parameters["name"];
      assertValidContainerName(name);
      const { code, stdout, stderr } = await run(dockerBin, ["inspect", name, "--format", "{{json .}}"], this.timeoutMs, callSignal);
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
      const name = parameters["name"];
      assertValidContainerName(name);
      const since = typeof parameters["since"] === "string" ? (parameters["since"] as string) : undefined;
      const until = typeof parameters["until"] === "string" ? (parameters["until"] as string) : undefined;
      const requestedTail = typeof parameters["tail"] === "number" ? (parameters["tail"] as number) : 200;
      const tail = Math.min(Math.max(Math.trunc(requestedTail), 1), 200); // D-105 §D: hard grense, ALDRI ubegrenset rå loggdumping
      const args = [
        "logs", "--timestamps", "--tail", String(tail),
        ...(since ? ["--since", since] : []), ...(until ? ["--until", until] : []),
        name
      ];
      const { code, stdout, stderr } = await run(dockerBin, args, this.timeoutMs, callSignal);
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
      const name = parameters["name"];
      const image = parameters["image"];
      assertValidContainerName(name);
      assertValidImageRef(image);
      await run(dockerBin, ["rm", "-f", "--", name], this.timeoutMs, callSignal); // best-effort - "finnes ikke" er OK (første deploy)
      const started = await run(dockerBin, ["run", "-d", "--name", name, "--label", "jarvis.sentinel=true", "--label", "jarvis.managed=true", "--", image, "sleep", "999999999"], this.timeoutMs, callSignal);
      if (started.code !== 0) throw new Error(`docker_run_failed:${started.stderr.slice(0, 160)}`);
      const containerId = started.stdout.trim().slice(0, 12);
      const inspected = await run(dockerBin, ["inspect", name, "--format", "{{json .}}"], this.timeoutMs, callSignal);
      if (inspected.code !== 0) throw new Error(`docker_post_deploy_inspect_failed:${inspected.stderr.slice(0, 160)}`);
      return { external_id: containerId, data: parseInspect(inspected.stdout) as unknown as JsonValue };
    }

    if (action === "stop_container") {
      const name = parameters["name"];
      assertValidContainerName(name);
      const stopped = await run(dockerBin, ["stop", "--", name], this.timeoutMs, callSignal);
      if (stopped.code !== 0) throw new Error(`docker_stop_failed:${stopped.stderr.slice(0, 160)}`);
      const inspected = await run(dockerBin, ["inspect", name, "--format", "{{json .}}"], this.timeoutMs, callSignal);
      if (inspected.code !== 0) throw new Error(`docker_post_stop_inspect_failed:${inspected.stderr.slice(0, 160)}`);
      return { data: parseInspect(inspected.stdout) as unknown as JsonValue };
    }

    if (action === "start_container") {
      const name = parameters["name"];
      assertValidContainerName(name);
      const started = await run(dockerBin, ["start", "--", name], this.timeoutMs, callSignal);
      if (started.code !== 0) throw new Error(`docker_start_failed:${started.stderr.slice(0, 160)}`);
      const inspected = await run(dockerBin, ["inspect", name, "--format", "{{json .}}"], this.timeoutMs, callSignal);
      if (inspected.code !== 0) throw new Error(`docker_post_start_inspect_failed:${inspected.stderr.slice(0, 160)}`);
      return { data: parseInspect(inspected.stdout) as unknown as JsonValue };
    }

    throw new Error(`docker_unknown_action:${action}`);
  }
}
