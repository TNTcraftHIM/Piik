export const NAT_TRAVERSAL_PATHS = [
  "unknown",
  "ordinary",
  "predicted",
] as const;

export type NatTraversalPath = (typeof NAT_TRAVERSAL_PATHS)[number];
export type CandidateSignalOrigin = "end" | "ordinary" | "predicted";

export function isPredictedCandidateFoundation(
  foundation: string | null,
): boolean {
  return foundation !== null && /^s[pm]\d+$/.test(foundation);
}

export function candidateSignalOrigin(
  candidate: string | null,
): CandidateSignalOrigin {
  if (candidate === null || candidate.trim() === "") {
    return "end";
  }
  return /^candidate:s[pm]\d+\s/i.test(candidate)
    ? "predicted"
    : "ordinary";
}
