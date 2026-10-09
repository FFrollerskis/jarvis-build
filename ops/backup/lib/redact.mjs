/**
 * WP-C2: ingen hemmelighet skal kunne havne i statusfil, eksport, logg eller feilmelding. To lag:
 *  1. KJENTE verdier fra miljøet (DB-passord, scratch-passord, heartbeat-URL-er med nøkkel i stien, rclone-passord ...) erstattes bokstavelig,
 *  2. mønstre (URL-er, age-privatnøkler, `passord=...`-par) fjernes uansett opprinnelse.
 * Utdata er alltid én linje, avkortet. Verktøyutdata (pg_dump/rclone/rsync/ssh) er UBETRODD tekst: den lagres kun redigert i den interne
 * (0600) statusfilen og eksporteres aldri som tekst - kun som oppramsede feilkoder.
 */
const SECRET_NAME = /(PASSWORD|PASSPHRASE|_PASS|SECRET|TOKEN|API_KEY|APIKEY|PRIVATE|CREDENTIAL|WEBHOOK|_KEY|HEARTBEAT[A-Z_]*URL)$/i;
const NOT_SECRET_VALUE = new Set(["true", "false", "yes", "no", "on", "off"]);

/** Verdier (>= 8 tegn) til variabler som ser ut som hemmeligheter; for URL-verdier også sti og query (nøkkelen i en heartbeat-URL). */
export function secretValuesFrom(env = process.env) {
  const values = new Set();
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || value.length < 8 || !SECRET_NAME.test(name) || NOT_SECRET_VALUE.has(value.toLowerCase())) continue;
    values.add(value);
    try {
      const u = new URL(value);
      // Nøkkelen i en heartbeat-URL står i stien: ta både hele stien/query og hvert enkelt segment (feilmeldinger siterer ofte bare ett).
      const parts = [u.pathname, u.search, u.username, u.password, ...u.pathname.split("/"), ...u.search.replace(/^\?/, "").split(/[&=]/)];
      for (const part of parts) if (part && part.length >= 8) values.add(part);
    } catch {
      // ikke en URL
    }
  }
  return [...values].sort((a, b) => b.length - a.length); // lengste først, så delstrenger ikke blir igjen
}

export function makeRedactor(env = process.env) {
  const secrets = secretValuesFrom(env);
  return function redact(text, max = 300) {
    let out = String(text ?? "");
    for (const s of secrets) out = out.split(s).join("<redacted>");
    out = out
      .replace(/AGE-SECRET-KEY-[A-Z0-9]+/g, "<age-secret>")
      .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'")]+/gi, "<url>")
      .replace(/\bauthorization\s*[:=]\s*(?:\w+\s+)?\S+/gi, "authorization=<redacted>")
      .replace(/\b(password|passwd|pwd|token|secret|apikey|api_key)\s*[:=]\s*\S+/gi, "$1=<redacted>")
      .replace(/\bbearer\s+\S+/gi, "bearer <redacted>")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    return out.length > max ? `${out.slice(0, max - 1)}…` : out;
  };
}
