import type {
  CodecTransitionGeneration,
  ResumeAttempt,
  ServerMessage,
} from "../../shared/protocol";
import { setMediaPaused } from "./quality";

type PauseSharingSourceMessage = Extract<
  ServerMessage,
  { type: "pause-sharing-source" }
>;

interface AuthoritativeHostPauseInput {
  message: PauseSharingSourceMessage;
  currentShareGeneration: string | null;
  activeResumeAttempt: ResumeAttempt | null;
  activeCodecGeneration: CodecTransitionGeneration | null;
  stream: MediaStream | null;
  pauseSfuRoute: () => void;
  markHostPaused: () => void;
}

export interface AuthoritativeHostPauseResult {
  localCodecContextMatches: boolean;
}

export function applyAuthoritativeHostPause({
  message,
  currentShareGeneration,
  activeResumeAttempt,
  activeCodecGeneration,
  stream,
  pauseSfuRoute,
  markHostPaused,
}: AuthoritativeHostPauseInput): AuthoritativeHostPauseResult | null {
  if (message.shareGeneration !== currentShareGeneration) {
    return null;
  }

  if (stream) {
    setMediaPaused(stream, true);
  }
  pauseSfuRoute();
  markHostPaused();

  return {
    localCodecContextMatches:
      (message.resumeAttempt === null ||
        message.resumeAttempt === activeResumeAttempt) &&
      (message.codecGeneration === null ||
        message.codecGeneration === activeCodecGeneration),
  };
}
