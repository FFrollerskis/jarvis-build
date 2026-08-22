import { randomUUID } from "node:crypto";
import type pg from "pg";
import { EventWriter, withTenantTransaction } from "@jarvis/core";
import type { DataSensitivity, JsonValue, ModelPurpose } from "@jarvis/contracts";
import { ModelGateway, type CompleteInput } from "./model-gateway.ts";
import { extractJson } from "./council.ts";
import type { ModelCapability } from "./capability-registry.ts";

/**
 * D-106 (AI Mesh Council/Collaboration/lokal-Gemma-utvidelse
 * §"multi-model collaboration"): genuint NY orkestrering, DISTINKT fra
 * `AiCouncil` (council.ts) - dette er faktisk SAMARBEID på ETT kanonisk
 * oppgave (ulike delOPPGAVER til ulike modeller, kryssgjennomgang, én
 * syntese), IKKE fem uavhengige meninger om SAMME spørsmål.
 *
 * Rolletildeling (§"task-specific roles"): 100% DETERMINISTISK kode
 * (`assignRoles()` under) - EKSEMPLENE i ordren (Gemma=koordinator/lokal-
 * rutine, Claude=koding/arkitektur, OpenAI=resonnering/verifikasjon,
 * Gemini=alternativ resonnering/multimodal, Kimi=forskning/lang kontekst) er
 * IKKE hardkodet som permanente regler - tildeling skjer via
 * `CapabilityRegistry`s `quality_class`/`capabilities` per `purpose`, samme
 * datadrevne prinsipp som `AiRouter` selv (§35: "en modell kan aldri velge
 * seg selv" - tildelingen skjer HER, i Jarvis-kode, ALDRI ved at en modell
 * velger sin egen rolle).
 *
 * Hver kontribusjon/kryssgjennomgang/revisjon/syntese er RENE
 * `ModelGateway.complete()`-kall (samme som council.ts) - budsjett/kost/
 * helse/trace/sensitivitet/paid_models_allowed håndheves derfor UENDRET.
 *
 * Q-26-ærlighet (kjent, eksplisitt DEFERRED omfang - IKKE skjult): "task
 * decomposition" (steg 1) er en enkel deterministisk-rutet ETT-kalls
 * nedbrytning når `subtasks` ikke er oppgitt eksplisitt - IKKE en
 * flerrunde planleggingsmotor. "Revisjon" (steg 5) og "verifikasjon"
 * (steg 7) er begge IMPLEMENTERT men opt-in (`enableRevisionRound`/
 * `enableVerification`) - ikke automatisk på for hver kjøring.
 */
export interface CollaborationSubtask {
  id: string;
  description: string;
  purpose?: ModelPurpose;
  required_capabilities?: ModelCapability[];
}

export interface CollaborationContribution {
  subtask_id: string;
  provider: string;
  role: string;
  output: string;
  cross_review?: { reviewer: string; review: string };
  revised?: boolean;
}

export interface CollaborationResult {
  collaboration_id: string;
  synthesis: string;
  contributions: CollaborationContribution[];
  verification?: { provider: string; verdict: string };
  provenance: {
    collaboration_id: string;
    goal: string;
    subtasks: CollaborationSubtask[];
    role_assignments: Array<{ subtask_id: string; provider: string; role: string }>;
    unassigned_subtasks: Array<{ subtask_id: string; reason: string }>;
    synthesis_provider: string;
  };
}

export interface CollaborationInput {
  tenant_id: string;
  session_id?: string;
  task_id?: string;
  goal: string;
  /** Utelates -> ETT deterministisk-rutet nedbrytningskall (§"task decomposition", se filkommentar). */
  subtasks?: CollaborationSubtask[];
  /** Utelates -> alle konfigurerte providere (`gateway.listConfiguredProviders()`) er kandidater. */
  candidateProviders?: string[];
  enableRevisionRound?: boolean;
  enableVerification?: boolean;
  sensitivity?: DataSensitivity;
  paid_models_allowed?: boolean;
}

const ROLE_LABELS: Record<ModelPurpose, string> = {
  CHAT: "general",
  QUICK_CLASSIFICATION: "classification",
  SUMMARIZE: "summarization",
  EXTRACT: "extraction",
  CODE: "coding",
  REASON: "reasoning",
  PLAN: "planning",
  RESEARCH: "research",
  CRITIQUE: "verification",
  VISION: "vision",
  BACKGROUND: "general"
};

const DECOMPOSITION_SCHEMA_HINT = `{"subtasks": [{"id": string, "description": string, "purpose": "CODE"|"REASON"|"PLAN"|"RESEARCH"|"SUMMARIZE"|"EXTRACT"|"CHAT"}]}`;

export class NoCandidateProvidersError extends Error {
  constructor() {
    super("no_candidate_providers: ingen konfigurerte providere tilgjengelig for samarbeidskjøring");
    this.name = "NoCandidateProvidersError";
  }
}

export class AiCollaboration {
  constructor(
    private readonly gateway: ModelGateway,
    private readonly pool?: pg.Pool
  ) {}

  async run(input: CollaborationInput): Promise<CollaborationResult> {
    const collaborationId = `collab-${randomUUID()}`;
    const candidates = input.candidateProviders ?? this.gateway.listConfiguredProviders();
    if (candidates.length === 0) {
      throw new NoCandidateProvidersError();
    }

    const commonInput = (provider: string, purpose?: ModelPurpose): CompleteInput => ({
      tenant_id: input.tenant_id,
      ...(input.session_id !== undefined ? { session_id: input.session_id } : {}),
      ...(input.task_id !== undefined ? { task_id: input.task_id } : {}),
      provider,
      ...(purpose !== undefined ? { purpose } : {}),
      ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
      ...(input.paid_models_allowed !== undefined ? { paid_models_allowed: input.paid_models_allowed } : {}),
      request: { messages: [{ role: "user" as const, content: "" }] }
    });

    // STEG 1 (nedbrytning): eksplisitt oppgitt VINNER alltid; ellers ETT
    // deterministisk-rutet (AUTO) kall som ber om en JSON-liste med delOPPGAVER.
    let subtasks: CollaborationSubtask[];
    if (input.subtasks && input.subtasks.length > 0) {
      subtasks = input.subtasks;
    } else {
      const decompInput: CompleteInput = {
        tenant_id: input.tenant_id,
        ...(input.session_id !== undefined ? { session_id: input.session_id } : {}),
        ...(input.task_id !== undefined ? { task_id: input.task_id } : {}),
        purpose: "PLAN" as const,
        ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
        ...(input.paid_models_allowed !== undefined ? { paid_models_allowed: input.paid_models_allowed } : {}),
        request: {
          system:
            "Bryt ned det gitte målet i 2-5 konkrete, uavhengig løsbare delOPPGAVER. Svar KUN med gyldig JSON: " +
            DECOMPOSITION_SCHEMA_HINT,
          messages: [{ role: "user", content: `MÅL:\n${input.goal}` }],
          max_tokens: 1024
        }
      };
      const decompResult = await this.gateway.complete(decompInput);
      const parsed = extractJson(decompResult.text) as { subtasks?: unknown } | undefined;
      const rawSubtasks = Array.isArray(parsed?.subtasks) ? (parsed.subtasks as unknown[]) : [];
      subtasks = rawSubtasks
        .filter((s): s is { id: unknown; description: unknown; purpose?: unknown } => typeof s === "object" && s !== null)
        .map((s, i) => ({
          id: typeof s.id === "string" && s.id.length > 0 ? s.id : `subtask-${i + 1}`,
          description: typeof s.description === "string" ? s.description : input.goal,
          ...(typeof s.purpose === "string" ? { purpose: s.purpose as ModelPurpose } : {})
        }));
      if (subtasks.length === 0) {
        // Nedbrytning ga ingen gyldige delOPPGAVER - fall tilbake til ÉN delOPPGAVE = hele målet, aldri en tom kjøring.
        subtasks = [{ id: "subtask-1", description: input.goal, purpose: "REASON" }];
      }
    }

    // STEG 2 (rolletildeling): 100% deterministisk kode - se filkommentar.
    const { assignments, unassigned } = this.assignRoles(subtasks, candidates);
    await this.persistEvent(input, collaborationId, "collaboration_role_assignment", {
      assignments: assignments.map((a) => ({ subtask_id: a.subtask_id, provider: a.provider, role: a.role })),
      unassigned
    });

    // STEG 3 (parallelt arbeid): hver tildelt provider løser SIN delOPPGAVE, samme kanoniske MÅL som kontekst.
    const contributions: CollaborationContribution[] = await Promise.all(
      assignments.map(async (a) => {
        const subtask = subtasks.find((s) => s.id === a.subtask_id) as CollaborationSubtask;
        const ci = commonInput(a.provider, subtask.purpose);
        ci.request = {
          system: `Du har fått rollen "${a.role}" i et samarbeid mellom flere AI-modeller om ETT felles mål. Løs KUN din delOPPGAVE.`,
          messages: [{ role: "user", content: `FELLES MÅL:\n${input.goal}\n\nDIN DELOPPGAVE:\n${subtask.description}` }],
          max_tokens: 1536
        };
        const result = await this.gateway.complete(ci);
        return { subtask_id: a.subtask_id, provider: a.provider, role: a.role, output: result.text };
      })
    );

    // STEG 4 (kryssgjennomgang): hver kontribusjon gjennomgås av EN ANNEN tildelt provider (round-robin) - aldri selvgjennomgang.
    if (contributions.length > 1) {
      await Promise.all(
        contributions.map(async (c, i) => {
          const reviewer = contributions[(i + 1) % contributions.length] as CollaborationContribution;
          if (reviewer.provider === c.provider) return; // kun én kontributør totalt uansett - ingen ekstern gjennomgang mulig
          const ci = commonInput(reviewer.provider, "CRITIQUE");
          ci.request = {
            system: "Du gjennomgår en annen AI-modells bidrag til et felles mål. Pek på faktiske feil, hull eller forbedringer - kompakt.",
            messages: [
              { role: "user", content: `FELLES MÅL:\n${input.goal}\n\nBIDRAG FRA ${c.provider} (rolle: ${c.role}):\n${c.output}` }
            ],
            max_tokens: 512
          };
          try {
            const reviewResult = await this.gateway.complete(ci);
            c.cross_review = { reviewer: reviewer.provider, review: reviewResult.text };
          } catch {
            // Kryssgjennomgang er kvalitetsforsterkning - en feilende gjennomgang fjerner ALDRI bidraget.
          }
        })
      );
    }

    // STEG 5 (revisjon, opt-in): kontributøren får sin egen gjennomgang tilbake, kan revidere.
    if (input.enableRevisionRound) {
      await Promise.all(
        contributions.map(async (c) => {
          if (!c.cross_review) return;
          const subtask = subtasks.find((s) => s.id === c.subtask_id) as CollaborationSubtask;
          const ci = commonInput(c.provider, subtask.purpose);
          ci.request = {
            system: "Du får en gjennomgang av ditt eget bidrag til et felles mål. Revider bidraget hvis gjennomgangen er treffende.",
            messages: [
              {
                role: "user",
                content: `DITT OPPRINNELIGE BIDRAG:\n${c.output}\n\nGJENNOMGANG MOTTATT (fra ${c.cross_review.reviewer}):\n${c.cross_review.review}\n\nSkriv ditt reviderte bidrag.`
              }
            ],
            max_tokens: 1536
          };
          try {
            const revised = await this.gateway.complete(ci);
            c.output = revised.text;
            c.revised = true;
          } catch {
            // Revisjon feilet - det opprinnelige bidraget står uendret, aldri tap av arbeid.
          }
        })
      );
    }
    await this.persistEvent(input, collaborationId, "collaboration_contributions", { contributions });

    // STEG 6 (syntese): ETT deterministisk QUALITY-rutet kall - Jarvis eier syntesen (samme prinsipp som council.ts).
    const digest = contributions
      .map((c) => `[${c.provider} - ${c.role}]\n${c.output}${c.cross_review ? `\n(gjennomgang fra ${c.cross_review.reviewer}: ${c.cross_review.review})` : ""}`)
      .join("\n\n");
    const synthesisInput: CompleteInput = {
      tenant_id: input.tenant_id,
      ...(input.session_id !== undefined ? { session_id: input.session_id } : {}),
      ...(input.task_id !== undefined ? { task_id: input.task_id } : {}),
      mode: "QUALITY" as const,
      purpose: "REASON" as const,
      ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
      ...(input.paid_models_allowed !== undefined ? { paid_models_allowed: input.paid_models_allowed } : {}),
      request: {
        system: "Syntetiser bidragene fra flere AI-modeller til ETT sammenhengende, ferdig svar på det felles målet.",
        messages: [{ role: "user", content: `FELLES MÅL:\n${input.goal}\n\nBIDRAG:\n${digest}` }],
        max_tokens: 2048
      }
    };
    const synthesisResult = await this.gateway.complete(synthesisInput);

    // STEG 7 (verifikasjon, opt-in): én distinkt provider verifiserer syntesen.
    let verification: CollaborationResult["verification"];
    if (input.enableVerification) {
      const verifier = candidates.find((p) => p !== synthesisResult.provider) ?? candidates[0];
      if (verifier) {
        try {
          const ci = commonInput(verifier, "CRITIQUE");
          ci.request = {
            system: "Verifiser om denne syntesen faktisk løser det oppgitte målet. Svar kort: OK eller PROBLEM, med begrunnelse.",
            messages: [{ role: "user", content: `MÅL:\n${input.goal}\n\nSYNTESE:\n${synthesisResult.text}` }],
            max_tokens: 512
          };
          const verifyResult = await this.gateway.complete(ci);
          verification = { provider: verifier, verdict: verifyResult.text };
        } catch {
          // Verifikasjon er en ekstra kvalitetssjekk - en feilende verifikasjon blokkerer ALDRI syntesen selv.
        }
      }
    }

    const result: CollaborationResult = {
      collaboration_id: collaborationId,
      synthesis: synthesisResult.text,
      contributions,
      ...(verification !== undefined ? { verification } : {}),
      provenance: {
        collaboration_id: collaborationId,
        goal: input.goal,
        subtasks,
        role_assignments: assignments.map((a) => ({ subtask_id: a.subtask_id, provider: a.provider, role: a.role })),
        unassigned_subtasks: unassigned,
        synthesis_provider: synthesisResult.provider
      }
    };
    await this.persistEvent(input, collaborationId, "collaboration_result", result as unknown as Record<string, unknown>);
    await this.persistArtifact(input, collaborationId, result);
    return result;
  }

  /**
   * 100% deterministisk rolletildeling (§"task-specific roles"): for hver
   * delOPPGAVE, velg den kandidaten med HØYEST `quality_class` blant dem som
   * dekker delOPPGAVENS `required_capabilities`/`purpose`-avledede krav og er
   * KONFIGURERT (§35: aldri en modell som velger seg selv - dette er ren
   * Jarvis-kode). Sprer arbeid over FLERE providere når mulig (unngår å
   * gjenbruke samme provider når et ubrukt alternativ finnes) - IKKE en
   * hardkodet "Claude=koding"-regel, kun en konsekvens av registry-tallene
   * (samme mønster som D-80 sin Gemma-first-ruting, `router.ts`).
   */
  private assignRoles(
    subtasks: CollaborationSubtask[],
    candidates: string[]
  ): {
    assignments: Array<{ subtask_id: string; provider: string; role: string }>;
    unassigned: Array<{ subtask_id: string; reason: string }>;
  } {
    const registry = this.gateway.capabilityRegistry;
    const used = new Set<string>();
    const assignments: Array<{ subtask_id: string; provider: string; role: string }> = [];
    const unassigned: Array<{ subtask_id: string; reason: string }> = [];
    for (const subtask of subtasks) {
      const required = new Set<ModelCapability>(subtask.required_capabilities ?? []);
      const pool = candidates
        .map((name) => ({ name, profile: registry.get(name) }))
        .filter((c) => c.profile && [...required].every((cap) => c.profile?.capabilities.includes(cap)));
      if (pool.length === 0) {
        unassigned.push({ subtask_id: subtask.id, reason: "no_candidate_covers_required_capabilities" });
        continue;
      }
      const unusedPool = pool.filter((c) => !used.has(c.name));
      const finalPool = unusedPool.length > 0 ? unusedPool : pool;
      finalPool.sort((a, b) => (b.profile?.quality_class ?? 0) - (a.profile?.quality_class ?? 0));
      const winner = finalPool[0] as (typeof finalPool)[number];
      used.add(winner.name);
      const role = subtask.purpose ? (ROLE_LABELS[subtask.purpose] ?? "general") : "general";
      assignments.push({ subtask_id: subtask.id, provider: winner.name, role });
    }
    return { assignments, unassigned };
  }

  private async persistEvent(input: CollaborationInput, collaborationId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.pool) return;
    try {
      const writer = new EventWriter(this.pool);
      await writer.append({
        event_id: randomUUID(),
        idempotency_key: `${collaborationId}:${type}`,
        occurred_at: new Date().toISOString(),
        source: "ai_collaboration",
        type,
        tenant_id: input.tenant_id,
        ...(input.session_id !== undefined ? { session_id: input.session_id } : {}),
        ...(input.task_id !== undefined ? { task_id: input.task_id } : {}),
        trust_level: "internal",
        // Ren data (strenger/tall/arrays/objekter) - trygg strukturell cast, aldri fabrikert innhold.
        payload: payload as Record<string, JsonValue>
      });
    } catch {
      // Persistens er auditerbarhet, ikke funksjon - aldri en blokkerende avhengighet.
    }
  }

  private async persistArtifact(input: CollaborationInput, collaborationId: string, result: CollaborationResult): Promise<void> {
    if (!this.pool || !input.task_id) return;
    try {
      await withTenantTransaction(this.pool, input.tenant_id, (client) =>
        client.query(
          `INSERT INTO artifacts (artifact_id, task_id, tenant_id, kind, name, content) VALUES ($1, $2, $3, 'collaboration_result', $4, $5)`,
          [collaborationId, input.task_id, input.tenant_id, `Samarbeid: ${collaborationId}`, JSON.stringify(result)]
        )
      );
    } catch {
      // Samme som over.
    }
  }
}
