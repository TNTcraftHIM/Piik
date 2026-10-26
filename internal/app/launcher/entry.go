package launcher

import (
	"net/url"
	"strconv"

	"github.com/TNTcraftHIM/Piik/internal/app/loopback"
)

// EntryURL selects the App runtime without carrying authority in the query.
func EntryURL(raw string, controlPort int) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	fragment, err := url.ParseQuery(parsed.EscapedFragment())
	if err != nil {
		return raw
	}
	fragment.Set("piik-client", "1")
	query := parsed.Query()
	if controlPort >= loopback.DefaultPortStart && controlPort <= loopback.DefaultPortEnd {
		query.Set("piik-client-port", strconv.Itoa(controlPort))
	}
	parsed.RawQuery = query.Encode()
	parsed.Fragment, parsed.RawFragment = "", ""
	return parsed.String() + "#" + fragment.Encode()
}

// LocalEntryURL passes the local access choice only through the consumed Host fragment.
func LocalEntryURL(raw, password string, controlPort int) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	fragment, err := url.ParseQuery(parsed.EscapedFragment())
	if err != nil {
		return raw
	}
	fragment.Del("client-access")
	if password != "" {
		fragment.Set("client-access", password)
	}
	parsed.Fragment, parsed.RawFragment = "", ""
	return EntryURL(parsed.String()+"#"+fragment.Encode(), controlPort)
}
