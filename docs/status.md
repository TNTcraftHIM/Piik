# Current Status

Last updated: 2026-08-18

## Phase

Discovery is complete enough to begin technical design and a measured WebRTC proof of concept. No application code or production infrastructure exists yet.

## Established Baseline

- Product scope: private game sharing for one broadcaster and one to three normal viewers, with a measured fourth-viewer decision.
- Client shape: Windows Chrome/Edge sharing MVP; responsive desktop and mobile Web viewer; Electron/native sender only after measurements justify it.
- Media topology: independent WebRTC P2P connections with STUN discovery and mandatory authenticated TURN/UDP, TURN/TCP, and TURN/TLS fallback.
- Large public broadcasts are out of scope and should use OBS/Twitch-class services.
- Research, requirements, current memory, agent instructions, and repository governance are stored in Git.

## Next Milestone

Write the technical design and build a narrow prototype that validates:

- screen and game-audio capture behavior;
- one broadcaster with three heterogeneous viewers;
- direct and mixed direct/TURN rooms;
- mobile browser playback and network handoff;
- actual codec implementation, encode load, bitrate, frame rate, and glass-to-glass latency.

## Blocking Decisions

- Three versus four as the hard MVP viewer limit.
- Whole-system versus selected-game audio for the first release.
- Initial deployment region and network test cohort.
- Project license and intended distribution model.
