import {
  codeEntryPolicySchema,
  viewerPasswordSchema,
  type CodeEntryPolicy,
} from "../../shared/protocol";

const CREATION_PROFILE_STORAGE_KEY = "screener:host-creation-profile:v1";

export interface HostCreationProfile {
  codeEntryPolicy: CodeEntryPolicy;
  roomPassword: string | null;
}

export function readCreationProfile(): HostCreationProfile {
  try {
    const stored = window.localStorage.getItem(CREATION_PROFILE_STORAGE_KEY);
    if (!stored) {
      return { codeEntryPolicy: "open", roomPassword: null };
    }
    const parsed = JSON.parse(stored) as {
      codeEntryPolicy?: unknown;
      roomPassword?: unknown;
    };
    if (
      !codeEntryPolicySchema.safeParse(parsed.codeEntryPolicy).success ||
      (parsed.codeEntryPolicy === "password" &&
        (parsed.roomPassword === null || parsed.roomPassword === undefined)) ||
      (parsed.roomPassword !== null &&
        parsed.roomPassword !== undefined &&
        !viewerPasswordSchema.safeParse(parsed.roomPassword).success)
    ) {
      window.localStorage.removeItem(CREATION_PROFILE_STORAGE_KEY);
      return { codeEntryPolicy: "open", roomPassword: null };
    }
    return {
      codeEntryPolicy: parsed.codeEntryPolicy as CodeEntryPolicy,
      roomPassword:
        parsed.roomPassword === null || parsed.roomPassword === undefined
          ? null
          : (parsed.roomPassword as string),
    };
  } catch {
    return { codeEntryPolicy: "open", roomPassword: null };
  }
}

export function saveCreationProfile(profile: HostCreationProfile): void {
  if (
    !codeEntryPolicySchema.safeParse(profile.codeEntryPolicy).success ||
    (profile.roomPassword !== null &&
      !viewerPasswordSchema.safeParse(profile.roomPassword).success) ||
    (profile.codeEntryPolicy === "password" && profile.roomPassword === null)
  ) {
    return;
  }
  try {
    window.localStorage.setItem(
      CREATION_PROFILE_STORAGE_KEY,
      JSON.stringify(profile),
    );
  } catch {
    // The current room can still use the operator's in-memory choices.
  }
}
