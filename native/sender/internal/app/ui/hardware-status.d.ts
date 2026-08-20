export declare const HARDWARE_PREFERENCE: "prefer-hardware";

export declare const HARDWARE_STATUS: Readonly<{
  UNREQUESTED: "unrequested";
  PREFERENCE_ACCEPTED: "preference-accepted";
  FALLBACK: "fallback";
  UNSUPPORTED: "unsupported";
  UNVERIFIED: "hardware-unverified";
}>;

export declare function retainsHardwarePreference(support: unknown): boolean;
