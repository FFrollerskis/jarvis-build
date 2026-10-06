#!/usr/bin/env node
// EV-0 (D-406): eierens OFFLINE-verktøy for Safety Constitution. Kjøres av Tobias på en maskin Jarvis ikke har tilgang til.
// Privatnøkkelen skal aldri inn i repoet, NAS-en, chat eller Jarvis sine miljøvariabler.
//   node ops/security/sign-constitution.mjs keygen <privat.pem> <offentlig.pem>   # lager Ed25519-par (nekter å overskrive)
//   node ops/security/sign-constitution.mjs sign <privat.pem> [manifest.json] [sig-ut]
//   node ops/security/sign-constitution.mjs fingerprint <offentlig.pem>           # verdien som festes i NAS-.env
//   node ops/security/sign-constitution.mjs verify <offentlig.pem> [manifest.json] [sig]
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const DEFAULT_MANIFEST = "config/evolution/constitution.v1.json";
const DEFAULT_SIG = "config/evolution/constitution.v1.sig";

/** MÅ være identisk med `canonicalizeManifest` i modules/self-modification/src/constitution.ts. */
export function canonicalize(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    return v;
  };
  return JSON.stringify(sort(value));
}

export function fingerprint(publicKeyPem) {
  return createHash("sha256").update(createPublicKey(publicKeyPem).export({ type: "spki", format: "der" })).digest("hex");
}

function main(argv) {
  const [cmd, a, b, c] = argv;
  if (cmd === "keygen") {
    if (!a || !b) throw new Error("bruk: keygen <privat.pem> <offentlig.pem>");
    if (existsSync(a) || existsSync(b)) throw new Error("nekter å overskrive eksisterende nøkkelfil");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    writeFileSync(a, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    writeFileSync(b, publicKey.export({ type: "spki", format: "pem" }));
    console.log(`privat nøkkel: ${a} (OPPBEVAR OFFLINE)\noffentlig nøkkel: ${b}\nfingeravtrykk: ${fingerprint(readFileSync(b, "utf8"))}`);
  } else if (cmd === "sign") {
    if (!a) throw new Error("bruk: sign <privat.pem> [manifest] [sig-ut]");
    const manifest = JSON.parse(readFileSync(b ?? DEFAULT_MANIFEST, "utf8"));
    const sig = sign(null, Buffer.from(canonicalize(manifest), "utf8"), createPrivateKey(readFileSync(a, "utf8")));
    writeFileSync(c ?? DEFAULT_SIG, `${sig.toString("base64")}\n`);
    console.log(`signert ${b ?? DEFAULT_MANIFEST} -> ${c ?? DEFAULT_SIG}`);
  } else if (cmd === "fingerprint") {
    if (!a) throw new Error("bruk: fingerprint <offentlig.pem>");
    console.log(fingerprint(readFileSync(a, "utf8")));
  } else if (cmd === "verify") {
    if (!a) throw new Error("bruk: verify <offentlig.pem> [manifest] [sig]");
    const manifest = JSON.parse(readFileSync(b ?? DEFAULT_MANIFEST, "utf8"));
    const ok = verify(null, Buffer.from(canonicalize(manifest), "utf8"), createPublicKey(readFileSync(a, "utf8")),
      Buffer.from(readFileSync(c ?? DEFAULT_SIG, "utf8").trim(), "base64"));
    console.log(ok ? "OK: signaturen er gyldig" : "FEIL: signaturen er ugyldig");
    process.exitCode = ok ? 0 : 1;
  } else {
    throw new Error("kommandoer: keygen | sign | fingerprint | verify");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(process.argv.slice(2)); } catch (err) { console.error(err.message); process.exitCode = 2; }
}
