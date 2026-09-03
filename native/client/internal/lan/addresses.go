package lan

import (
	"errors"
	"fmt"
	"net"
	"sort"
	"strings"
)

func Addresses() ([]string, error) {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil, fmt.Errorf("list network interfaces: %w", err)
	}
	unique := make(map[string]struct{})
	for _, networkInterface := range interfaces {
		if networkInterface.Flags&net.FlagUp == 0 || networkInterface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addresses, addressErr := networkInterface.Addrs()
		if addressErr != nil {
			continue
		}
		for _, address := range addresses {
			ip, _, parseErr := net.ParseCIDR(address.String())
			if parseErr != nil || ip.To4() == nil || ip.IsLoopback() || ip.IsUnspecified() {
				continue
			}
			unique[ip.String()] = struct{}{}
		}
	}
	result := make([]string, 0, len(unique))
	for address := range unique {
		result = append(result, address)
	}
	sort.Strings(result)
	if len(result) == 0 {
		return nil, errors.New("no active LAN IPv4 address is available")
	}
	return result, nil
}

func Select(addresses []string, preferred string) (string, error) {
	preferred = strings.TrimSpace(preferred)
	if preferred != "" {
		for _, address := range addresses {
			if address == preferred {
				return preferred, nil
			}
		}
		return "", errors.New("selected LAN address is not active")
	}
	if len(addresses) == 1 {
		return addresses[0], nil
	}
	private := make([]string, 0, len(addresses))
	for _, address := range addresses {
		if ip := net.ParseIP(address); ip != nil && ip.IsPrivate() {
			private = append(private, address)
		}
	}
	if len(private) == 1 {
		return private[0], nil
	}
	return "", fmt.Errorf("multiple LAN addresses are active; select one of: %s", strings.Join(addresses, ", "))
}
