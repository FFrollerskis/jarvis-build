#!/usr/bin/env node
// Remediering del 2 (JARVIS-010): genererer `environment:`-blokkene i infra/local/docker-compose.yml fra
// infra/local/service-env.mjs (én kilde til sannhet). Kjør: `node ops/security/generate-compose-env.mjs [service...]`
// Uten argument skrives alle tjenester. Strukturtesten låser at compose og manifestet er like.
import { FIXED_ENV, SERVICE_ENV } from "../../infra/local/service-env.mjs";

/** Standardverdier for variabler der compose historisk har hatt en default. */
export const DEFAULTS = {
  JARVIS_API_PORT: "3010",
  JARVIS_VOICE_PORT: "3020",
  JARVIS_BROWSER_GATEWAY_PORT: "3030",
  JARVIS_ENV: "dev",
  LANGFUSE_BASE_URL: "http://langfuse:3000"
};

/** Variabler som MÅ være satt (compose feiler ved `config`/`up` hvis de mangler). */
export const REQUIRED = {
  browser: { JARVIS_BROWSER_GATEWAY_TOKEN_SECRET: "sett JARVIS_BROWSER_GATEWAY_TOKEN_SECRET (>= 32 tegn) i .env" }
};

export function renderEnvironment(service, indent = "      ") {
  const names = SERVICE_ENV[service];
  if (!names) throw new Error(`ukjent tjeneste: ${service}`);
  const lines = [`${indent}# GENERERT fra infra/local/service-env.mjs (SERVICE_ENV.${service}) - rediger der, ikke her.`];
  for (const [name, value] of Object.entries(FIXED_ENV[service] ?? {})) {
    lines.push(`${indent}${name}: ${JSON.stringify(value)}`);
  }
  for (const name of [...names].sort()) {
    if (name in (FIXED_ENV[service] ?? {})) continue;
    const required = REQUIRED[service]?.[name];
    const expr = required ? `\${${name}:?${required}}` : name in DEFAULTS ? `\${${name}:-${DEFAULTS[name]}}` : `\${${name}:-}`;
    lines.push(`${indent}${name}: ${JSON.stringify(expr)}`);
  }
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const wanted = process.argv.slice(2);
  for (const service of wanted.length ? wanted : Object.keys(SERVICE_ENV)) {
    console.log(`# --- ${service} ---\n${renderEnvironment(service)}\n`);
  }
}
