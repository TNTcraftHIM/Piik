import Foundation

precondition(SiteAddress.url(" https://EXAMPLE.com/my room?q=hello world#v=synthetic ")?.absoluteString
    == "https://example.com/my%20room?q=hello%20world#v=synthetic")
precondition(SiteAddress.url("example.com:8443/join#v=synthetic")?.absoluteString
    == "https://example.com:8443/join#v=synthetic")
precondition(SiteAddress.url("example.com/next?to=https://other.example")?.host == "example.com")
precondition(SiteAddress.url("https://bad host.example/join") == nil)
precondition(SiteAddress.url("http://example.com") == nil)
precondition(SiteAddress.url("https://user:password@example.com") == nil)
print("Actual SiteAddress HTTPS navigation/invitation checks passed")
