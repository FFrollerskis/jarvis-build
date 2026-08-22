import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import type { DeviceService, IdentityService, SessionService } from "@jarvis/core";
import {
  acquireContainerLogs, attemptRecovery, correlateDbState, correlateIncident, dockerProviderStatus, executeInfraMutation,
  getInfraExecution, proposeRepairTask, type DeploymentService, type DiagnosisService, type IncidentService
} from "@jarvis/incidents";
import type { InfraExecutionGate, OwnerControls, PolicyGateway } from "@jarvis/policy";
import type { InProcessWorker, TaskService } from "@jarvis/tasks";
import type { ToolGateway } from "@jarvis/tool-gateway";
import type { ConversationEngine } from "./conversation.ts";
import type { AuthStrength, Channel, MemorySpace } from "@jarvis/contracts";

/**
 * Fase 3: minimalt API uten rammeverk (rammeverksvalg utsatt til behovet
 * krever det). Ruter: /health, / (webchat), /chat (SSE/JSON),
 * /tools/critical-demo (klasse D-stub for policybevis i kjørende app).
 *
 * Merk: API-et binder localhost i dev og har ingen egen HTTP-autentisering
 * ennå - enhetsautentisering kommer med kanalene i senere faser (dokumentert).
 */
export interface ApiDeps {
  identity: IdentityService;
  sessions: SessionService;
  conversation: ConversationEngine;
  policy: PolicyGateway;
  worker: InProcessWorker;
  /** Fase 8: enhetsregistrering/challenge-auth for mobil/Watch. */
  devices?: DeviceService;
  /** v4.0 BO-02: Daily Executive Brief on demand. */
  brief?: { generate(identity: unknown): Promise<unknown>; render(artifact: unknown): string };
  /**
   * D-102 (UA-5 Production Real Coding Agent / Tested-Fix Pipeline Wiring v1):
   * SAMME `TaskService`-instans som allerede konstrueres for `ConversationEngine`
   * (main.ts) - eksponerer den EKSISTERENDE, allerede validerte/policy-håndhevede
   * `submit()`-metoden (full `JobContract`, klasse B) over HTTP i stedet for å
   * bygge en ny innsendingsmekanisme. Valgfritt: uten database-avhengigheter
   * kjører API-et i helse-modus (samme mønster som `worker`/`brief`).
   */
  tasks?: TaskService;
  /**
   * D-104 (UA-5 Production Operations Control Plane v1): valgfritt - uten
   * database-avhengigheter kjører API-et i helse-modus (samme mønster som
   * `tasks`/`worker`/`brief`). `gate`/`infraToolIds` er DEN SAMME
   * `InfraExecutionGate`-instansen `PolicyGateway` allerede håndhever -
   * disse rutene MUTERER kun dens tilstand, de omgår ALDRI `policy.
   * authorize()` (hver rute kaller `policy.authorize()` FØRST, identisk
   * mønster som `/tools/critical-demo`).
   */
  incidents?: {
    service: IncidentService;
    deployments: DeploymentService;
    /** D-105: valgfritt - diagnose-rutene forblir 404 uten den (samme mønster som `tasks`). */
    diagnosis?: DiagnosisService;
    gateway: ToolGateway;
    controls?: OwnerControls;
    infraGate: InfraExecutionGate;
    pool: pg.Pool;
  };
}

export interface HealthStatus {
  status: "ok";
  service: "jarvis-api";
  version: string;
  time: string;
}

export function healthStatus(): HealthStatus {
  return { status: "ok", service: "jarvis-api", version: "0.1.0", time: new Date().toISOString() };
}

interface ChatBody {
  person_id: string;
  tenant_id: string;
  device_id: string;
  memory_space: MemorySpace;
  channel: Channel;
  auth_strength?: AuthStrength;
  message: string;
  /** BO-12 §33: valgfri owner-override av LLM-provider (router §38-semantikk). */
  provider?: string;
}

const WEB_INDEX = fileURLToPath(new URL("../../web/index.html", import.meta.url));

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createApiServer(deps?: ApiDeps): Server {
  return createServer((req, res) => {
    void route(req, res, deps).catch((err: Error) => {
      if (!res.headersSent) {
        json(res, 500, { error: "internal_error", message: err.message });
      } else {
        res.end();
      }
    });
  });
}

async function route(req: IncomingMessage, res: ServerResponse, deps?: ApiDeps): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, healthStatus());
  }

  if (req.method === "GET" && url.pathname === "/") {
    const html = await readFile(WEB_INDEX, "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  const depRoutes = [
    "/chat", "/worker/tick", "/tools/critical-demo", "/tasks/submit",
    "/incidents/create", "/incidents/get", "/incidents/list", "/incidents/evidence/add", "/incidents/correlate", "/incidents/repair",
    "/infra/recovery/attempt", "/infra/pause", "/infra/resume", "/infra/degrade", "/infra/status"
  ];
  if (!deps) {
    if (depRoutes.includes(url.pathname)) {
      return json(res, 503, { error: "not_configured", message: "API kjører uten database-avhengigheter" });
    }
    return json(res, 404, { error: "not_found" });
  }

  if (req.method === "POST" && url.pathname === "/chat") {
    const body = (await readBody(req)) as ChatBody;
    const session = await deps.sessions.resumeOrCreate(
      { tenant_id: body.tenant_id, person_id: body.person_id, device_id: body.device_id },
      body.channel
    );
    const resolved = await deps.identity.resolveIdentity({
      person_id: body.person_id,
      tenant_id: body.tenant_id,
      memory_space: body.memory_space,
      session_id: session.session_id,
      device_id: body.device_id,
      channel: body.channel,
      auth_strength: body.auth_strength ?? "active"
    });
    if (!resolved.ok) {
      return json(res, 403, { error: "identity_denied", reason: resolved.reason });
    }

    const wantsStream = (req.headers.accept ?? "").includes("text/event-stream");
    if (wantsStream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      // D-30 HOST BLOCKER §1/§2 (spørsmål D): valgfri diagnostikk - kun event-navn/
      // timing, ALDRI dataInnhold (aldri token-tekst/secrets), kun når eksplisitt på.
      const streamDebug = process.env["JARVIS_STREAM_DEBUG"] === "true";
      const tSseStart = Date.now();
      const send = (event: string, data: unknown) => {
        // Frakoblet socket får aldri flere events - og aldri duplisert 'done'.
        if (!res.writableEnded && !res.destroyed) {
          if (streamDebug) {
            console.error(JSON.stringify({ msg: "stream_debug_sse_write", event, at_ms: Date.now() - tSseStart }));
          }
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
      };
      // BO-11.1 §6/§8 (barge-in-fundament for D-30): klient-disconnect propagerer
      // hele veien - HTTP close → AbortSignal → ModelGateway → provider-upstream.
      // Ikke bare slutte å skrive til socketen mens provideren fortsetter.
      const abort = new AbortController();
      // 'close' på RESPONSEN fyrer når forbindelsen termineres for tidlig
      // (req-'close' fyrer ved fullført request-body i moderne Node - feil signal).
      res.on("close", () => {
        if (!res.writableEnded) {
          abort.abort();
        }
      });
      const result = await deps.conversation.handle(
        resolved.identity,
        body.message,
        (token) => send("token", { token }),
        abort.signal,
        body.provider,
        // D-30: trusted verktøy-aktivitet - kun tool_name, aldri args/resultat-JSON.
        // Voice-klientens HttpCoreClient forstår allerede `tool_call`-eventet.
        (toolName) => send("tool_call", { tool_name: toolName })
      );
      send("done", { ...result, session_id: session.session_id });
      res.end();
      return;
    }

    const result = await deps.conversation.handle(resolved.identity, body.message, undefined, undefined, body.provider);
    return json(res, 200, { ...result, session_id: session.session_id });
  }

  if (deps.brief && req.method === "POST" && url.pathname === "/brief") {
    const body = (await readBody(req)) as ChatBody;
    const session = await deps.sessions.resumeOrCreate(
      { tenant_id: body.tenant_id, person_id: body.person_id, device_id: body.device_id }, body.channel ?? "api"
    );
    const resolved = await deps.identity.resolveIdentity({
      person_id: body.person_id, tenant_id: body.tenant_id, memory_space: body.memory_space,
      session_id: session.session_id, device_id: body.device_id,
      channel: body.channel ?? "api", auth_strength: body.auth_strength ?? "active"
    });
    if (!resolved.ok) {
      return json(res, 403, { error: "identity_denied", reason: resolved.reason });
    }
    const artifact = await deps.brief.generate(resolved.identity);
    return json(res, 200, { brief: artifact, rendered: deps.brief.render(artifact), session_id: session.session_id });
  }

  if (deps.devices && req.method === "POST" && url.pathname === "/devices/register") {
    const body = (await readBody(req)) as {
      identity: Parameters<IdentityService["resolveIdentity"]>[0];
      device: { device_id: string; kind: string; public_key_pem: string };
    };
    const resolved = await deps.identity.resolveIdentity(body.identity);
    if (!resolved.ok) {
      return json(res, 403, { error: "identity_denied", reason: resolved.reason });
    }
    await deps.devices.registerDevice(resolved.identity, body.device);
    return json(res, 200, { registered: body.device.device_id });
  }

  if (deps.devices && req.method === "POST" && url.pathname === "/devices/challenge") {
    const body = (await readBody(req)) as { device_id: string };
    return json(res, 200, { challenge: deps.devices.issueChallenge(body.device_id) });
  }

  if (deps.devices && req.method === "POST" && url.pathname === "/devices/challenge/verify") {
    const body = (await readBody(req)) as {
      tenant_id: string; device_id: string; challenge: string; signature: string;
    };
    const ok = await deps.devices.verifyChallenge(body.tenant_id, body.device_id, body.challenge, body.signature);
    return json(res, ok ? 200 : 403, { verified: ok, auth_strength: ok ? "signed" : "passive" });
  }

  if (deps.tasks && req.method === "POST" && url.pathname === "/tasks/submit") {
    // D-102: minimal, provider-nøytral ingress for en fullstendig `JobContract`
    // (inkl. `agent_profile: "coding"`) - gjenbruker `TaskService.submit()`
    // UENDRET: kontraktvalidering (Zod), tenant-match, untrusted-privat-
    // minne-og-nettverk-invarianten, klasse B policy-autorisasjon og audit
    // skjer ALT i den eksisterende metoden. INGEN ny autorisasjonsmekanisme.
    const body = (await readBody(req)) as {
      identity: Parameters<IdentityService["resolveIdentity"]>[0] & { session_id: string };
      contract: unknown;
    };
    const resolved = await deps.identity.resolveIdentity(body.identity);
    if (!resolved.ok) {
      return json(res, 403, { error: "identity_denied", reason: resolved.reason });
    }
    const result = await deps.tasks.submit(resolved.identity, body.contract);
    if (!result.ok) {
      return json(res, 400, { error: "task_rejected", reason: result.reason });
    }
    return json(res, 200, { task_id: result.value.task_id });
  }

  if (req.method === "POST" && url.pathname === "/worker/tick") {
    // Dev-hjelper: kjør køen én runde (produksjonsworker kjører på intervall i main).
    const ran = await deps.worker.drain();
    return json(res, 200, { ran });
  }

  if (req.method === "POST" && url.pathname === "/tools/critical-demo") {
    // Klasse D-stub (fase 3-avgrensning): beviser at kritiske verktøy
    // blokkeres uten gyldig signert godkjenning i den KJØRENDE appen.
    const body = (await readBody(req)) as {
      identity: Parameters<IdentityService["resolveIdentity"]>[0] & { session_id: string };
      parameters: Record<string, never>;
      approval?: unknown;
    };
    const resolved = await deps.identity.resolveIdentity(body.identity);
    if (!resolved.ok) {
      return json(res, 403, { error: "identity_denied", reason: resolved.reason });
    }
    const decision = await deps.policy.authorize({
      identity: resolved.identity,
      toolCall: {
        tool_id: "demo",
        action: "critical_demo",
        capability_class: "D",
        parameters: body.parameters ?? {}
      },
      ...(body.approval !== undefined ? { approval: body.approval } : {})
    });
    if (decision.decision !== "ALLOW") {
      return json(res, 403, { decision: decision.decision, reason: decision.reason });
    }
    return json(res, 200, { decision: "ALLOW", executed: "critical_demo_stub" });
  }

  if (deps.incidents) {
    const { service, deployments, gateway, controls, infraGate, pool } = deps.incidents;

    if (req.method === "POST" && url.pathname === "/incidents/create") {
      const body = (await readBody(req)) as {
        identity: Parameters<IdentityService["resolveIdentity"]>[0];
        memory_space: MemorySpace; title: string; severity?: "low" | "normal" | "high" | "critical"; owner_person_id?: string;
      };
      const resolved = await deps.identity.resolveIdentity(body.identity);
      if (!resolved.ok) return json(res, 403, { error: "identity_denied", reason: resolved.reason });
      const incident = await service.createIncident(resolved.identity.tenant_id, body.memory_space, {
        title: body.title, ...(body.severity !== undefined ? { severity: body.severity } : {}),
        ...(body.owner_person_id !== undefined ? { owner_person_id: body.owner_person_id } : {})
      });
      return json(res, 200, { incident });
    }

    if (req.method === "POST" && url.pathname === "/incidents/get") {
      const body = (await readBody(req)) as {
        identity: Parameters<IdentityService["resolveIdentity"]>[0]; memory_space: MemorySpace; incident_id: string;
      };
      const resolved = await deps.identity.resolveIdentity(body.identity);
      if (!resolved.ok) return json(res, 403, { error: "identity_denied", reason: resolved.reason });
      const incident = await service.getIncident(resolved.identity.tenant_id, body.memory_space, body.incident_id);
      if (!incident) return json(res, 404, { error: "incident_not_found" });
      const evidence = await service.listEvidence(resolved.identity.tenant_id, body.memory_space, body.incident_id);
      return json(res, 200, { incident, evidence });
    }

    if (req.method === "POST" && url.pathname === "/incidents/list") {
      const body = (await readBody(req)) as {
        identity: Parameters<IdentityService["resolveIdentity"]>[0]; memory_space: MemorySpace;
        status?: "open" | "diagnosing" | "repair_proposed" | "repair_in_progress" | "resolved" | "wont_fix" | "all";
      };
      const resolved = await deps.identity.resolveIdentity(body.identity);
      if (!resolved.ok) return json(res, 403, { error: "identity_denied", reason: resolved.reason });
      const incidents = await service.listIncidents(resolved.identity.tenant_id, body.memory_space, body.status ?? "open");
      return json(res, 200, { incidents });
    }

    if (req.method === "POST" && url.pathname === "/incidents/evidence/add") {
      const body = (await readBody(req)) as {
        identity: Parameters<IdentityService["resolveIdentity"]>[0]; memory_space: MemorySpace; incident_id: string;
        source_type: string; status?: string; source_ref?: string; summary: string; observed_at: string; contradicts_evidence_id?: string;
      };
      const resolved = await deps.identity.resolveIdentity(body.identity);
      if (!resolved.ok) return json(res, 403, { error: "identity_denied", reason: resolved.reason });
      try {
        const evidence = await service.addEvidence(resolved.identity.tenant_id, body.memory_space, body.incident_id, {
          source_type: body.source_type as never, ...(body.status !== undefined ? { status: body.status as never } : {}),
          ...(body.source_ref !== undefined ? { source_ref: body.source_ref } : {}), summary: body.summary, observed_at: body.observed_at,
          ...(body.contradicts_evidence_id !== undefined ? { contradicts_evidence_id: body.contradicts_evidence_id } : {})
        });
        return json(res, 200, { evidence });
      } catch (err) {
        return json(res, 400, { error: "evidence_rejected", message: (err as Error).message });
      }
    }

    if (req.method === "POST" && url.pathname === "/incidents/correlate") {
      const body = (await readBody(req)) as {
        identity: Parameters<IdentityService["resolveIdentity"]>[0]; memory_space: MemorySpace; incident_id: string; repo: string;
      };
      const resolved = await deps.identity.resolveIdentity(body.identity);
      if (!resolved.ok) return json(res, 403, { error: "identity_denied", reason: resolved.reason });
      try {
        const correlation = await correlateIncident(service, deployments, resolved.identity.tenant_id, body.memory_space, body.incident_id, body.repo);
        return json(res, 200, { correlation });
      } catch (err) {
        return json(res, 404, { error: "correlation_failed", message: (err as Error).message });
      }
    }

    if (req.method === "POST" && url.pathname === "/incidents/correlate/db") {
      const body = (await readBody(req)) as {
        identity: Parameters<IdentityService["resolveIdentity"]>[0]; window_start: string; window_end: string;
      };
      const resolved = await deps.identity.resolveIdentity(body.identity);
      if (!resolved.ok) return json(res, 403, { error: "identity_denied", reason: resolved.reason });
      const db_state = await correlateDbState(pool, resolved.identity.tenant_id, body.window_start, body.window_end);
      return json(res, 200, { db_state });
    }

    if (req.method === "POST" && url.pathname === "/incidents/evidence/acquire_logs") {
      const body = (await readBody(req)) as {
        identity: Parameters<IdentityService["resolveIdentity"]>[0]; memory_space: MemorySpace; incident_id: string;
        container: string; since?: string; until?: string; tail?: number;
      };
      const resolved = await deps.identity.resolveIdentity(body.identity);
      if (!resolved.ok) return json(res, 403, { error: "identity_denied", reason: resolved.reason });
      const outcome = await acquireContainerLogs({ gateway, incidents: service }, resolved.identity, body.memory_space, body.incident_id, {
        container: body.container, ...(body.since !== undefined ? { since: body.since } : {}),
        ...(body.until !== undefined ? { until: body.until } : {}), ...(body.tail !== undefined ? { tail: body.tail } : {})
      });
      if (outcome.status === "unavailable") return json(res, 502, { error: "acquisition_unavailable", reason: outcome.reason });
      return json(res, 200, { evidence: outcome.evidence });
    }

    if (deps.incidents.diagnosis && req.method === "POST" && url.pathname === "/incidents/diagnosis/create") {
      const diagnosisService = deps.incidents.diagnosis;
      const body = (await readBody(req)) as {
        identity: Parameters<IdentityService["resolveIdentity"]>[0]; memory_space: MemorySpace; incident_id: string;
        conclusion: string; status?: string; source: string; supersedes_diagnosis_id?: string;
        supporting_evidence_ids?: string[]; contradicting_evidence_ids?: string[];
      };
      const resolved = await deps.identity.resolveIdentity(body.identity);
      if (!resolved.ok) return json(res, 403, { error: "identity_denied", reason: resolved.reason });
      try {
        const diagnosis = await diagnosisService.createDiagnosis(resolved.identity.tenant_id, body.memory_space, body.incident_id, {
          conclusion: body.conclusion, source: body.source as never, ...(body.status !== undefined ? { status: body.status as never } : {}),
          ...(body.supersedes_diagnosis_id !== undefined ? { supersedes_diagnosis_id: body.supersedes_diagnosis_id } : {}),
          ...(body.supporting_evidence_ids !== undefined ? { supporting_evidence_ids: body.supporting_evidence_ids } : {}),
          ...(body.contradicting_evidence_ids !== undefined ? { contradicting_evidence_ids: body.contradicting_evidence_ids } : {})
        });
        return json(res, 200, { diagnosis });
      } catch (err) {
        return json(res, 400, { error: "diagnosis_rejected", message: (err as Error).message });
      }
    }

    if (deps.incidents.diagnosis && req.method === "POST" && url.pathname === "/incidents/diagnosis/list") {
      const diagnosisService = deps.incidents.diagnosis;
      const body = (await readBody(req)) as {
        identity: Parameters<IdentityService["resolveIdentity"]>[0]; memory_space: MemorySpace; incident_id: string;
      };
      const resolved = await deps.identity.resolveIdentity(body.identity);
      if (!resolved.ok) return json(res, 403, { error: "identity_denied", reason: resolved.reason });
      const diagnoses = await diagnosisService.listDiagnoses(resolved.identity.tenant_id, body.memory_space, body.incident_id);
      return json(res, 200, { diagnoses });
    }

    if (req.method === "POST" && url.pathname === "/infra/execution/mutate") {
      const body = (await readBody(req)) as {
        identity: Parameters<IdentityService["resolveIdentity"]>[0];
        target: string; target_image: string; idempotency_key: string; incident_id?: string;
      };
      const resolved = await deps.identity.resolveIdentity(body.identity);
      if (!resolved.ok) return json(res, 403, { error: "identity_denied", reason: resolved.reason });
      const execution = await executeInfraMutation({ pool, gateway }, resolved.identity, {
        tenant_id: resolved.identity.tenant_id, person_id: resolved.identity.person_id,
        device_id: resolved.identity.device_id,
        target: body.target, target_image: body.target_image, idempotency_key: body.idempotency_key,
        ...(body.incident_id !== undefined ? { incident_id: body.incident_id } : {})
      });
      return json(res, 200, { execution });
    }

    if (req.method === "POST" && url.pathname === "/infra/execution/get") {
      const body = (await readBody(req)) as { identity: Parameters<IdentityService["resolveIdentity"]>[0]; execution_id: string };
      const resolved = await deps.identity.resolveIdentity(body.identity);
      if (!resolved.ok) return json(res, 403, { error: "identity_denied", reason: resolved.reason });
      const execution = await getInfraExecution(pool, resolved.identity.tenant_id, body.execution_id);
      if (!execution) return json(res, 404, { error: "execution_not_found" });
      return json(res, 200, { execution });
    }

    if (req.method === "POST" && url.pathname === "/observability/docker/status") {
      const body = (await readBody(req)) as { identity: Parameters<IdentityService["resolveIdentity"]>[0] };
      const resolved = await deps.identity.resolveIdentity(body.identity);
      if (!resolved.ok) return json(res, 403, { error: "identity_denied", reason: resolved.reason });
      const status = await dockerProviderStatus(gateway, resolved.identity);
      return json(res, 200, { status });
    }

    if (deps.tasks && req.method === "POST" && url.pathname === "/incidents/repair") {
      const body = (await readBody(req)) as {
        identity: Parameters<IdentityService["resolveIdentity"]>[0] & { session_id: string };
        memory_space: MemorySpace; incident_id: string; repo_url: string; goal: string;
        test_command?: string[]; publish_pr?: boolean; model_budget_ore?: number;
      };
      const resolved = await deps.identity.resolveIdentity(body.identity);
      if (!resolved.ok) return json(res, 403, { error: "identity_denied", reason: resolved.reason });
      const incident = await service.getIncident(resolved.identity.tenant_id, body.memory_space, body.incident_id);
      if (!incident) return json(res, 404, { error: "incident_not_found" });
      const result = await proposeRepairTask(
        { taskService: deps.tasks, pool, incidents: service },
        resolved.identity, body.memory_space, incident,
        {
          repo_url: body.repo_url, goal: body.goal, ...(body.test_command !== undefined ? { test_command: body.test_command } : {}),
          ...(body.publish_pr !== undefined ? { publishPr: body.publish_pr } : {}),
          ...(body.model_budget_ore !== undefined ? { model_budget_ore: body.model_budget_ore } : {})
        }
      );
      if (!result.ok) return json(res, 400, { error: "repair_task_rejected", reason: result.reason });
      return json(res, 200, { task_id: result.task_id });
    }

    if (req.method === "POST" && url.pathname === "/infra/recovery/attempt") {
      const body = (await readBody(req)) as {
        identity: Parameters<IdentityService["resolveIdentity"]>[0]; tool_id: string; action: string;
        idempotency_key: string; parameters: Record<string, never>; incident_id?: string; execution_id?: string;
      };
      const resolved = await deps.identity.resolveIdentity(body.identity);
      if (!resolved.ok) return json(res, 403, { error: "identity_denied", reason: resolved.reason });
      const decision = await deps.policy.authorize({
        identity: resolved.identity,
        toolCall: { tool_id: "infra", action: "attempt_recovery", capability_class: "B", parameters: { tool_id: body.tool_id, action: body.action } }
      });
      if (decision.decision !== "ALLOW") return json(res, 403, { decision: decision.decision, reason: decision.reason });
      const recovery = await attemptRecovery({ pool, gateway }, resolved.identity, {
        tenant_id: resolved.identity.tenant_id, tool_id: body.tool_id, action: body.action,
        idempotency_key: body.idempotency_key, parameters: body.parameters,
        ...(body.incident_id !== undefined ? { incident_id: body.incident_id } : {}),
        ...(body.execution_id !== undefined ? { execution_id: body.execution_id } : {})
      });
      return json(res, 200, { recovery });
    }

    if (req.method === "POST" && (url.pathname === "/infra/pause" || url.pathname === "/infra/resume" || url.pathname === "/infra/degrade")) {
      const body = (await readBody(req)) as { identity: Parameters<IdentityService["resolveIdentity"]>[0]; reason?: string };
      const resolved = await deps.identity.resolveIdentity(body.identity);
      if (!resolved.ok) return json(res, 403, { error: "identity_denied", reason: resolved.reason });
      const action = url.pathname.slice("/infra/".length);
      const decision = await deps.policy.authorize({
        identity: resolved.identity,
        toolCall: { tool_id: "infra", action, capability_class: "B", parameters: {} }
      });
      if (decision.decision !== "ALLOW") return json(res, 403, { decision: decision.decision, reason: decision.reason });
      if (action === "pause") infraGate.pause(body.reason ?? "owner_requested");
      else if (action === "degrade") infraGate.degrade(body.reason ?? "owner_requested");
      else infraGate.resume();
      return json(res, 200, { state: infraGate.current() });
    }

    if (req.method === "POST" && url.pathname === "/infra/status") {
      const body = (await readBody(req)) as { identity: Parameters<IdentityService["resolveIdentity"]>[0] };
      const resolved = await deps.identity.resolveIdentity(body.identity);
      if (!resolved.ok) return json(res, 403, { error: "identity_denied", reason: resolved.reason });
      return json(res, 200, {
        infra_mode: infraGate.current(),
        connector_health: Object.fromEntries(gateway.health),
        frozen_connectors: controls ? ["github"].filter((id) => controls.isFrozen(id)) : []
      });
    }
  }

  json(res, 404, { error: "not_found" });
}
