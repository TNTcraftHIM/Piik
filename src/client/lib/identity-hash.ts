/** Stable decorative choices only; not a cryptographic or authority identifier. */
export function identityHash(identity: string): number {
  let seed = 2166136261;
  for (const char of identity) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  return seed >>> 0;
}
