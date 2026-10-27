/** The shared couch silhouette; callers own seating and participant roles. */
export function CouchBench({ width }: { width: number }) {
  return <svg viewBox={`0 0 ${width} 108`} aria-hidden="true">
    <path d={`M38 98v7m${width - 76} -7v7`} stroke="var(--frame)" strokeWidth="6" strokeLinecap="round" />
    <rect x="18" y="32" width={width - 36} height="65" rx="24" fill="var(--couch-dark)" />
    <rect x="28" y="24" width={width - 56} height="60" rx="23" fill="var(--couch)" />
    <rect x="28" y="76" width={width - 56} height="24" rx="10" fill="var(--couch)" />
    <path d={`M${width / 3} 79v16m${width / 3} -16v16`} stroke="var(--couch-dark)" strokeWidth="2" strokeLinecap="round" />
    <rect x="14" y="59" width="25" height="39" rx="12" fill="var(--couch-dark)" />
    <rect x={width - 39} y="59" width="25" height="39" rx="12" fill="var(--couch-dark)" />
  </svg>;
}
