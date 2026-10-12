import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readlinkSync } from "node:fs";

export const SITE_IP = "198.51.100.1";
export const SITE_ORIGIN = `http://${SITE_IP}:9000`;
export type NatMode = "preserve" | "random";
export type Fault = "none" | "peer-block" | "udp-block" | "stun-primary" | "delay" | "loss" | "rate" | "signaling";

export function command(program: string, args: string[], input?: string): string {
  return execFileSync(program, args, { encoding: "utf8", timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"], input }).trim();
}

// Owns only namespaces and veth pairs created by this run. All routing,
// firewall and sysctl changes happen inside those namespaces.
export class LabNetwork {
  readonly prefix = `piiklab-${randomBytes(4).toString("hex")}`;
  readonly namespaces: string[] = [];
  private readonly pendingLinks = new Set<string>();
  private readonly originalRoutes = command("ip", ["-j", "route", "show", "table", "all"]);
  private readonly originalRules = command("nft", ["-s", "list", "ruleset"]);
  readonly wan = `${this.prefix}-wan`;

  exec(namespace: string, program: string, args: string[], input?: string): string {
    if (!this.namespaces.includes(namespace)) throw new Error("Unowned network namespace");
    return command("ip", ["netns", "exec", namespace, program, ...args], input);
  }

  private add(name: string): void {
    command("ip", ["netns", "add", name]);
    this.namespaces.push(name);
    this.exec(name, "ip", ["link", "set", "lo", "up"]);
  }

  private wire(left: string, leftName: string, right: string, rightName: string): void {
    const suffix = randomBytes(4).toString("hex");
    const a = `pl${suffix}a`, b = `pl${suffix}b`;
    command("ip", ["link", "add", a, "type", "veth", "peer", "name", b]);
    this.pendingLinks.add(a); this.pendingLinks.add(b);
    for (const [device, namespace, name] of [[a, left, leftName], [b, right, rightName]]) {
      command("ip", ["link", "set", device!, "netns", namespace!]);
      this.pendingLinks.delete(device!);
      this.exec(namespace!, "ip", ["link", "set", device!, "name", name!]);
      this.exec(namespace!, "ip", ["link", "set", name!, "up"]);
    }
  }

  setup(modes: NatMode[]): void {
    this.add(this.wan);
    this.exec(this.wan, "ip", ["link", "add", "internet", "type", "bridge"]);
    this.exec(this.wan, "ip", ["addr", "add", `${SITE_IP}/24`, "dev", "internet"]);
    this.exec(this.wan, "ip", ["addr", "add", "198.51.100.2/24", "dev", "internet"]);
    this.exec(this.wan, "ip", ["link", "set", "internet", "up"]);
    for (const [index, mode] of modes.entries()) {
      const n = index + 1, endpoint = this.endpoint(index), router = this.router(index);
      this.add(endpoint); this.add(router);
      this.wire(endpoint, "eth0", router, "lan0");
      this.wire(router, "wan0", this.wan, `port${n}`);
      this.exec(this.wan, "ip", ["link", "set", `port${n}`, "master", "internet"]);
      this.exec(endpoint, "ip", ["addr", "add", `10.71.${n}.2/24`, "dev", "eth0"]);
      this.exec(router, "ip", ["addr", "add", `10.71.${n}.1/24`, "dev", "lan0"]);
      this.exec(router, "ip", ["addr", "add", `${this.publicIP(index)}/24`, "dev", "wan0"]);
      this.exec(endpoint, "ip", ["route", "add", "default", "via", `10.71.${n}.1`]);
      this.exec(router, "sysctl", ["-qw", "net.ipv4.ip_forward=1"]);
      this.exec(router, "nft", ["-f", "-"], `
table ip lab_nat {
 chain postrouting { type nat hook postrouting priority srcnat; policy accept;
  oifname "wan0" snat to ${this.publicIP(index)}${mode === "random" ? " fully-random" : ""}
 }
}
table inet lab_filter {
 chain faults {}
 chain forward { type filter hook forward priority filter; policy drop;
  jump faults
  iifname "lan0" counter accept
  ct state established,related counter accept
 }
}
`);
    }
  }

  endpoint(index: number): string { return `${this.prefix}-end${index}`; }
  router(index: number): string { return `${this.prefix}-nat${index}`; }
  publicIP(index: number): string { return `198.51.100.${11 + index}`; }

  setFault(index: number, fault: Fault, seed: number): void {
    const router = this.router(index);
    this.exec(router, "nft", ["flush", "chain", "inet", "lab_filter", "faults"]);
    const rules: Partial<Record<Fault, string>> = {
      "peer-block": "ip daddr 198.51.100.11-198.51.100.30 udp dport 1-65535 counter drop",
      "udp-block": "meta l4proto udp counter drop",
      "stun-primary": `ip daddr ${SITE_IP} udp dport 3478 counter drop`,
      signaling: `ip daddr ${SITE_IP} tcp dport 9000 counter drop`,
    };
    if (rules[fault]) this.exec(router, "nft", ["-f", "-"],
      `add rule inet lab_filter faults ${rules[fault]}\n`);
    const impairment = fault === "delay" ? ["delay", "100ms", "20ms", "distribution", "normal"]
      : fault === "loss" ? ["loss", "random", "5%", "seed", String(seed)]
      : fault === "rate" ? ["rate", "600kbit", "limit", "30"] : ["delay", "0ms"];
    this.exec(router, "tc", ["qdisc", "replace", "dev", "wan0", "root", "netem", ...impairment]);
  }

  counters(index: number): unknown {
    return {
      firewall: JSON.parse(this.exec(this.router(index), "nft", ["-j", "list", "table", "inet", "lab_filter"])),
      queue: JSON.parse(this.exec(this.router(index), "tc", ["-j", "-s", "qdisc", "show", "dev", "wan0"])),
    };
  }

  async close(): Promise<{ namespacesRemoved: boolean; hostNetworkUnchanged: boolean }> {
    const failures: string[] = [];
    for (const namespace of [...this.namespaces].reverse()) {
      try {
        const identity = this.exec(namespace, "readlink", ["/proc/self/ns/net"]);
        const pids = command("ip", ["netns", "pids", namespace]).split(/\s+/).filter(Boolean);
        for (const pid of pids) {
          // Check membership again: do not signal an unrelated reused PID.
          try { if (readlinkSync(`/proc/${pid}/ns/net`) === identity) process.kill(Number(pid), "SIGKILL"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        }
        command("ip", ["netns", "delete", namespace]);
      } catch { failures.push(namespace); }
    }
    for (const link of this.pendingLinks) {
      // A failed move may already have destroyed the pair through namespace cleanup.
      try { command("ip", ["link", "delete", link]); } catch {}
    }
    const remaining = command("ip", ["netns", "list"]);
    return {
      namespacesRemoved: failures.length === 0 && !remaining.includes(this.prefix),
      hostNetworkUnchanged: command("ip", ["-j", "route", "show", "table", "all"]) === this.originalRoutes &&
        command("nft", ["-s", "list", "ruleset"]) === this.originalRules,
    };
  }
}
