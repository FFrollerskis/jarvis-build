import type { DataSensitivity } from "@jarvis/contracts";
import type { CompleteInput } from "@jarvis/model-gateway";

/** Rå bilde-bytes - standard base64 (ALDRI en `data:`-URI-prefiks), samme kontrakt som `ContentPart` i `@jarvis/provider-adapters`. */
export interface ImageInput {
  media_type: string;
  data: string;
}

/**
 * UA-2 P1B-A (D-43 §1): pluggbart OCR-grensesnitt - ÉN implementasjon i denne
 * runden (`ModelGatewayVisionExtractor`). En dedikert lokal motor (Tesseract
 * e.l.) er EKSPLISITT UTSATT (se D-43), ikke bygget her.
 */
export interface OcrProvider {
  /** Transkriberer SYNLIG tekst i bildet ordrett. Returnerer "" hvis ingen tekst funnet - IKKE en feil, et gyldig utfall. */
  transcribeText(image: ImageInput): Promise<string>;
}

/** Generell semantisk bildebeskrivelse - KUN brukt når `transcribeText()` ikke fant meningsfull tekst (f.eks. et diagram/foto uten tekst). */
export interface VisionDescriptionProvider {
  describeImage(image: ImageInput): Promise<string>;
}

/**
 * Minimal grensesnitt en ekte `@jarvis/model-gateway` sin `ModelGateway`
 * strukturelt oppfyller (`complete()` returnerer et objekt med MINST `text`)
 * - holder denne modulen testbar uten å konstruere en full `ModelGateway`
 * (ekte Postgres-pool/trace-sink) i enhetstester.
 */
export interface VisionCompleter {
  complete(input: CompleteInput): Promise<{ text: string }>;
}

const OCR_PROMPT =
  "Transkriber ALL synlig tekst i dette bildet ORDRETT, i lesbar rekkefølge. " +
  "Svar KUN med den transkriberte teksten - ingen kommentarer, ingen 'jeg ser'-innledning. " +
  "Hvis bildet ikke inneholder noen lesbar tekst, svar med nøyaktig: (ingen tekst funnet)";

const DESCRIBE_PROMPT =
  "Beskriv innholdet i dette bildet kort og presist for søk/gjenfinning - hva viser det " +
  "(diagram, foto, skjermbilde, tabell, e.l.), og de viktigste detaljene. Svar KUN med beskrivelsen.";

const NO_TEXT_FOUND_MARKER = "(ingen tekst funnet)";

/**
 * UA-2 P1B-A (D-43 §1/§3): eneste `OcrProvider`/`VisionDescriptionProvider`-
 * implementasjon denne runden. Ruter ALLTID gjennom `ModelGateway`
 * (`purpose: "VISION"`) - ALDRI en direkte leverandør-SDK (adaptergrense-
 * regelen i CLAUDE.md). Budsjett-/kostkontroll er derfor automatisk (samme
 * `BudgetGuard`/`cost_events` som ethvert annet modellkall) - se D-43 §6.
 */
export class ModelGatewayVisionExtractor implements OcrProvider, VisionDescriptionProvider {
  /**
   * `sensitivity` (gjennomgang av PR #325, funn 4): bildene kommer fra eierens egne kilder (e-postvedlegg, dokumenter) og er ALDRI «offentlige». Uten merke behandlet ruteren kallet som lavt sensitivt (gratis/delt sky tillatt). Standard
   * er derfor `PRIVATE` (ingen `hosted_free_tier`); kilder i helse-rommet eller med `special`-gulv skal gi `SECRET_RESTRICTED` (kun lokal modell) - se `ocrSensitivityForSource`.
   */
  constructor(
    private readonly gateway: VisionCompleter,
    private readonly tenantId: string,
    private readonly taskId?: string,
    private readonly sensitivity: DataSensitivity = "PRIVATE"
  ) {}

  async transcribeText(image: ImageInput): Promise<string> {
    const text = await this.callVision(image, OCR_PROMPT);
    return text === NO_TEXT_FOUND_MARKER ? "" : text;
  }

  async describeImage(image: ImageInput): Promise<string> {
    return this.callVision(image, DESCRIBE_PROMPT);
  }

  private async callVision(image: ImageInput, prompt: string): Promise<string> {
    const result = await this.gateway.complete({
      tenant_id: this.tenantId,
      ...(this.taskId !== undefined ? { task_id: this.taskId } : {}),
      purpose: "VISION",
      sensitivity: this.sensitivity,
      request: {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image", media_type: image.media_type, data: image.data }
            ]
          }
        ],
        max_tokens: 4000
      }
    });
    return result.text.trim();
  }
}

/**
 * Sensitiviteten bildene fra en konfigurert kilde skal rutes med (gjennomgang av PR #325, funn 4): helse-rommet og et `special`-gulv (eller -tak) krever `SECRET_RESTRICTED` (kun lokal modell - aldri sky, uansett leverandør);
 * alt annet er minst `PRIVATE`. Kildens policy brukes ellers først ETTER OCR-en (på teksten), så bildet selv må rutes konservativt.
 */
export function ocrSensitivityForSource(source: { memory_space: string; policy: { default_sensitivity?: string | undefined; max_sensitivity?: string | undefined } }): DataSensitivity {
  if (source.memory_space === "health" || source.policy.default_sensitivity === "special" || source.policy.max_sensitivity === "special") return "SECRET_RESTRICTED";
  return "PRIVATE";
}
