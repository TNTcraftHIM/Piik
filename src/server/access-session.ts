import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60;
const COOKIE_VERSION = "v1";

export interface HostAdmissionOptions {
  password?: string;
  secure: boolean;
  now?: () => number;
  ttlSeconds?: number;
}

export class HostAdmission {
  private readonly now: () => number;
  private readonly ttlSeconds: number;

  constructor(private readonly options: HostAdmissionOptions) {
    this.now = options.now ?? Date.now;
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
    if (!Number.isSafeInteger(this.ttlSeconds) || this.ttlSeconds <= 0) {
      throw new Error("Access session TTL must be a positive integer");
    }
  }

  get required(): boolean {
    return Boolean(this.options.password);
  }

  passwordMatches(value: string | undefined): boolean {
    return !this.required || Boolean(value && secretMatches(value, this.options.password!));
  }

  isAuthenticated(cookieHeader: string | undefined): boolean {
    if (!this.required) {
      return true;
    }
    const value = readCookie(cookieHeader, this.cookieName);
    if (!value) {
      return false;
    }
    const [version, expiresText, signature, ...extra] = value.split(".");
    if (
      version !== COOKIE_VERSION ||
      extra.length > 0 ||
      !/^\d+$/.test(expiresText ?? "") ||
      !/^[A-Za-z0-9_-]{43}$/.test(signature ?? "")
    ) {
      return false;
    }
    const expiresAt = Number(expiresText);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(this.now() / 1_000)) {
      return false;
    }
    return secretMatches(signature!, this.sign(`${version}.${expiresText}`));
  }

  createCookie(): string | undefined {
    if (!this.required) {
      return undefined;
    }
    const expiresAt = Math.floor(this.now() / 1_000) + this.ttlSeconds;
    const payload = `${COOKIE_VERSION}.${expiresAt}`;
    const value = `${payload}.${this.sign(payload)}`;
    const attributes = [
      `${this.cookieName}=${value}`,
      "Path=/",
      `Max-Age=${this.ttlSeconds}`,
      "HttpOnly",
      "SameSite=Strict",
    ];
    if (this.options.secure) {
      attributes.push("Secure");
    }
    return attributes.join("; ");
  }

  private get cookieName(): string {
    return this.options.secure
      ? "__Host-screener-host-admission"
      : "screener-host-admission";
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.options.password!).update(payload).digest("base64url");
  }
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator !== -1 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim() || undefined;
    }
  }
  return undefined;
}

function secretMatches(actual: string, expected: string): boolean {
  const actualDigest = createHash("sha256").update(actual).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}
