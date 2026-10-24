package launcher

import "net/url"

// LocalEntryURL passes the local access choice only through the consumed Host fragment.
func LocalEntryURL(raw, password string) string {
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
	fragment.Set("piik-client", "1")
	parsed.Fragment, parsed.RawFragment = "", ""
	return parsed.String() + "#" + fragment.Encode()
}
