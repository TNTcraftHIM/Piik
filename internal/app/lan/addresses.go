package lan

import (
	"errors"
	"fmt"
	"net"
	"sort"
	"strings"
)

type Address struct {
	Address string `json:"address"`
	Name    string `json:"name"`
}

// List describes invitation addresses. It does not choose or constrain the
// media interfaces, which remain owned by ICE and the operating system.
func List() ([]Address, error) {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil, fmt.Errorf("list network interfaces: %w", err)
	}
	unique := make(map[string]Address)
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
			value := ip.String()
			if previous, exists := unique[value]; !exists || networkInterface.Name < previous.Name {
				unique[value] = Address{Address: value, Name: networkInterface.Name}
			}
		}
	}
	result := make([]Address, 0, len(unique))
	for _, address := range unique {
		result = append(result, address)
	}
	sort.Slice(result, func(left, right int) bool { return result[left].Address < result[right].Address })
	if len(result) == 0 {
		return nil, errors.New("no active LAN IPv4 address is available")
	}
	return result, nil
}

func Addresses() ([]string, error) {
	addresses, err := List()
	if err != nil {
		return nil, err
	}
	result := make([]string, 0, len(addresses))
	for _, address := range addresses {
		result = append(result, address.Address)
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
	if len(addresses) == 0 {
		return "", errors.New("no active LAN IPv4 address is available")
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
	return "", fmt.Errorf("multiple LAN addresses are active; restart with --local --lan-address <address>, choosing from: %s; public-link mode does not require this selection", strings.Join(addresses, ", "))
}
