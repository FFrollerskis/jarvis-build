import { z } from "zod";
import { normalizeE164 } from "@jarvis/conversation-graph";
import { ProviderRejectedError, providerCall, safeVendorCode } from "./adapters.ts";
import { sanitizeInboundText } from "./webhooks/ingest.ts";

/**
 * WP-G1 (D-463, P2e): Google Contacts (People API v1) med FULL kapabilitet for eieren (D-41): lese, søke, opprette, oppdatere, slette - pluss å LENKE en kontakt til en identitet i Conversation Graph (`contacts_sync`).
 * `JARVIS_COMMS_CONTACTS=on`, DORMANT og NOT VERIFIED. Kontaktboken er eierens egen, men innholdet i den er UBETRODD data (en notatfelt kan inneholde instruksjoner): output renses og merkes `untrusted`, og felt minimeres til
 * navn/e-post/telefon/organisasjon (aldri adresser, fødselsdager, notater, bilder). Identitetslenking er deterministisk (eksakt e-post/E.164), `match_method: contact_sync`, confidence 0.9, aldri en automatisk sammenslåing.
 *
 * VERIFISERT via søk mot Googles People API-dokumentasjon (2026-11): `POST /v1/people:createContact`, `PATCH /v1/{resourceName}:updateContact` (krever `updatePersonFields` og kontaktens kilde-etag - ellers 400; en utdatert etag gir
 * `failedPrecondition`), `DELETE /v1/{resourceName}:deleteContact`, scope `https://www.googleapis.com/auth/contacts` (skriving; `contacts.readonly` for lesing), og at mutasjoner for samme bruker bør sendes sekvensielt. UVERIFISERT: `connections.list`/
 * `searchContacts`-parametrene (kjent fra tidligere dokumentasjon), sidestørrelser og «other contacts». Nytt scope krever eierens re-samtykke (egen refresh-token `JARVIS_GOOGLE_CONTACTS_TOKEN`) - BLOCKED_EXTERNAL live.
 * Oppdatering er lese-endre-skriv med etag-sammenligning (aldri en stille overskriving): avviker etag fra den ferske lesingen avbrytes uten skriving.
 */
export const CONTACTS_CREDENTIAL_REF = "JARVIS_GOOGLE_CONTACTS_TOKEN";
const PEOPLE = "https://people.googleapis.com/v1";
const READ_FIELDS = "names,emailAddresses,phoneNumbers,organizations,metadata";
const WRITE_FIELDS = ["names", "emailAddresses", "phoneNumbers", "organizations"] as const;

export const RESOURCE_NAME = /^people\/c\d{1,25}$/;
const EMAIL = /^[^\s@<>"'`\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
// Googles etag-er kan inneholde «%» (URL-kodet base64) og «.» - tegnsettet må tillate dem, ellers ville ekte etag-er blitt avvist av skjemaet.
const ETAG = /^[A-Za-z0-9+/=_%.-]{1,200}$/;

/** Fritekst-felt: uendret av renseren (ingen kontrolltegn, ingen hemmeligheter, ikke tom/trimmet) - ellers avvises feltet (aldri en stille «rensing» som endrer hva som skrives til eierens kontaktbok). */
const text = (max: number) => z.string().min(1).max(max).refine((v) => v === v.trim() && sanitizeInboundText(v) === v, "text_invalid");
const phoneField = z.string().min(5).max(40).transform((v, ctx) => {
  const e164 = normalizeE164(v, { allowBareInternationalDigits: false });
  if (e164 === null) { ctx.addIssue({ code: "custom", message: "phone_not_e164" }); return z.NEVER; }
  return e164;
});
const emailField = z.string().min(3).max(254).refine((v) => EMAIL.test(v), "email_invalid").transform((v) => v.toLowerCase());
const ContactFields = {
  given_name: text(100).optional(), family_name: text(100).optional(), organization: text(100).optional(),
  emails: z.array(emailField).max(5).optional(), phones: z.array(phoneField).max(5).optional()
};
const resourceName = z.string().regex(RESOURCE_NAME);
export const ContactsListSchema = z.object({ page_size: z.number().int().min(1).max(200).optional(), page_token: z.string().min(1).max(500).optional() }).strict();
export const ContactsSearchSchema = z.object({ query: z.string().min(1).max(100), page_size: z.number().int().min(1).max(30).optional() }).strict();
export const ContactsGetSchema = z.object({ resource_name: resourceName }).strict();
export const ContactsCreateSchema = z.object(ContactFields).strict().refine((v) => Object.values(v).some((x) => x !== undefined), "empty_contact");
export const ContactsUpdateSchema = z.object({ resource_name: resourceName, etag: z.string().regex(ETAG), ...ContactFields }).strict().refine((v) => [v.given_name, v.family_name, v.organization, v.emails, v.phones].some((x) => x !== undefined), "no_changes");
export const ContactsDeleteSchema = z.object({ resource_name: resourceName }).strict();
export const ContactsSyncSchema = z.object({ page_size: z.number().int().min(1).max(100).optional(), page_token: z.string().min(1).max(500).optional() }).strict();

export interface ContactView {
  readonly resource_name: string;
  readonly etag: string | null;
  readonly display_name: string | null;
  readonly emails: string[];
  readonly phones: string[];
  readonly organization: string | null;
}

const rec = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length > 0 ? sanitizeInboundText(v.slice(0, max)) : null);

/** Normaliserer en People-`Person` til minimerte felt (aldri adresser, notater, bilder, fødselsdag). Ugyldig/ukjent form = `null`. */
export function viewOf(person: unknown): ContactView | null {
  const p = rec(person);
  const name = typeof p?.["resourceName"] === "string" && RESOURCE_NAME.test(p["resourceName"]) ? p["resourceName"] : null;
  if (p === null || name === null) return null;
  const emails = arr(p["emailAddresses"]).flatMap((e) => { const v = rec(e)?.["value"]; return typeof v === "string" && EMAIL.test(v) ? [v.toLowerCase()] : []; });
  const phones = arr(p["phoneNumbers"]).flatMap((e) => { const v = rec(e)?.["value"]; const n = typeof v === "string" ? normalizeE164(v, { allowBareInternationalDigits: false }) : null; return n === null ? [] : [n]; });
  const first = rec(arr(p["names"])[0]);
  const org = rec(arr(p["organizations"])[0]);
  return {
    resource_name: name, etag: typeof p["etag"] === "string" && ETAG.test(p["etag"]) ? p["etag"] : null,
    display_name: str(first?.["displayName"], 200), emails: [...new Set(emails)].slice(0, 10), phones: [...new Set(phones)].slice(0, 10), organization: str(org?.["name"], 200)
  };
}

function personBody(input: { given_name?: string | undefined; family_name?: string | undefined; organization?: string | undefined; emails?: string[] | undefined; phones?: string[] | undefined }): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.given_name !== undefined || input.family_name !== undefined) body["names"] = [{ ...(input.given_name !== undefined ? { givenName: input.given_name } : {}), ...(input.family_name !== undefined ? { familyName: input.family_name } : {}) }];
  if (input.emails !== undefined) body["emailAddresses"] = input.emails.map((value) => ({ value }));
  if (input.phones !== undefined) body["phoneNumbers"] = input.phones.map((value) => ({ value }));
  if (input.organization !== undefined) body["organizations"] = [{ name: input.organization }];
  return body;
}

function assertResourceName(name: string): void {
  if (!RESOURCE_NAME.test(name)) throw new Error("comms_contacts_resource_name_invalid");
}

function reject(res: { status: number; json: Record<string, unknown> | null }): never {
  const status = rec(res.json?.["error"])?.["status"];
  throw new ProviderRejectedError("google_contacts", status === undefined ? `http_${res.status}` : safeVendorCode(status));
}

export class GoogleContacts {
  /** `tokenFor`: refresh-token -> access-token (i drift `googleAccessToken` fra tool-gateway, delt Google-klient). */
  constructor(private readonly tokenFor: (refreshToken: string) => Promise<string>) {}

  private async call(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, refreshToken: string, body?: Record<string, unknown>, mutation = false): Promise<{ status: number; json: Record<string, unknown> | null }> {
    let token: string;
    try {
      token = await this.tokenFor(refreshToken);
    } catch {
      throw new Error("comms_contacts_token_unavailable");
    }
    return providerCall("google_contacts", `${PEOPLE}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, mutation);
  }

  async list(refreshToken: string, pageSize: number, pageToken: string | undefined): Promise<{ contacts: ContactView[]; next_page_token: string | null }> {
    const q = new URLSearchParams({ personFields: READ_FIELDS, pageSize: String(pageSize) });
    if (pageToken !== undefined) q.set("pageToken", pageToken);
    const res = await this.call("GET", `/people/me/connections?${q.toString()}`, refreshToken);
    if (res.status >= 400) return reject(res);
    const next = res.json?.["nextPageToken"];
    return { contacts: arr(res.json?.["connections"]).flatMap((c) => { const v = viewOf(c); return v === null ? [] : [v]; }), next_page_token: typeof next === "string" && next.length <= 500 ? next : null };
  }

  async search(refreshToken: string, query: string, pageSize: number): Promise<ContactView[]> {
    const q = new URLSearchParams({ query, readMask: READ_FIELDS, pageSize: String(pageSize) });
    const res = await this.call("GET", `/people:searchContacts?${q.toString()}`, refreshToken);
    if (res.status >= 400) return reject(res);
    return arr(res.json?.["results"]).flatMap((r) => { const v = viewOf(rec(r)?.["person"]); return v === null ? [] : [v]; });
  }

  /** `null` = finnes ikke (404) - også etterbetingelsen for sletting. */
  async get(refreshToken: string, name: string): Promise<ContactView | null> {
    assertResourceName(name);
    const res = await this.call("GET", `/${name}?personFields=${READ_FIELDS}`, refreshToken);
    if (res.status === 404) return null;
    if (res.status >= 400) return reject(res);
    const view = viewOf(res.json);
    if (view === null) throw new Error("comms_contacts_unreadable_contact");
    return view;
  }

  async create(refreshToken: string, input: z.infer<typeof ContactsCreateSchema>): Promise<ContactView> {
    const res = await this.call("POST", `/people:createContact?personFields=${READ_FIELDS}`, refreshToken, personBody(input), true);
    if (res.status >= 400) return reject(res);
    const view = viewOf(res.json);
    if (view === null) throw new Error("outcome_unknown:comms_contacts_no_resource_name");
    return view;
  }

  /** Lese-endre-skriv: ferskt oppslag, etag-sammenligning (konflikt = ingen skriving), PATCH med KUN de oppgitte feltene i `updatePersonFields`. */
  async update(refreshToken: string, input: z.infer<typeof ContactsUpdateSchema>): Promise<ContactView> {
    assertResourceName(input.resource_name);
    const fresh = await this.call("GET", `/${input.resource_name}?personFields=${READ_FIELDS}`, refreshToken);
    if (fresh.status === 404) throw new ProviderRejectedError("google_contacts", "not_found");
    if (fresh.status >= 400) return reject(fresh);
    if (fresh.json?.["etag"] !== input.etag) throw new ProviderRejectedError("google_contacts", "etag_conflict");
    const fields = WRITE_FIELDS.filter((f) => (f === "names" ? input.given_name !== undefined || input.family_name !== undefined : f === "emailAddresses" ? input.emails !== undefined : f === "phoneNumbers" ? input.phones !== undefined : input.organization !== undefined));
    // Google krever kildens etag i `metadata.sources` (verifisert) - tas fra den ferske lesingen, aldri fra eieren.
    const body = { ...personBody(input), etag: input.etag, ...(fresh.json["metadata"] !== undefined ? { metadata: fresh.json["metadata"] } : {}) };
    const res = await this.call("PATCH", `/${input.resource_name}:updateContact?updatePersonFields=${fields.join(",")}&personFields=${READ_FIELDS}`, refreshToken, body, true);
    if (res.status >= 400) return reject(res);
    const view = viewOf(res.json);
    if (view === null) throw new Error("outcome_unknown:comms_contacts_unreadable_update");
    return view;
  }

  async delete(refreshToken: string, name: string): Promise<void> {
    assertResourceName(name);
    const res = await this.call("DELETE", `/${name}:deleteContact`, refreshToken, undefined, true);
    if (res.status === 404) return; // allerede borte = etterbetingelsen er oppfylt
    if (res.status >= 400) return reject(res);
  }
}
