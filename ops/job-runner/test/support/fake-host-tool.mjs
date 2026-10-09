#!/usr/bin/env node
/**
 * WP-C1 (test): falske vertsverktøy (docker nettverk, iptables, iptables-restore) for å teste setup-network.sh UTEN root, UTEN Docker og
 * UTEN å røre vertens brannmur. Kalles via små sh-skall-skript (`<verktøy>`) som peker hit; tilstanden ligger i $FAKE_STATE (JSON-filer).
 *
 *   fake-host-tool.mjs <docker|iptables|iptables-restore> <argumenter...>
 *
 * Dette er en MODELL av atferden scriptet avhenger av, ikke bevis for at en ekte brannmur blokkerer noe (se acceptance.sh J07 på verten).
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [tool, ...args] = process.argv.slice(2);
const state = process.env["FAKE_STATE"] ?? "";
const file = (name) => join(state, name);
const load = (name, fallback) => (existsSync(file(name)) ? JSON.parse(readFileSync(file(name), "utf8")) : fallback);
const save = (name, value) => writeFileSync(file(name), JSON.stringify(value));
appendFileSync(file("calls.log"), `${tool} ${args.join(" ")}\n`);

/** Normaliserer en regel slik iptables-save skriver den (kun de formene setup-network.sh bruker). */
function normalize(rule) {
  const m = /^-A (\S+) -p tcp -d (\d+\.\d+\.\d+\.\d+) --dport (\d+) -j ACCEPT$/.exec(rule);
  if (m) return `-A ${m[1]} -d ${m[2]}/32 -p tcp -m tcp --dport ${m[3]} -j ACCEPT`;
  return rule;
}

if (tool === "docker") {
  if (args[0] === "network" && args[1] === "inspect") {
    const net = load("network.json", null);
    const name = args[args.length - 1];
    if (!net || net.name !== name) {
      console.error(`Error response from daemon: network ${name} not found`);
      process.exit(1);
    }
    const formatIndex = args.indexOf("--format");
    if (formatIndex === -1) {
      console.log("[]");
    } else if (args[formatIndex + 1] === "{{.Id}}") {
      console.log(net.id);
    } else {
      console.log(`${net.internal}|${net.driver}|${net.subnet},${net.gateway};|${net.icc ?? ""}|${net.bridge ?? ""}`);
    }
    process.exit(0);
  }
  if (args[0] === "network" && args[1] === "create") {
    const opts = {};
    let internal = false;
    let driver = "bridge";
    let subnet = "";
    let gateway = "";
    for (let i = 2; i < args.length - 1; i++) {
      const a = args[i];
      if (a === "--internal") internal = true;
      else if (a === "--driver") driver = args[++i];
      else if (a === "--subnet") subnet = args[++i];
      else if (a === "--gateway") gateway = args[++i];
      else if (a === "--opt") {
        const [k, v] = args[++i].split("=");
        opts[k] = v;
      }
    }
    save("network.json", {
      name: args[args.length - 1], id: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      internal, driver, subnet, gateway, icc: opts["com.docker.network.bridge.enable_icc"], bridge: opts["com.docker.network.bridge.name"]
    });
    console.log("0123456789ab");
    process.exit(0);
  }
  console.error("fake docker: ukjent kommando");
  process.exit(3);
}

if (tool === "iptables") {
  const a = args.filter((x) => x !== "-w");
  const st = load("iptables.json", { input: [], chains: {} });
  if (a[0] === "-C" && a[1] === "INPUT") process.exit(st.input.includes(`-A INPUT ${a.slice(2).join(" ")}`) ? 0 : 1);
  if (a[0] === "-I" && a[1] === "INPUT" && a[2] === "1") {
    st.input.unshift(`-A INPUT ${a.slice(3).join(" ")}`);
    save("iptables.json", st);
    process.exit(0);
  }
  if (a[0] === "-D" && a[1] === "INPUT" && /^\d+$/.test(a[2] ?? "")) {
    const index = Number(a[2]) - 1;
    if (index < 0 || index >= st.input.length) process.exit(1);
    st.input.splice(index, 1);
    save("iptables.json", st);
    process.exit(0);
  }
  if (a[0] === "-S" && a[1] === "INPUT") {
    console.log("-P INPUT ACCEPT");
    for (const r of st.input) console.log(r);
    process.exit(0);
  }
  if (a[0] === "-S" && st.chains[a[1]]) {
    console.log(`-N ${a[1]}`);
    for (const r of st.chains[a[1]]) console.log(r);
    process.exit(0);
  }
  if (a[0] === "-S") {
    console.error("iptables: No chain/target/match by that name.");
    process.exit(1);
  }
  console.error(`fake iptables: ukjent kommando ${a.join(" ")}`);
  process.exit(3);
}

if (tool === "iptables-restore") {
  if (!args.includes("--noflush")) {
    console.error("fake iptables-restore: --noflush mangler (ville nullstilt hele tabellen)");
    process.exit(4);
  }
  const st = load("iptables.json", { input: [], chains: {} });
  const text = readFileSync(0, "utf8");
  writeFileSync(file("restore-input.txt"), text);
  for (const line of text.split("\n")) {
    const decl = /^:(\S+) - \[0:0\]$/.exec(line);
    if (decl) st.chains[decl[1]] = []; // deklarasjon av en eksisterende brukerkjede nullstiller den (også med --noflush)
    const rule = /^-A (\S+) /.exec(line);
    if (rule) {
      if (!st.chains[rule[1]]) {
        console.error(`fake iptables-restore: kjede ${rule[1]} er ikke deklarert`);
        process.exit(5);
      }
      st.chains[rule[1]].push(normalize(line));
    }
  }
  save("iptables.json", st);
  process.exit(0);
}

console.error(`fake-host-tool: ukjent verktøy ${tool}`);
process.exit(9);
