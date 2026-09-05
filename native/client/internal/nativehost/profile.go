package nativehost

import "github.com/TNTcraftHIM/Screener/native/client/internal/nativecapture"

type QualityProfile struct {
	Video        nativecapture.VideoProfile
	AudioBitrate int
}

func (profile QualityProfile) Valid() bool {
	return profile.Video.Valid() &&
		(profile.AudioBitrate == 64_000 ||
			profile.AudioBitrate == 128_000 ||
			profile.AudioBitrate == 192_000)
}
