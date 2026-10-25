package bridge

import (
	"encoding/json"
	"errors"

	"github.com/TNTcraftHIM/Piik/internal/app/loopback"
	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
)

type encoderCapability struct {
	Name        string `json:"name"`
	Codec       string `json:"codec"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`
	Pixels      int    `json:"pixels"`
	Macroblocks int    `json:"macroblocks"`
	FPS         int    `json:"fps"`
	Bitrate     int    `json:"bitrate"`
}

type encoderCapabilities struct {
	Platform    string              `json:"platform"`
	Provider    string              `json:"provider"`
	SystemAudio bool                `json:"systemAudio"`
	Encoders    []encoderCapability `json:"encoders"`
}

func decodeEncoderCapabilities(value string) (encoderCapabilities, error) {
	var catalog encoderCapabilities
	if err := json.Unmarshal([]byte(value), &catalog); err != nil {
		return catalog, err
	}
	if catalog.Platform == "" || catalog.Provider == "" {
		return encoderCapabilities{}, errors.New("mobile capture platform is invalid")
	}
	for _, encoder := range catalog.Encoders {
		if encoder.Name == "" || (encoder.Codec != "h264" && encoder.Codec != "vp8") || encoder.Width < 2 || encoder.Height < 2 || encoder.Pixels < 4 || encoder.Macroblocks < 1 || encoder.FPS < 1 || encoder.Bitrate < 1 {
			return encoderCapabilities{}, errors.New("mobile encoder capabilities are invalid")
		}
	}
	return catalog, nil
}

func (catalog encoderCapabilities) nativeCapabilities() nativecapture.Capabilities {
	result := nativecapture.Capabilities{Protocol: 7, Platform: catalog.Platform, VideoCapture: len(catalog.Encoders) > 0, SystemAudio: catalog.SystemAudio && len(catalog.Encoders) > 0, Adapters: []nativecapture.Adapter{}}
	if !result.VideoCapture {
		return result
	}
	adapter := nativecapture.Adapter{Index: 0, Name: catalog.Provider, Identity: catalog.Platform, HardwareH264: []nativecapture.Encoder{}}
	for _, encoder := range catalog.Encoders {
		if encoder.Codec == "vp8" {
			result.SoftwareVP8 = true
		} else {
			adapter.HardwareH264 = append(adapter.HardwareH264, nativecapture.Encoder{Index: uint32(len(adapter.HardwareH264)), Name: encoder.Name, Identity: encoder.Name})
		}
	}
	result.Adapters = append(result.Adapters, adapter)
	return result
}

func (catalog encoderCapabilities) mediaCapabilities() loopback.NativeMediaCapabilities {
	native := catalog.nativeCapabilities()
	result := loopback.NativeMediaCapabilities{Video: native.VideoCapture, SoftwareVP8: native.SoftwareVP8, SystemAudio: native.SystemAudio, ShareVolume: native.SystemAudio, ReceiverReuse: true, MaxRelayChildren: protocol.MaxViewersPerRoomLimit, MaxAudioBitrate: 320000}
	result.HardwareH264 = len(native.Adapters) > 0 && len(native.Adapters[0].HardwareH264) > 0
	// Keep the preferred encoder's existing UI envelope. Each selected encoder still
	// validates the actual size/rate during preparation.
	if len(catalog.Encoders) > 0 {
		first := catalog.Encoders[0]
		result.MaxVideoResolution = protocol.QualityResolution{Width: protocol.Int(first.Width), Height: protocol.Int(first.Height)}
		result.MaxVideoPixels = first.Pixels
		result.MaxVideoMacroblocksPerSecond = first.Macroblocks
		result.MaxVideoFramerate = first.FPS
		result.MaxVideoBitrate = first.Bitrate
	}
	return result
}
