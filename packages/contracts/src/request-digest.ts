import { createHash } from "node:crypto";
import type { JsonValue } from "./capability.ts";
import { canonicalStringify } from "./canonical.ts";

/**
 * WP-T1 K1 (JARVIS-102, Q-65 pkt 1, D-497): `request_digest` - DEN ENE kanoniske digesten for en verktøyforespørsel, delt av ToolGateway-ledgeren (`tool_executions.request_digest`,
 * `idempotency_key_reuse_mismatch`) og av en fremtidig Approval v2 (WP-MC7 binder SAMME digest, ikke en ny binding).
 *
 * ÉN KANONISERING: serialiseringen er `canonicalStringify` (canonical.ts) - den samme som godkjenningenes `parameters_hash` (`hashApprovalParameters`), bekreftelseskortets fingeravtrykk og
 * forretningsloggens `request_hash`. Denne filen legger kun til (1) STRENG VALIDERING før serialisering (ingenting som ikke er ren JSON får en digest) og (2) definisjonen av hva digesten dekker.
 * `canonicalStringify` er UENDRET (en endring ville brutt signerte godkjenninger og lagrede hasher). På det strenge domenet er `canonicalizeStrict(v) === canonicalStringify(v)` (låst av test).
 *
 * SPESIFIKASJON (versjon 1; publisert i docs/runbooks/WPT1_REQUEST_DIGEST.md sammen med testvektorene):
 *   body    = { v: 1, tool_id, action, parameters, tenant_id, person_id }
 *   digest  = hex(SHA-256(UTF-8(canonical(body))))
 *   canonical(x): objekter får nøklene sortert på UTF-16-kodeenheter (ikke locale, ikke kodepunkt), ingen mellomrom; lister beholder rekkefølgen; tekst og tall serialiseres som `JSON.stringify`
 *   (tall = ECMAScript Number-til-tekst, -0 blir 0; tekst får kun nødvendig JSON-escaping, øvrige tegn står som UTF-8). `parameters` er forespørselens parametre UTEN `idempotency_key` (og
 *   eventuelle per-definisjon-utelatte felt, kun toppnivå): nøkkelen er forespørselens IDENTITET (retry-korrelasjon), aldri nyttelast.
 *
 * UNICODE: INGEN normalisering. NFC- og NFD-formen av samme tekst er ULIKE forespørsler (ulik digest). Bevisst (A-1): (a) en digest som folder normaliseringsformer avhenger av hver plattforms
 * Unicode-tabeller (en signerende enhet på en annen versjon kan gi en annen digest for tegn tildelt senere), (b) det som UTFØRES er bytene gatewayen sender - å binde en folded form ville latt to
 * forskjellige leverandørstrenger (filnavn, adresser) gjelde som «samme godkjenning». En avsender som vil være normaliseringsuavhengig normaliserer selve forespørselen før den sendes.
 * Samme valg som RFC 8785 (JCS). Konsekvens: en gjentakelse med de SAMME bytene gir alltid samme digest; en omkodet gjentakelse (annen normaliseringsform) avvises som ulik nyttelast (fail-closed).
 *
 * AVVISNING (fail-closed, `RequestDigestError`): NaN/±Infinity, sykliske strukturer, dybde over `REQUEST_DIGEST_MAX_DEPTH`, bigint/symbol/funksjon, ikke-rene objekter (Date, Map, Set, klasseinstanser),
 * accessor-egenskaper (en getter kunne gitt ulike svar ved digest og ved utførelse), symbolnøkler, `undefined`/hull i lister og ensomme surrogater (kan ikke representeres i UTF-8 og dermed ikke
 * hos en annen implementasjon). En `undefined`-EGENSKAP utelates (som `JSON.stringify` gjør). Feilen bærer en kode og en sti, aldri verdien.
 */

/** Versjonsmerket i digest-kroppen: en senere endring av kanoniseringen eller feltene er en NY versjon (aldri en stille endring av digestene som allerede ligger i ledgeren). */
export const REQUEST_DIGEST_VERSION = 1 as const;
/** Maks nøstingsdybde (objekt/liste) i parametrene. Over dette feiler digesten (`too_deep`) i stedet for å kjøre rekursjonen mot en stakkgrense. */
export const REQUEST_DIGEST_MAX_DEPTH = 64;
/** Toppnivåfelt i `parameters` som er forespørselens identitet (retry-korrelasjon) og derfor aldri inngår i digesten. Finans- og forretningsverktøyene bærer nøkkelen både her og i `idempotency_key`. */
export const REQUEST_DIGEST_EXCLUDED_PARAMETERS: readonly string[] = ["idempotency_key"];

export type RequestDigestErrorCode =
  | "invalid_input"
  | "not_plain_object"
  | "non_finite_number"
  | "unsupported_type"
  | "cycle"
  | "too_deep"
  | "undefined_in_array"
  | "lone_surrogate";

/** Digesten kunne ikke beregnes fordi forespørselen ikke er ren, entydig JSON. `path` peker på det ugyldige feltet (`$.parameters.a[0].b`); verdien er aldri med. */
export class RequestDigestError extends Error {
  constructor(readonly code: RequestDigestErrorCode, readonly path: string) {
    super(`request_digest_invalid:${code} (${path})`);
    this.name = "RequestDigestError";
  }
}

/** Et ENSOMT surrogat (`u`-flagget leser et gyldig par som ett kodepunkt, så kun ugyldig UTF-16 treffer). */
const LONE_SURROGATE = /\p{Cs}/u;

function fail(code: RequestDigestErrorCode, path: string): never {
  throw new RequestDigestError(code, path);
}

function wellFormed(text: string, path: string): string {
  if (LONE_SURROGATE.test(text)) fail("lone_surrogate", path);
  return text;
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function walk(value: unknown, path: string, depth: number, ancestors: Set<object>): JsonValue {
  if (value === null) return null;
  switch (typeof value) {
    case "string": return wellFormed(value, path);
    case "boolean": return value;
    case "number": return Number.isFinite(value) ? value : fail("non_finite_number", path);
    case "object": break;
    default: return fail("unsupported_type", path); // bigint, symbol, funksjon (og `undefined`, som kalleren håndterer)
  }
  if (depth > REQUEST_DIGEST_MAX_DEPTH) return fail("too_deep", path);
  const node = value as object;
  if (ancestors.has(node)) return fail("cycle", path);
  ancestors.add(node);
  try {
    if (Array.isArray(node)) {
      const out: JsonValue[] = [];
      for (let i = 0; i < node.length; i += 1) {
        const at = `${path}[${i}]`;
        if (!(i in node)) return fail("undefined_in_array", at);
        const element: unknown = (node as unknown[])[i];
        if (element === undefined) return fail("undefined_in_array", at);
        out.push(walk(element, at, depth + 1, ancestors));
      }
      return out;
    }
    if (!isPlainObject(node)) return fail("unsupported_type", path);
    if (Object.getOwnPropertySymbols(node).length > 0) return fail("unsupported_type", path);
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(node)) {
      const at = `${path}.${key}`;
      wellFormed(key, at);
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (descriptor === undefined || !("value" in descriptor)) return fail("unsupported_type", at); // accessor: aldri les en getter
      const member: unknown = descriptor.value;
      if (member === undefined) continue; // som JSON.stringify: en undefined-egenskap finnes ikke
      // defineProperty (ikke tilordning): en nøkkel som heter `__proto__` skal bli en egen egenskap, aldri sette prototypen.
      Object.defineProperty(out, key, { value: walk(member, at, depth + 1, ancestors), enumerable: true, writable: true, configurable: true });
    }
    return out;
  } finally {
    ancestors.delete(node);
  }
}

/** Validerer at `value` er ren JSON (se filhodet) og gir en DYP KOPI (uten `undefined`-egenskaper). Kaster `RequestDigestError`. */
export function toStrictJson(value: unknown, path = "$"): JsonValue {
  if (value === undefined) return fail("unsupported_type", path);
  return walk(value, path, 0, new Set<object>());
}

/** Streng kanonisk serialisering: validering (`toStrictJson`) og så DEN ENE serialisereren, `canonicalStringify`. */
export function canonicalizeStrict(value: unknown): string {
  return canonicalStringify(toStrictJson(value));
}

export interface RequestDigestInput {
  tool_id: string;
  action: string;
  /** Forespørselens parametre slik transporten får dem. */
  parameters: Record<string, unknown>;
  tenant_id: string;
  /** Den forespørrende personen (aktøren) - samme felt som godkjenningens `person_id`. */
  person_id: string;
  /** Per-definisjon-utelatte toppnivåfelt (f.eks. en hemmelighet som ikke skal avtrykkes), i tillegg til `REQUEST_DIGEST_EXCLUDED_PARAMETERS`. */
  exclude_parameters?: readonly string[];
}

function identityField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) return fail("invalid_input", `$.${field}`);
  return wellFormed(value, `$.${field}`);
}

/** Parametrene som inngår i digesten: validert kopi uten de utelatte toppnivåfeltene. */
function digestParameters(parameters: unknown, exclude: readonly string[] | undefined): Record<string, JsonValue> {
  if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters) || !isPlainObject(parameters)) return fail("not_plain_object", "$.parameters");
  const strict = walk(parameters, "$.parameters", 0, new Set<object>()) as Record<string, JsonValue>;
  const dropped = new Set<string>([...REQUEST_DIGEST_EXCLUDED_PARAMETERS, ...(exclude ?? [])]);
  const out: Record<string, JsonValue> = {};
  for (const key of Object.keys(strict)) {
    if (dropped.has(key)) continue;
    Object.defineProperty(out, key, { value: strict[key], enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** Kroppen som digesten tas over (feltene i spesifikasjonen). */
export function requestDigestBody(input: RequestDigestInput): JsonValue {
  return {
    v: REQUEST_DIGEST_VERSION,
    tool_id: identityField(input.tool_id, "tool_id"),
    action: identityField(input.action, "action"),
    parameters: digestParameters(input.parameters, input.exclude_parameters),
    tenant_id: identityField(input.tenant_id, "tenant_id"),
    person_id: identityField(input.person_id, "person_id")
  };
}

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Den kanoniske strengen digesten tas over (nyttig for testvektorer og feilsøking). */
export function canonicalRequest(input: RequestDigestInput): string {
  return canonicalStringify(requestDigestBody(input));
}

/** `request_digest`: 64 hex-tegn. Kaster `RequestDigestError` hvis forespørselen ikke er ren JSON. */
export function requestDigest(input: RequestDigestInput): string {
  return sha256Hex(canonicalRequest(input));
}

/**
 * Digesten av KUN parametrene (uten idempotensnøkkel/utelatte felt). For parametre uten slike felt er den lik godkjenningenes `parameters_hash` (`hashApprovalParameters`) - samme serialisering,
 * samme hash (låst av test) - slik at en godkjenning og ledgeren aldri beskriver samme parametre på to ulike måter.
 */
export function parametersDigest(parameters: Record<string, unknown>, exclude?: readonly string[]): string {
  return sha256Hex(canonicalStringify(digestParameters(parameters, exclude)));
}

export interface RequestDigestVector {
  name: string;
  /** Hva vektoren viser. */
  note: string;
  input: RequestDigestInput;
  /** Den kanoniske strengen (håndskrevet, ikke utledet av implementasjonen). */
  canonical: string;
  /** SHA-256 (hex) av `canonical` som UTF-8. */
  digest: string;
}

// Tegn som ikke skrives som literaler (et redigeringsverktøy kan normalisere eller dekode dem): bygget av kodepunkter.
const cp = (...points: number[]): string => String.fromCodePoint(...points);
const OE = cp(0xf8); // ø
const E_ACUTE = cp(0xe9); // é (forhåndssammensatt, NFC)
const E_ACUTE_DECOMPOSED = cp(0x65, 0x301); // e + kombinerende akutt (NFD)
const EMOJI = cp(0x1f600);
const FULLWIDTH_TILDE = cp(0xff5e);
const LINE_SEP = cp(0x2028);
const BACKSLASH = cp(0x5c);
const CTL_ESCAPED = `${BACKSLASH}u0001`; // `\u0001` slik JSON.stringify skriver U+0001

/**
 * Publiserte testvektorer (versjon 1). `canonical` er HÅNDSKREVET og `digest` er SHA-256 av den over node:crypto - ingen av dem er utledet av `requestDigest` (testen sammenligner alle tre veier, og
 * vektorene er kryssjekket mot en uavhengig implementasjon i Python for de uten tall-/sorteringsspesialiteter). En annen implementasjon (f.eks. enheten som signerer en Approval v2) skal gi NØYAKTIG disse.
 */
export const REQUEST_DIGEST_TEST_VECTORS: readonly RequestDigestVector[] = [
  {
    name: "simple", note: "Sorterte nøkler, ingen mellomrom; UTF-8-tekst står som den er.",
    input: { tool_id: "calendar", action: "create_event", parameters: { "title": `M${OE}te`, "start": "2026-11-26T10:00:00Z" }, tenant_id: "tenant-a", person_id: "person-1" },
    canonical: `{"action":"create_event","parameters":{"start":"2026-11-26T10:00:00Z","title":"M${OE}te"},"person_id":"person-1","tenant_id":"tenant-a","tool_id":"calendar","v":1}`,
    digest: "c1e72ee8b353e2e2b3a2cb18b4378c3aa1cd3792c033ffc62431d716102d846e"
  },
  {
    name: "empty_parameters", note: "Ingen parametre: `parameters` er `{}`.",
    input: { tool_id: "calendar", action: "create_event", parameters: {}, tenant_id: "tenant-a", person_id: "person-1" },
    canonical: `{"action":"create_event","parameters":{},"person_id":"person-1","tenant_id":"tenant-a","tool_id":"calendar","v":1}`,
    digest: "ea760d0d9c6c716826c311c016205c3e5fd9d7420d3404eb66b4ae7233d50e02"
  },
  {
    name: "nested_scrambled_order", note: "Nøkler i vilkårlig rekkefølge, nøstede objekter og lister (listerekkefølgen bevares), null og boolske verdier.",
    input: { tool_id: "calendar", action: "create_event", parameters: { "zeta": { "b": [3, 2, 1], "a": { "y": false, "x": null } }, "alpha": "first", "mid": [{ "q": 1, "p": 2 }, []] }, tenant_id: "tenant-a", person_id: "person-1" },
    canonical: `{"action":"create_event","parameters":{"alpha":"first","mid":[{"p":2,"q":1},[]],"zeta":{"a":{"x":null,"y":false},"b":[3,2,1]}},"person_id":"person-1","tenant_id":"tenant-a","tool_id":"calendar","v":1}`,
    digest: "dc93af9fb21dd44fb3dc6558f8ade915b1baf062f5901998ba2c8df6d0202833"
  },
  {
    name: "idempotency_key_excluded", note: "`idempotency_key` på toppnivå inngår ikke i digesten.",
    input: { tool_id: "calendar", action: "create_event", parameters: { "idempotency_key": "k-2026-0001", "title": `M${OE}te` }, tenant_id: "tenant-a", person_id: "person-1" },
    canonical: `{"action":"create_event","parameters":{"title":"M${OE}te"},"person_id":"person-1","tenant_id":"tenant-a","tool_id":"calendar","v":1}`,
    digest: "983ab0f63f843ed28907fefd9374c04f07dd4ae43901876dae2db371951f5f85"
  },
  {
    name: "null_bool_empty", note: "Tom tekst, tom liste, false og null er alle forskjellige fra fravær.",
    input: { tool_id: "calendar", action: "create_event", parameters: { "flag": false, "none": null, "empty": "", "list": [] }, tenant_id: "tenant-a", person_id: "person-1" },
    canonical: `{"action":"create_event","parameters":{"empty":"","flag":false,"list":[],"none":null},"person_id":"person-1","tenant_id":"tenant-a","tool_id":"calendar","v":1}`,
    digest: "e2d475e17c0cbb0da7ee9abddc9cd92b9a71ee12ac1b5594d21e63bdf7ab654b"
  },
  {
    name: "other_tool_action", note: "Annet verktøy og annen handling gir annen digest.",
    input: { tool_id: "email", action: "send", parameters: { "to": "recipient-1", "subject": "Hei", "body": "Tekst" }, tenant_id: "tenant-a", person_id: "person-1" },
    canonical: `{"action":"send","parameters":{"body":"Tekst","subject":"Hei","to":"recipient-1"},"person_id":"person-1","tenant_id":"tenant-a","tool_id":"email","v":1}`,
    digest: "9b6525cf8ffb771d78b73b890fd7d9f512d67682d3cf8bc854e57e6c07998220"
  },
  {
    name: "other_tenant", note: "Samme parametre som `simple`, annen tenant.",
    input: { tool_id: "calendar", action: "create_event", parameters: { "title": `M${OE}te`, "start": "2026-11-26T10:00:00Z" }, tenant_id: "tenant-b", person_id: "person-1" },
    canonical: `{"action":"create_event","parameters":{"start":"2026-11-26T10:00:00Z","title":"M${OE}te"},"person_id":"person-1","tenant_id":"tenant-b","tool_id":"calendar","v":1}`,
    digest: "907d5e6f6e9e6da0059c88ddbe9b563f403e27230acfdb0b337b6c590261f7f4"
  },
  {
    name: "other_person", note: "Samme parametre som `simple`, annen person (aktør).",
    input: { tool_id: "calendar", action: "create_event", parameters: { "title": `M${OE}te`, "start": "2026-11-26T10:00:00Z" }, tenant_id: "tenant-a", person_id: "person-2" },
    canonical: `{"action":"create_event","parameters":{"start":"2026-11-26T10:00:00Z","title":"M${OE}te"},"person_id":"person-2","tenant_id":"tenant-a","tool_id":"calendar","v":1}`,
    digest: "de84cde5e0f3c9c036d6e2975cc0c119b3a4f27f7e84e7fa69606f80fc46a95c"
  },
  {
    name: "unicode_nfc", note: "`é` som ETT kodepunkt (U+00E9, NFC).",
    input: { tool_id: "calendar", action: "create_event", parameters: { "name": `caf${E_ACUTE}` }, tenant_id: "tenant-a", person_id: "person-1" },
    canonical: `{"action":"create_event","parameters":{"name":"caf${E_ACUTE}"},"person_id":"person-1","tenant_id":"tenant-a","tool_id":"calendar","v":1}`,
    digest: "2348686296cc3f7816d4d5754ab5dbb7b10d4945a6cfcc434ffa770f8be3cb3e"
  },
  {
    name: "unicode_nfd", note: "`e` + U+0301 (NFD): samme tekst som `unicode_nfc`, men ULIK digest (ingen normalisering).",
    input: { tool_id: "calendar", action: "create_event", parameters: { "name": `caf${E_ACUTE_DECOMPOSED}` }, tenant_id: "tenant-a", person_id: "person-1" },
    canonical: `{"action":"create_event","parameters":{"name":"caf${E_ACUTE_DECOMPOSED}"},"person_id":"person-1","tenant_id":"tenant-a","tool_id":"calendar","v":1}`,
    digest: "5977119e13cc0176b4fdfc738c92928c9cf859b79706ab9a199b508e5765f610"
  },
  {
    name: "unicode_escaping", note: "Emoji (astralt kodepunkt), anførsel, backslash, tab, linjeskift, U+0001 (skrives som `\\u0001`) og U+2028 (skrives som det er).",
    input: { tool_id: "calendar", action: "create_event", parameters: { "text": `smile ${EMOJI} "q" back\\slash\ttab\nnl ${String.fromCodePoint(1)}ctl${LINE_SEP}sep` }, tenant_id: "tenant-a", person_id: "person-1" },
    canonical: `{"action":"create_event","parameters":{"text":"smile ${EMOJI} \\"q\\" back\\\\slash\\ttab\\nnl ${CTL_ESCAPED}ctl${LINE_SEP}sep"},"person_id":"person-1","tenant_id":"tenant-a","tool_id":"calendar","v":1}`,
    digest: "318134c4dd83c0e777557a8b1b9d66e332d5e2e7ea0fbd668bf371ffbd8aea63"
  },
  {
    name: "key_sort_utf16", note: "Nøkler sorteres på UTF-16-kodeenheter: U+1F600 (kodeenhet 0xD83D) kommer FØR U+FF5E, selv om kodepunktet er større (Python/Unicode-rekkefølge gir motsatt).",
    input: { tool_id: "calendar", action: "create_event", parameters: { [`${FULLWIDTH_TILDE}`]: 6, [`${EMOJI}`]: 5, [`${E_ACUTE}`]: 4, "a": 3, "_": 2, "B": 1 }, tenant_id: "tenant-a", person_id: "person-1" },
    canonical: `{"action":"create_event","parameters":{"B":1,"_":2,"a":3,"${E_ACUTE}":4,"${EMOJI}":5,"${FULLWIDTH_TILDE}":6},"person_id":"person-1","tenant_id":"tenant-a","tool_id":"calendar","v":1}`,
    digest: "3903e66b3ea3117250014af1c3a09d9ba21d6d8b61b3d500af4da1681e8e0ad7"
  },
  {
    name: "numbers_ecmascript", note: "Tall skrives som ECMAScript Number-til-tekst: 1e+21, 1e-7, 5e-324, -0 blir 0, heltall uten desimal.",
    input: { tool_id: "calendar", action: "create_event", parameters: { "big": 123456789012345680000, "frac": 1.5, "huge": 1e+21, "int": 42, "max": 1.7976931348623157e+308, "min": 5e-324, "neg": -5, "negzero": -0.0, "small": 1e-06, "tiny": 1e-07, "zero": 0 }, tenant_id: "tenant-a", person_id: "person-1" },
    canonical: `{"action":"create_event","parameters":{"big":123456789012345680000,"frac":1.5,"huge":1e+21,"int":42,"max":1.7976931348623157e+308,"min":5e-324,"neg":-5,"negzero":0,"small":0.000001,"tiny":1e-7,"zero":0},"person_id":"person-1","tenant_id":"tenant-a","tool_id":"calendar","v":1}`,
    digest: "14abc31ec2284ecd5dab6ef6cb793b9e319fe26ca18590eeb791e8e0e4d8c8d4"
  },
  {
    name: "definition_excluded_field", note: "Et per-definisjon-utelatt felt (`value`) inngår ikke (og heller ikke `idempotency_key`).",
    input: { tool_id: "owner_controls", action: "set_connector_credential", parameters: { "connector_id": "example", "credential_ref": "EXAMPLE_REF", "value": "fake-value-for-test", "idempotency_key": "k-2026-0002" }, tenant_id: "tenant-a", person_id: "person-1", exclude_parameters: ["value"] },
    canonical: `{"action":"set_connector_credential","parameters":{"connector_id":"example","credential_ref":"EXAMPLE_REF"},"person_id":"person-1","tenant_id":"tenant-a","tool_id":"owner_controls","v":1}`,
    digest: "4ae33023ab08c879a4c664582d2b4ab26c7e15461f857c0aaede26f5e7c70291"
  }
];
