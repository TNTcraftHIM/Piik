package sfu

// Ported from src/server/livekit-token.ts. The AccessToken of
// livekit-server-sdk is replaced by the HS256 JWT it produced; the claim set is
// the one recorded in evidence/livekit.md section 2.

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"time"

	"github.com/TNTcraftHIM/Screener/internal/server/protocol"
)

const (
	// tokenTTLSeconds and serviceTokenTTLSeconds are the AccessToken `ttl`
	// values of src/server/livekit-token.ts and the SDK's ServiceBase: a
	// participant token only has to survive the join it was issued for, and a
	// service token only the one RoomService call it authorises.
	tokenTTLSeconds        = 5 * 60
	serviceTokenTTLSeconds = 10 * 60
	// minAPISecretBytes is the TypeScript Buffer.byteLength(secret) >= 32 guard,
	// which is len() in Go because both count UTF-8 bytes.
	minAPISecretBytes = 32
	// TrackSource enum strings, from livekit-server-sdk grants.ts
	// trackSourceToString().
	trackSourceScreenShare      = "screen_share"
	trackSourceScreenShareAudio = "screen_share_audio"
)

// videoGrant is the subset of the SDK's VideoGrant this server sets. The four
// capability flags are *bool because absent and false differ to LiveKit:
// GetCanPublish() answers true for an absent flag, so a viewer's
// "canPublish": false must be emitted, not omitted.
type videoGrant struct {
	RoomCreate           bool     `json:"roomCreate,omitempty"`
	RoomJoin             bool     `json:"roomJoin,omitempty"`
	RoomList             bool     `json:"roomList,omitempty"`
	RoomAdmin            bool     `json:"roomAdmin,omitempty"`
	Room                 string   `json:"room,omitempty"`
	CanPublish           *bool    `json:"canPublish,omitempty"`
	CanPublishSources    []string `json:"canPublishSources,omitempty"`
	CanSubscribe         *bool    `json:"canSubscribe,omitempty"`
	CanPublishData       *bool    `json:"canPublishData,omitempty"`
	CanUpdateOwnMetadata *bool    `json:"canUpdateOwnMetadata,omitempty"`
}

// tokenClaims is the registered claim set jose emitted for AccessToken: no
// `iat`, no duplicate `identity`, and no `sub` on a service token.
type tokenClaims struct {
	Iss   string     `json:"iss"`
	Sub   string     `json:"sub,omitempty"`
	Nbf   int64      `json:"nbf"`
	Exp   int64      `json:"exp"`
	Video videoGrant `json:"video"`
}

// signer holds the API credentials shared by the participant token issuer and
// the RoomService client.
type signer struct {
	apiKey    string
	apiSecret []byte
}

func newSigner(apiKey string, apiSecret string) signer {
	return signer{apiKey: apiKey, apiSecret: []byte(apiSecret)}
}

// sign emits the compact JWS. jose's SignJWT with {alg:"HS256"} writes exactly
// {"alg":"HS256"} as the protected header: no typ, no kid.
func (s signer) sign(claims tokenClaims) (string, error) {
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	header := []byte(`{"alg":"HS256"}`)
	encoding := base64.RawURLEncoding
	signing := make([]byte, 0,
		encoding.EncodedLen(len(header))+1+encoding.EncodedLen(len(payload)))
	signing = encoding.AppendEncode(signing, header)
	signing = append(signing, '.')
	signing = encoding.AppendEncode(signing, payload)
	mac := hmac.New(sha256.New, s.apiSecret)
	mac.Write(signing)
	token := append(signing, '.')
	token = encoding.AppendEncode(token, mac.Sum(nil))
	return string(token), nil
}

// serviceToken reproduces ServiceBase.authHeader: a 10 minute admin token
// carrying one video grant and no subject.
func (s signer) serviceToken(grant videoGrant) (string, error) {
	notBefore := time.Now().Unix()
	return s.sign(tokenClaims{
		Iss:   s.apiKey,
		Nbf:   notBefore,
		Exp:   notBefore + serviceTokenTTLSeconds,
		Video: grant,
	})
}

// TokenRequest is SfuTokenRequest.
type TokenRequest struct {
	RoomID                string
	Role                  protocol.Role
	PeerID                string
	ShareGeneration       string
	PublicationGeneration string
}

// TokenIssuer is SfuTokenIssuer. Issuing is local HMAC work, so unlike
// RoomControl it takes no context.
type TokenIssuer interface {
	IssueToken(request TokenRequest) (string, error)
}

// LiveKitTokenIssuerOptions is LiveKitTokenIssuerOptions.
type LiveKitTokenIssuerOptions struct {
	APIKey            string
	APISecret         string
	MaxViewersPerRoom int
}

// LiveKitTokenIssuer is LiveKitTokenIssuer.
type LiveKitTokenIssuer struct {
	signer signer
}

var _ TokenIssuer = (*LiveKitTokenIssuer)(nil)

// NewLiveKitTokenIssuer mirrors the LiveKitTokenIssuer constructor.
func NewLiveKitTokenIssuer(options LiveKitTokenIssuerOptions) (*LiveKitTokenIssuer, error) {
	if options.APIKey == "" || len(options.APISecret) < minAPISecretBytes {
		return nil, errors.New("LiveKit API credentials are invalid")
	}
	if err := validateViewerLimit(options.MaxViewersPerRoom); err != nil {
		return nil, err
	}
	return &LiveKitTokenIssuer{signer: newSigner(options.APIKey, options.APISecret)}, nil
}

// IssueToken ports issueToken.
func (issuer *LiveKitTokenIssuer) IssueToken(request TokenRequest) (string, error) {
	if !roomIDPattern.MatchString(request.RoomID) {
		return "", errors.New("LiveKit room ID is invalid")
	}
	if !protocol.ValidOpaqueID(request.PeerID) ||
		!protocol.ValidOpaqueID(request.ShareGeneration) ||
		!protocol.ValidOpaqueID(request.PublicationGeneration) {
		return "", errors.New("LiveKit participant identity is invalid")
	}

	isHost := request.Role == protocol.RoleHost
	// The validation above is a superset of managedRoomName's, so this cannot
	// fail; the TypeScript relied on the same ordering.
	room := ManagedRoomName(ResourceFence{
		RoomID:                request.RoomID,
		ShareGeneration:       request.ShareGeneration,
		PublicationGeneration: request.PublicationGeneration,
	})
	identity := "host"
	if !isHost {
		identity = "viewer:" + request.PeerID
	}
	grant := videoGrant{
		RoomJoin:             true,
		Room:                 room,
		CanPublish:           boolPointer(isHost),
		CanSubscribe:         boolPointer(!isHost),
		CanPublishData:       boolPointer(false),
		CanUpdateOwnMetadata: boolPointer(false),
	}
	if isHost {
		grant.CanPublishSources = []string{
			trackSourceScreenShare,
			trackSourceScreenShareAudio,
		}
	}
	// One clock read: jose called new Date() once per setter, so across a
	// second boundary its exp - nbf could be 299. Here it is always 300.
	notBefore := time.Now().Unix()
	return issuer.signer.sign(tokenClaims{
		Iss:   issuer.signer.apiKey,
		Sub:   identity,
		Nbf:   notBefore,
		Exp:   notBefore + tokenTTLSeconds,
		Video: grant,
	})
}

// validateViewerLimit is the shared viewer-limit guard of both LiveKit
// constructors. Number.isSafeInteger is implicit in Go's int.
func validateViewerLimit(maxViewersPerRoom int) error {
	if maxViewersPerRoom < 1 || maxViewersPerRoom > protocol.MaxViewersPerRoomLimit {
		return errors.New("LiveKit viewer limit is invalid")
	}
	return nil
}

func boolPointer(value bool) *bool { return &value }
