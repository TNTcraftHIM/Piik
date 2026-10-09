package nativehost

import (
	"github.com/TNTcraftHIM/Piik/internal/app/nativeaudio"
	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
)

type QualityProfile struct {
	Video        nativecapture.VideoProfile
	AudioBitrate int
}

func (profile QualityProfile) Valid() bool {
	return profile.Video.Valid() &&
		profile.AudioBitrate >= nativeaudio.MinBitrate && profile.AudioBitrate <= nativeaudio.MaxSendBitrate
}
