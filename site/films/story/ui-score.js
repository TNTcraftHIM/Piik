// Positions within the staged product interface, in seconds.
export const BEAT = .5;
export const UI_CUES = {
  share: 1.5 * BEAT, source: 4 * BEAT, live: 4.5 * BEAT,
  copy: 1.5 * BEAT, chat: 3 * BEAT, paste: 4 * BEAT, send: 6 * BEAT, viewer: 8 * BEAT,
  chatOpen: 2,
  voice: { open: .75, hostMic: 1.5, viewer: 2.5, join: 3.25, viewerMic: 4 },
  control: { open: 1.5, request: 3, allow: 5, approved: 5.125 },
};
