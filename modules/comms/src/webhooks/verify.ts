import { createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify } from "node:crypto";

/**
 * WP-G1 (D-463, P1d): REN, deterministisk signaturverifisering for de fire innkommende webhook-leverandørene. Ingen I/O, ingen skjult klokke (`nowSeconds` injiseres), konstant-tid-sammenligning (`timingSafeEqual`),
 * og ALLTID mot de RÅ bytene (aldri en JSON-rundtur). En signatur ER autentiseringen: ruten har ingen annen autentisering, og et avslag gir en nøytral 401 uten orakel om hvorfor.
 *
 * Kontraktene (verifisert mot leverandørenes dokumentasjon via søk 2026-11; detaljer og hva som er UVERIFISERT står i runbook §D-41):
 *  - Slack: `X-Slack-Signature: v0=<hex>`, HMAC-SHA256 over `v0:<X-Slack-Request-Timestamp>:<rå kropp>` med signeringshemmeligheten. 5 minutters toleranse er den utbredte praksisen (Slacks egen tekst om grensen ble ikke sett i søket - UVERIFISERT, men konservativ).
 *  - Meta (WhatsApp Cloud API, Messenger, Instagram): `X-Hub-Signature-256: sha256=<hex>`, HMAC-SHA256 over den rå kroppen med APP-hemmeligheten. Ingen tidsstempel i signaturen: gjenspilling stoppes av hendelses-id-dedupe + ferskhetsgrense i inntaket.
 *  - Twilio: `X-Twilio-Signature` = base64(HMAC-SHA1(authToken, <full URL> + parametrene sortert på navn, hvert navn etterfulgt av verdien)). KUN skjema-kodede kropper (SMS-webhooks); JSON-kropper (`bodySHA256`) støttes ikke.
 *  - Telnyx: `telnyx-signature-ed25519` (base64) over `<telnyx-timestamp>|<rå kropp>` med kontoens offentlige Ed25519-nøkkel; 5 minutters toleranse (symmetrisk: framtidige tidsstempler avvises også).
 */
export type VerifyResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const OK: VerifyResult = { ok: true };
const fail = (reason: string): VerifyResult => ({ ok: false, reason });
export const DEFAULT_TOLERANCE_SECONDS = 300;

function equalBuffers(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseSeconds(value: string | undefined): number | null {
  if (value === undefined || !/^\d{9,12}$/.test(value)) return null;
  return Number(value);
}

export function verifySlackSignature(input: {
  rawBody: Buffer; timestamp: string | undefined; signature: string | undefined; signingSecret: string; nowSeconds: number; toleranceSeconds?: number;
}): VerifyResult {
  if (input.signature === undefined || input.timestamp === undefined) return fail("missing_header");
  const ts = parseSeconds(input.timestamp);
  const match = /^v0=([0-9a-f]{64})$/.exec(input.signature);
  if (ts === null || match === null) return fail("malformed_header");
  if (Math.abs(input.nowSeconds - ts) > (input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS)) return fail("timestamp_outside_tolerance");
  const expected = createHmac("sha256", input.signingSecret).update(`v0:${input.timestamp}:`, "utf8").update(input.rawBody).digest();
  return equalBuffers(expected, Buffer.from(match[1]!, "hex")) ? OK : fail("signature_mismatch");
}

export function verifyMetaSignature(input: { rawBody: Buffer; signature: string | undefined; appSecret: string }): VerifyResult {
  if (input.signature === undefined) return fail("missing_header");
  const match = /^sha256=([0-9a-f]{64})$/.exec(input.signature);
  if (match === null) return fail("malformed_header");
  const expected = createHmac("sha256", input.appSecret).update(input.rawBody).digest();
  return equalBuffers(expected, Buffer.from(match[1]!, "hex")) ? OK : fail("signature_mismatch");
}

/** Strengen Twilio signerer: full URL + (parametre sortert på navn; navn og verdi limt sammen). Flere verdier for samme navn legges inn sortert. */
export function twilioSignatureBase(url: string, params: ReadonlyMap<string, readonly string[]>): string {
  let base = url;
  for (const key of [...params.keys()].sort()) {
    for (const value of [...(params.get(key) ?? [])].sort()) base += key + value;
  }
  return base;
}

export function verifyTwilioSignature(input: { url: string; params: ReadonlyMap<string, readonly string[]>; signature: string | undefined; authToken: string }): VerifyResult {
  if (input.signature === undefined) return fail("missing_header");
  if (!/^[A-Za-z0-9+/]{27}=$/.test(input.signature)) return fail("malformed_header");
  const expected = createHmac("sha1", input.authToken).update(twilioSignatureBase(input.url, input.params), "utf8").digest();
  return equalBuffers(expected, Buffer.from(input.signature, "base64")) ? OK : fail("signature_mismatch");
}

/** ASN.1-prefikset for en rå 32-byte Ed25519-nøkkel i SPKI-form (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function verifyTelnyxSignature(input: {
  rawBody: Buffer; signature: string | undefined; timestamp: string | undefined; publicKeyBase64: string; nowSeconds: number; toleranceSeconds?: number;
}): VerifyResult {
  if (input.signature === undefined || input.timestamp === undefined) return fail("missing_header");
  const ts = parseSeconds(input.timestamp);
  if (ts === null || !/^[A-Za-z0-9+/]{86}==$/.test(input.signature)) return fail("malformed_header");
  if (Math.abs(input.nowSeconds - ts) > (input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS)) return fail("timestamp_outside_tolerance");
  const raw = Buffer.from(input.publicKeyBase64, "base64");
  if (raw.length !== 32) return fail("key_invalid");
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
    const message = Buffer.concat([Buffer.from(`${input.timestamp}|`, "utf8"), input.rawBody]);
    return cryptoVerify(null, message, key, Buffer.from(input.signature, "base64")) ? OK : fail("signature_mismatch");
  } catch {
    return fail("signature_mismatch");
  }
}

/** Konstant-tid-sammenligning av to korte hemmeligheter (Metas verifiseringstoken i GET-håndtrykket). */
export function secretsEqual(a: string, b: string): boolean {
  const left = createHmac("sha256", "jarvis-comms-compare").update(a, "utf8").digest();
  const right = createHmac("sha256", "jarvis-comms-compare").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}
