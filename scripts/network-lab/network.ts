import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readlinkSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export const SITE_IP = "198.51.100.1";
export const SITE_IPV6 = "2001:db8:71::1";
export const SITE_ORIGIN = `http://${SITE_IP}:9000`;
export type NatMode = "preserve" | "sequential" | "random";
export type Fault = "none" | "peer-block" | "udp-block" | "ipv4-block" | "stun-primary" | "delay" | "loss" | "rate" | "signaling";

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
  private readonly shaped = new Set<string>();
  private readonly udpAddresses = new Map<number, string>();
  private readonly originalRoutes = command("ip", ["-j", "route", "show", "table", "all"]);
  private readonly originalRoutes6 = command("ip", ["-6", "-j", "route", "show", "table", "all"]);
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

  setup(modes: readonly NatMode[], ipv6 = false, failSetup = false): void {
    this.add(this.wan);
    this.exec(this.wan, "ip", ["link", "add", "internet", "type", "bridge"]);
    this.exec(this.wan, "ip", ["addr", "add", `${SITE_IP}/24`, "dev", "internet"]);
    this.exec(this.wan, "ip", ["addr", "add", "198.51.100.2/24", "dev", "internet"]);
    this.exec(this.wan, "ip", ["link", "set", "internet", "up"]);
    if (ipv6) this.exec(this.wan, "ip", ["-6", "addr", "add", `${SITE_IPV6}/64`, "dev", "internet", "nodad"]);
    for (const [index, mode] of modes.entries()) {
      const n = index + 1, endpoint = this.endpoint(index), router = this.router(index);
      this.add(endpoint); this.add(router);
      this.wire(endpoint, "eth0", router, "lan0");
      if (failSetup) throw new Error("Injected partial network setup failure");
      this.wire(router, "wan0", this.wan, `port${n}`);
      this.exec(this.wan, "ip", ["link", "set", `port${n}`, "master", "internet"]);
      this.exec(endpoint, "ip", ["addr", "add", `10.71.${n}.2/24`, "dev", "eth0"]);
      this.exec(router, "ip", ["addr", "add", `10.71.${n}.1/24`, "dev", "lan0"]);
      this.exec(router, "ip", ["addr", "add", `${this.publicIP(index)}/24`, "dev", "wan0"]);
      this.exec(endpoint, "ip", ["route", "add", "default", "via", `10.71.${n}.1`]);
      this.exec(router, "sysctl", ["-qw", "net.ipv4.ip_forward=1"]);
      if (ipv6) {
        const wan = `2001:db8:71::${11 + index}`, lan = `2001:db8:72:${n}::1`;
        this.exec(router, "sysctl", ["-qw", "net.ipv6.conf.all.forwarding=1"]);
        this.exec(router, "ip", ["-6", "addr", "add", `${wan}/64`, "dev", "wan0", "nodad"]);
        this.exec(router, "ip", ["-6", "addr", "add", `${lan}/64`, "dev", "lan0", "nodad"]);
        this.exec(endpoint, "ip", ["-6", "addr", "add", `${this.ipv6(index)}/64`, "dev", "eth0", "nodad"]);
        this.exec(endpoint, "ip", ["-6", "route", "add", "default", "via", lan]);
        this.exec(router, "ip", ["-6", "route", "add", "default", "via", SITE_IPV6]);
        this.exec(this.wan, "ip", ["-6", "route", "add", `2001:db8:72:${n}::/64`, "via", wan]);
      }
      this.exec(router, "nft", ["-f", "-"], `
table ip lab_nat {
 ${mode === "sequential" ? `map ports { type integer : inet_service; elements = { ${Array.from({ length: 4096 }, (_, port) => `${port} : ${40000 + port}`).join(", ")} } }` : ""}
 chain postrouting { type nat hook postrouting priority srcnat; policy accept;
  ${mode === "sequential" ? `oifname "wan0" meta l4proto udp snat to ${this.publicIP(index)}:numgen inc mod 4096 map @ports` : ""}
  oifname "wan0" snat to ${this.publicIP(index)}${mode === "random" ? " fully-random" : ""}
 }
}
table inet lab_filter {
 chain input { type filter hook input priority filter; policy accept;
  # Do not confirm unsolicited UDP as a router-local connection. Its reverse
  # tuple can otherwise steal the peer's later SNAT mapping before hole punching.
  iifname "wan0" meta l4proto udp ct state new counter drop
 }
 chain faults {}
 chain forward { type filter hook forward priority filter; policy drop;
  jump faults
  iifname "lan0" counter accept
  ct state established,related counter accept
 }
}
`);
    }
    if (ipv6) this.exec(this.wan, "sysctl", ["-qw", "net.ipv6.conf.all.forwarding=1"]);
  }

  endpoint(index: number): string { return `${this.prefix}-end${index}`; }
  router(index: number): string { return `${this.prefix}-nat${index}`; }
  publicIP(index: number): string { return this.udpAddresses.get(index) ?? `198.51.100.${11 + index}`; }
  ipv6(index: number): string { return `2001:db8:72:${index + 1}:0:0:0:2`; }
  localAddresses(index: number): string[] {
    return [`10.71.${index + 1}.2`, new URL(`http://[${this.ipv6(index)}]`).hostname.slice(1, -1)];
  }

  remapUDP(index: number): { before: string; after: string } {
    const router = this.router(index), before = this.publicIP(index), after = `198.51.100.${51 + index}`;
    if (this.udpAddresses.has(index)) throw new Error("UDP address has already changed");
    this.exec(router, "ip", ["addr", "add", `${after}/24`, "dev", "wan0"]);
    this.exec(router, "nft", [`
flush chain ip lab_nat postrouting
add rule ip lab_nat postrouting oifname "wan0" meta l4proto udp snat to ${after}
add rule ip lab_nat postrouting oifname "wan0" snat to ${before}
`]);
    // Only this isolated router's UDP mappings change; the real TCP signaling
    // connection retains its original address and connection tracking entry.
    this.exec(router, "conntrack", ["-D", "-p", "udp"]);
    this.udpAddresses.set(index, after);
    return { before, after };
  }

  setFault(index: number, fault: Fault, seed: number, direction: "uplink" | "downlink" = "uplink"): void {
    const router = this.router(index);
    this.exec(router, "nft", ["flush", "chain", "inet", "lab_filter", "faults"]);
    const rules: Partial<Record<Fault, string>> = {
      "peer-block": "ip daddr 198.51.100.11-198.51.100.30 udp dport 1-65535 counter drop",
      "udp-block": "meta l4proto udp counter drop",
      "ipv4-block": "meta nfproto ipv4 meta l4proto udp counter drop",
      "stun-primary": `ip daddr ${SITE_IP} udp dport 3478 counter drop`,
      signaling: `ip daddr ${SITE_IP} tcp dport 9000 counter drop`,
    };
    if (rules[fault]) this.exec(router, "nft", [`add rule inet lab_filter faults ${rules[fault]}`]);
    // netem change/replace retains omitted attributes (including RATE). A new
    // scenario phase owns a fresh qdisc, not the previous phase's hidden state.
    for (const device of ["wan0", "lan0"]) {
      if (!this.shaped.has(`${router}/${device}`)) continue;
      this.exec(router, "tc", ["qdisc", "del", "dev", device, "root"]);
      this.shaped.delete(`${router}/${device}`);
    }
    const impairment = fault === "delay" ? ["delay", "100ms", "20ms", "distribution", "normal", "seed", String(seed)]
      : fault === "loss" ? ["loss", "random", "5%", "seed", String(seed)]
      : fault === "rate" ? ["rate", "600kbit", "limit", "30"] : null;
    if (impairment) {
      const device = direction === "uplink" ? "wan0" : "lan0";
      this.exec(router, "tc", ["qdisc", "add", "dev", device, "root", "netem", ...impairment]);
      this.shaped.add(`${router}/${device}`);
    }
  }

  counters(index: number): { firewall: unknown; queue: unknown; faultDrops: number } {
    const firewall = JSON.parse(this.exec(this.router(index), "nft", ["-j", "list", "table", "inet", "lab_filter"]));
    const faultDrops = firewall.nftables.reduce((total: number, entry: { rule?: { chain: string; expr: Array<{ counter?: { packets: number } }> } }) =>
      total + (entry.rule?.chain === "faults" ? entry.rule.expr.reduce((n, expression) => n + (expression.counter?.packets ?? 0), 0) : 0), 0);
    return {
      firewall, faultDrops,
      queue: JSON.parse(this.exec(this.router(index), "tc", ["-j", "-s", "qdisc", "show"])),
    };
  }

  async close(): Promise<{ namespacesRemoved: boolean; hostNetworkUnchanged: boolean; linksRemoved: boolean }> {
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
        for (let attempt = 0; attempt < 20 && command("ip", ["netns", "pids", namespace]); attempt++) await delay(25);
        if (command("ip", ["netns", "pids", namespace])) failures.push(`${namespace}:processes`);
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
      linksRemoved: !JSON.parse(command("ip", ["-j", "link", "show"])).some((link: { ifname: string }) => this.pendingLinks.has(link.ifname)),
      hostNetworkUnchanged: command("ip", ["-j", "route", "show", "table", "all"]) === this.originalRoutes &&
        command("ip", ["-6", "-j", "route", "show", "table", "all"]) === this.originalRoutes6 &&
        command("nft", ["-s", "list", "ruleset"]) === this.originalRules,
    };
  }
}
