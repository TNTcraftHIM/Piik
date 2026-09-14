// Resolution controls scanline density; frame rate adds motion to that same image.
export function QualityTileGlyph({ resolution, framerate }: { resolution: string; framerate: number }) {
  const lines = resolution === "720p" ? 2 : 3;
  return <svg width={28} height={38} viewBox="0 0 28 38" fill="none" aria-hidden="true">
    <rect x={2} y={3} width={24} height={26} rx={4} stroke="currentColor" strokeWidth={2.2} />
    {Array.from({ length: lines }, (_, index) => <path key={index}
      d={`M6 ${10 + index * 5}h16`} stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />)}
    {framerate > 30 ? <path d="M7 33h4m3 0h7m-3-2 3 2-3 2"
      stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" /> : null}
  </svg>;
}
