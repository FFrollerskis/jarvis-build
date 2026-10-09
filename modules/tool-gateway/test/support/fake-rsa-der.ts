/**
 * WP-C3 (review F4): en RSA-«nøkkel» med nøyaktig oppgitt modulus-bitlengde, bygget direkte som PKCS#1 DER. Tallene er IKKE et ekte nøkkelpar (primtallene er oppdiktet) - kun
 * ASN.1-FORMEN er gyldig, og det er nok: `crypto.createPrivateKey` parser den og rapporterer `modulusLength` uten å validere tallteorien. Det lar testene prøve størrelsesgrensene
 * (2047/2048 og 16384/16385 bit) uten å generere ekte 16 000-bit nøkler (minutter). Aldri bruk til signering. Bygges kun ved kjøring - ingen PEM-literal i kildekoden.
 */

function derLength(length: number): Buffer {
  if (length < 128) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let remaining = length; remaining > 0; remaining = Math.floor(remaining / 256)) bytes.unshift(remaining % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const derTlv = (tag: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);

function derInteger(value: bigint): Buffer {
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  let bytes = Buffer.from(hex, "hex");
  if (((bytes[0] ?? 0) & 0x80) !== 0) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return derTlv(0x02, bytes);
}

export function fakeRsaPrivateKeyPem(modulusBits: number): string {
  const modulus = (1n << BigInt(modulusBits - 1)) + 12_345n; // bitlengde = modulusBits
  const half = (1n << BigInt(Math.floor(modulusBits / 2) - 1)) + 7n;
  const integers = [0n, modulus, 65_537n, modulus - 2n, half, half + 2n, half - 1n, half - 3n, half + 4n].map(derInteger);
  const body = derTlv(0x30, Buffer.concat(integers)).toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
  return [`-----BEGIN ${"RSA"} PRIVATE KEY-----`, body, `-----END ${"RSA"} PRIVATE KEY-----`, ""].join("\n");
}
