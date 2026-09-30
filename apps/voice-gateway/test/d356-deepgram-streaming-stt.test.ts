import { describe, expect, it } from "vitest";
import { DeepgramStreamingStt } from "../src/stt.ts";

/**
 * D-356. `DeepgramStreamingStt` - NY strømmende `SttAdapter` (Deepgram sitt
 * ekte `wss://api.deepgram.com/v1/listen`-endepunkt, til forskjell fra
 * `DeepgramStt` sin batch-`POST`). `processor.processor_terms_status` er
 * BEVISST `"NOT_VERIFIED"` (SAMME D-320-mønster som batch-varianten) - denne
 * suiten beviser koden fungerer strukturelt korrekt (meldingsprotokoll,
 * kø-håndtering før tilkobling åpner, feilhåndtering), IKKE at behandleren
 * er kvalifisert for produksjonsbruk (den porten er `evaluateSpeechRouting()`,
 * testet separat i `ua7-speech-routing.test.ts`). Ingen ekte WebSocket/
 * nettverk her - en injisert fake-socket via konstruktørens
 * `socketFactory`-parameter, SAMME injiserbarhets-prinsipp som
 * `fetch`-stubbing i `d320-deepgram-stt.test.ts`.
 */

class FakeSocket {
  readonly binarySent: Buffer[] = [];
  readonly textSent: string[] = [];
  closed = false;
  private openCb?: () => void;
  private messageCb?: (data: string) => void;
  private errorCb?: (err: unknown) => void;
  private closeCb?: () => void;

  sendBinary(data: Buffer): void {
    this.binarySent.push(data);
  }
  sendText(data: string): void {
    this.textSent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  onOpen(cb: () => void): void {
    this.openCb = cb;
  }
  onMessage(cb: (data: string) => void): void {
    this.messageCb = cb;
  }
  onError(cb: (err: unknown) => void): void {
    this.errorCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  triggerOpen(): void {
    this.openCb?.();
  }
  triggerMessage(obj: unknown): void {
    this.messageCb?.(JSON.stringify(obj));
  }
  triggerRawMessage(raw: string): void {
    this.messageCb?.(raw);
  }
  triggerError(err: unknown): void {
    this.errorCb?.(err);
  }
  triggerClose(): void {
    this.closeCb?.();
  }
}

function harness(): { stt: DeepgramStreamingStt; socketOf: () => FakeSocket; urlOf: () => string; headersOf: () => Record<string, string> } {
  let socket: FakeSocket | undefined;
  let url: string | undefined;
  let headers: Record<string, string> | undefined;
  const factory = (u: string, h: Record<string, string>): FakeSocket => {
    url = u;
    headers = h;
    socket = new FakeSocket();
    return socket;
  };
  const stt = new DeepgramStreamingStt("test-key", "no", 16000, factory);
  return {
    stt,
    socketOf: () => socket as FakeSocket,
    urlOf: () => url as string,
    headersOf: () => headers as Record<string, string>
  };
}

describe("A: available() krever KUN API-nøkkelen", () => {
  it("false uten nøkkel", () => {
    expect(new DeepgramStreamingStt(undefined).available()).toBe(false);
  });
  it("true med nøkkel", () => {
    expect(new DeepgramStreamingStt("key").available()).toBe(true);
  });
  it("startStream() kaster synkront uten konfigurasjon, ingen tilkobling åpnes", () => {
    const stt = new DeepgramStreamingStt(undefined);
    expect(() => stt.startStream()).toThrow("deepgram_streaming_stt_not_configured");
  });
});

describe("B: tilkobling - korrekt URL/headers, binær lyd, kø flushes ved open", () => {
  it("wss://api.deepgram.com/v1/listen med språk/encoding/sample_rate/interim_results og Token-header", () => {
    const { stt, urlOf, headersOf } = harness();
    stt.startStream();
    expect(urlOf()).toBe(
      "wss://api.deepgram.com/v1/listen?language=no&encoding=linear16&sample_rate=16000&interim_results=true&punctuate=true"
    );
    expect(headersOf()).toEqual({ authorization: "Token test-key" });
  });

  it("pushAudio() FØR open køes - ingen sending skjer før tilkoblingen faktisk er åpen", () => {
    const { stt, socketOf } = harness();
    const stream = stt.startStream();
    stream.pushAudio(Buffer.from([1, 2, 3, 4]));
    expect(socketOf().binarySent).toHaveLength(0);
  });

  it("ved open: køede rammer sendes BINÆRT i rekkefølge, ingen JSON-innpakking av selve lyden", () => {
    const { stt, socketOf } = harness();
    const stream = stt.startStream();
    stream.pushAudio(Buffer.from([1, 2, 3, 4]));
    socketOf().triggerOpen();
    expect(socketOf().binarySent).toEqual([Buffer.from([1, 2, 3, 4])]);
  });

  it("pushAudio() ETTER open sendes umiddelbart, ingen kø", () => {
    const { stt, socketOf } = harness();
    const stream = stt.startStream();
    socketOf().triggerOpen();
    stream.pushAudio(Buffer.from([9, 9]));
    expect(socketOf().binarySent).toEqual([Buffer.from([9, 9])]);
  });
});

describe("C: streaming-partials og endelig transkript", () => {
  it("is_final=false Results-events videreformidles som partial, endrer IKKE det akkumulerte endelige transkriptet", () => {
    const { stt, socketOf } = harness();
    const stream = stt.startStream();
    socketOf().triggerOpen();
    const partials: string[] = [];
    stream.onPartial((t) => partials.push(t));
    socketOf().triggerMessage({ type: "Results", is_final: false, channel: { alternatives: [{ transcript: "hei d" }] } });
    expect(partials).toEqual(["hei d"]);
  });

  it("is_final=true Results-events akkumuleres i det endelige transkriptet OG videreformidles som partial", () => {
    const { stt, socketOf } = harness();
    const stream = stt.startStream();
    socketOf().triggerOpen();
    const partials: string[] = [];
    stream.onPartial((t) => partials.push(t));
    socketOf().triggerMessage({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: "hei" }] } });
    socketOf().triggerMessage({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: "der" }] } });
    expect(partials).toEqual(["hei", "hei der"]);
  });

  it("tomt transkript i en Results-melding ignoreres (ingen krasj, ingen tom partial)", () => {
    const { stt, socketOf } = harness();
    const stream = stt.startStream();
    socketOf().triggerOpen();
    let called = false;
    stream.onPartial(() => (called = true));
    socketOf().triggerMessage({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: "" }] } });
    expect(called).toBe(false);
  });

  it("end() sender {type:CloseStream} som TEKST (ikke binært) og resolver med akkumulert finaltekst ved Metadata, kobler fra", async () => {
    const { stt, socketOf } = harness();
    const stream = stt.startStream();
    socketOf().triggerOpen();
    socketOf().triggerMessage({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: "hei der" }] } });
    const endPromise = stream.end();
    expect(socketOf().textSent).toEqual([JSON.stringify({ type: "CloseStream" })]);
    socketOf().triggerMessage({ type: "Metadata", request_id: "abc" });
    await expect(endPromise).resolves.toBe("hei der");
    expect(socketOf().closed).toBe(true);
  });

  it("end() FØR open køes - CloseStream sendes FØRST etter at tilkoblingen åpner", async () => {
    const { stt, socketOf } = harness();
    const stream = stt.startStream();
    const endPromise = stream.end();
    expect(socketOf().textSent).toHaveLength(0);
    socketOf().triggerOpen();
    expect(socketOf().textSent).toEqual([JSON.stringify({ type: "CloseStream" })]);
    socketOf().triggerMessage({ type: "Metadata" });
    await expect(endPromise).resolves.toBe("");
  });

  it("en Metadata-melding FØR end() ble kalt (closeRequested=false) settler IKKE stille en ikke-eksisterende promise", () => {
    const { stt, socketOf } = harness();
    stt.startStream();
    socketOf().triggerOpen();
    expect(() => socketOf().triggerMessage({ type: "Metadata" })).not.toThrow();
    expect(socketOf().closed).toBe(true);
  });
});

describe("D: feilhåndtering - ÆRLIG feil, aldri en hengende/stille promise", () => {
  it("socket-nivå onError avviser end()", async () => {
    const { stt, socketOf } = harness();
    const stream = stt.startStream();
    socketOf().triggerOpen();
    const endPromise = stream.end();
    socketOf().triggerError(new Error("econnreset"));
    await expect(endPromise).rejects.toThrow("econnreset");
  });

  it("tilkoblingen lukkes FØR end() ble kalt (aldri en forespurt lukking) - en PÅFØLGENDE end() avvises i stedet for å henge for alltid", async () => {
    const { stt, socketOf } = harness();
    const stream = stt.startStream();
    socketOf().triggerOpen();
    socketOf().triggerClose();
    await expect(stream.end()).rejects.toThrow("deepgram_streaming_stt_closed_before_result");
  });

  it("close ETTER et allerede fullført resultat avviser IKKE på nytt (ingen dobbel-oppgjøring/krasj)", async () => {
    const { stt, socketOf } = harness();
    const stream = stt.startStream();
    socketOf().triggerOpen();
    const endPromise = stream.end();
    socketOf().triggerMessage({ type: "Metadata" });
    await expect(endPromise).resolves.toBe("");
    expect(() => socketOf().triggerClose()).not.toThrow();
  });

  it("ugyldig JSON i en melding ignoreres stille (parse-feil skal ALDRI krasje gatewayen)", () => {
    const { stt, socketOf } = harness();
    const stream = stt.startStream();
    socketOf().triggerOpen();
    let partialCalled = false;
    stream.onPartial(() => (partialCalled = true));
    expect(() => socketOf().triggerRawMessage("ikke gyldig json {{{")).not.toThrow();
    expect(partialCalled).toBe(false);
  });
});

describe("E: processor - EKSTERN, NOT_VERIFIED, distinkt fra batch-Deepgram (D-356/D-122 regel 3 - per tjeneste, ALDRI VERIFIED uten en ekte Tobias-gjennomgang)", () => {
  it("locality=external, processor_row_declared=true, processor_terms_status=NOT_VERIFIED, egen processor_id ulik DeepgramStt", () => {
    const stt = new DeepgramStreamingStt("key");
    expect(stt.processor).toEqual({
      processor_id: "deepgram-listen-streaming",
      locality: "external",
      processor_row_declared: true,
      processor_terms_status: "NOT_VERIFIED"
    });
  });
});
