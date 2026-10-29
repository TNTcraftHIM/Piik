package config

import (
	"errors"

	serverconfig "github.com/P4-aaaul/Silip/internal/server/config"
	"github.com/P4-aaaul/Silip/internal/server/protocol"
)

// PublicSTUNURLs supplies the shared App public-link discovery policy. An explicit
// override replaces every destination; fewer than three disable the survey pair.
func PublicSTUNURLs(override string) (stunURLs []string, prediction []string, err error) {
	stunURLs, err = serverconfig.ParseSTUNURLs(override, "SILIP_STUN_URLS")
	if err != nil {
		return nil, nil, err
	}
	if len(stunURLs) == 0 {
		stunURLs = []string{"stun:stun.cloudflare.com:3478", "stun:stun.miwifi.com:3478", "stun:stun.chat.bilibili.com:3478"}
	}
	if len(stunURLs) >= 3 {
		if len(stunURLs) > protocol.MaxIceServerURLs-protocol.MaxNatPredictionAuxiliaryStunURLs {
			return nil, nil, errors.New("SILIP_STUN_URLS must contain at most 6 URLs")
		}
		prediction = stunURLs[1:3]
	}
	return stunURLs, prediction, nil
}
