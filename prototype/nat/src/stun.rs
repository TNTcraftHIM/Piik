//! The Binding request and the mapped address of its answer (RFC 8489, sections 5, 14.1 and 14.2).
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};

const BINDING_REQUEST: u16 = 0x0001;
const BINDING_SUCCESS: u16 = 0x0101;
const MAGIC_COOKIE: [u8; 4] = [0x21, 0x12, 0xa4, 0x42];
const MAPPED_ADDRESS: u16 = 0x0001;
const XOR_MAPPED_ADDRESS: u16 = 0x0020;

/// A Binding request without attributes.
pub fn request(transaction: [u8; 12]) -> [u8; 20] {
    let mut packet = [0; 20];
    packet[..2].copy_from_slice(&BINDING_REQUEST.to_be_bytes());
    packet[4..8].copy_from_slice(&MAGIC_COOKIE);
    packet[8..].copy_from_slice(&transaction);
    packet
}

/// The address a Binding success reports for `transaction`, or `None` for any other packet.
pub fn mapped(packet: &[u8], transaction: [u8; 12]) -> Option<SocketAddr> {
    let header = packet.get(..20)?;
    if header[..2] != BINDING_SUCCESS.to_be_bytes() || header[4..8] != MAGIC_COOKIE || header[8..] != transaction {
        return None;
    }
    let mut attributes = packet.get(20..20 + usize::from(u16::from_be_bytes([header[2], header[3]])))?;
    let mut plain = None;
    while let [kind_high, kind_low, length_high, length_low, rest @ ..] = attributes {
        let length = usize::from(u16::from_be_bytes([*length_high, *length_low]));
        let value = rest.get(..length)?;
        match u16::from_be_bytes([*kind_high, *kind_low]) {
            XOR_MAPPED_ADDRESS => return address(value, Some(&header[4..20])),
            MAPPED_ADDRESS => plain = address(value, None),
            _ => {}
        }
        // Attributes are padded to four bytes.
        attributes = rest.get(length.div_ceil(4) * 4..).unwrap_or(&[]);
    }
    plain
}

/// A MAPPED-ADDRESS value, or an XOR-MAPPED-ADDRESS value with the cookie and transaction that mask it.
fn address(value: &[u8], mask: Option<&[u8]>) -> Option<SocketAddr> {
    let mask = mask.unwrap_or(&[0; 16]);
    let port = u16::from_be_bytes([*value.get(2)? ^ mask[0], *value.get(3)? ^ mask[1]]);
    match (value[1], value.len()) {
        (0x01, 8) => {
            let ip = Ipv4Addr::new(value[4] ^ mask[0], value[5] ^ mask[1], value[6] ^ mask[2], value[7] ^ mask[3]);
            Some(SocketAddr::new(ip.into(), port))
        }
        (0x02, 20) => {
            let mut ip = [0; 16];
            for (index, byte) in ip.iter_mut().enumerate() {
                *byte = value[4 + index] ^ mask[index];
            }
            Some(SocketAddr::new(Ipv6Addr::from(ip).into(), port))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TRANSACTION: [u8; 12] = [0xb7, 0xe7, 0xa7, 0x01, 0xbc, 0x34, 0xd6, 0x86, 0xfa, 0x87, 0xdf, 0xae];

    fn success(attributes: &[u8]) -> Vec<u8> {
        let mut packet = Vec::from(BINDING_SUCCESS.to_be_bytes());
        packet.extend((attributes.len() as u16).to_be_bytes());
        packet.extend(MAGIC_COOKIE);
        packet.extend(TRANSACTION);
        packet.extend(attributes);
        packet
    }

    #[test]
    fn a_request_is_twenty_bytes_with_the_cookie_and_the_transaction() {
        let packet = request(TRANSACTION);
        assert_eq!(packet[..8], [0, 1, 0, 0, 0x21, 0x12, 0xa4, 0x42]);
        assert_eq!(packet[8..], TRANSACTION);
    }

    #[test]
    fn reads_the_masked_address_of_rfc_5769() {
        // RFC 5769 section 2.2: 192.0.2.1:32853, after a SOFTWARE attribute that is padded.
        let mut attributes = vec![0x80, 0x22, 0x00, 0x0b];
        attributes.extend(b"test vector ");
        attributes.extend([0x00, 0x20, 0x00, 0x08, 0x00, 0x01, 0xa1, 0x47, 0xe1, 0x12, 0xa6, 0x43]);
        assert_eq!(mapped(&success(&attributes), TRANSACTION), Some("192.0.2.1:32853".parse().unwrap()));
    }

    #[test]
    fn reads_the_masked_ipv6_address_of_rfc_5769() {
        // RFC 5769 section 2.3: [2001:db8:1234:5678:11:2233:4455:6677]:32853.
        let attributes = [
            0x00, 0x20, 0x00, 0x14, 0x00, 0x02, 0xa1, 0x47, 0x01, 0x13, 0xa9, 0xfa, 0xa5, 0xd3, 0xf1, 0x79, 0xbc, 0x25,
            0xf4, 0xb5, 0xbe, 0xd2, 0xb9, 0xd9,
        ];
        assert_eq!(
            mapped(&success(&attributes), TRANSACTION),
            Some("[2001:db8:1234:5678:11:2233:4455:6677]:32853".parse().unwrap())
        );
    }

    #[test]
    fn falls_back_to_the_plain_address_and_refuses_other_packets() {
        let plain = [0x00, 0x01, 0x00, 0x08, 0x00, 0x01, 0x80, 0x55, 192, 0, 2, 1];
        assert_eq!(mapped(&success(&plain), TRANSACTION), Some("192.0.2.1:32853".parse().unwrap()));
        assert_eq!(mapped(&success(&plain), [0; 12]), None);
        assert_eq!(mapped(&request(TRANSACTION), TRANSACTION), None);
        assert_eq!(mapped(&success(&plain)[..25], TRANSACTION), None);
    }
}
