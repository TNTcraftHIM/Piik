//! The Binding request and the mapped address of its answer (RFC 8489, sections 5, 14.1 and 14.2),
//! and the request that asks a server to answer from elsewhere (RFC 5780, sections 7.2 and 7.4).
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV4};

const BINDING_REQUEST: u16 = 0x0001;
const BINDING_SUCCESS: u16 = 0x0101;
const MAGIC_COOKIE: [u8; 4] = [0x21, 0x12, 0xa4, 0x42];
const MAPPED_ADDRESS: u16 = 0x0001;
const XOR_MAPPED_ADDRESS: u16 = 0x0020;
const CHANGE_REQUEST: u16 = 0x0003;
/// The server's other address and port: CHANGED-ADDRESS in RFC 3489, OTHER-ADDRESS in RFC 5780.
const CHANGED_ADDRESS: u16 = 0x0005;
const OTHER_ADDRESS: u16 = 0x802c;

/// A Binding request without attributes.
pub fn request(transaction: [u8; 12]) -> [u8; 20] {
    let mut packet = [0; 20];
    packet[..2].copy_from_slice(&BINDING_REQUEST.to_be_bytes());
    packet[4..8].copy_from_slice(&MAGIC_COOKIE);
    packet[8..].copy_from_slice(&transaction);
    packet
}

/// A Binding request that asks the server to answer from its other address, its other port, or
/// both. A NAT that lets such an answer in does not filter by where a packet comes from.
pub fn request_from_elsewhere(transaction: [u8; 12], address: bool, port: bool) -> [u8; 28] {
    let mut packet = [0; 28];
    packet[..20].copy_from_slice(&request(transaction));
    packet[3] = 8;
    packet[20..24].copy_from_slice(&[(CHANGE_REQUEST >> 8) as u8, CHANGE_REQUEST as u8, 0, 4]);
    packet[27] = u8::from(address) << 2 | u8::from(port) << 1;
    packet
}

/// What a Binding request asks for, as a server reads it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Asked {
    pub transaction: [u8; 12],
    pub from_other_address: bool,
    pub from_other_port: bool,
}

/// A Binding request, or `None` for any other packet.
pub fn asked(packet: &[u8]) -> Option<Asked> {
    let header = packet.get(..20)?;
    if header[..2] != BINDING_REQUEST.to_be_bytes() || header[4..8] != MAGIC_COOKIE {
        return None;
    }
    let mut attributes = &packet[20..];
    if attributes.len() != usize::from(u16::from_be_bytes([header[2], header[3]])) {
        return None;
    }
    let mut flags = 0;
    while !attributes.is_empty() {
        let [kind_high, kind_low, length_high, length_low, rest @ ..] = attributes else { return None };
        let length = usize::from(u16::from_be_bytes([*length_high, *length_low]));
        let value = rest.get(..length)?;
        if u16::from_be_bytes([*kind_high, *kind_low]) == CHANGE_REQUEST {
            flags = *value.get(3)?;
        }
        attributes = rest.get(length.div_ceil(4) * 4..)?;
    }
    Some(Asked { transaction: header[8..].try_into().ok()?, from_other_address: flags & 4 != 0, from_other_port: flags & 2 != 0 })
}

/// A Binding success that reports `mapped` and, when given, names the server's other address.
pub fn success(transaction: [u8; 12], mapped: SocketAddrV4, elsewhere: Option<SocketAddrV4>) -> Vec<u8> {
    let mut packet = Vec::from(BINDING_SUCCESS.to_be_bytes());
    packet.extend([0, if elsewhere.is_some() { 24 } else { 12 }]);
    packet.extend(MAGIC_COOKIE);
    packet.extend(transaction);
    packet.extend([(XOR_MAPPED_ADDRESS >> 8) as u8, XOR_MAPPED_ADDRESS as u8, 0, 8, 0, 1]);
    packet.extend(mapped.port().to_be_bytes().iter().zip(MAGIC_COOKIE).map(|(byte, mask)| byte ^ mask));
    packet.extend(mapped.ip().octets().iter().zip(MAGIC_COOKIE).map(|(byte, mask)| byte ^ mask));
    if let Some(elsewhere) = elsewhere {
        packet.extend([(OTHER_ADDRESS >> 8) as u8, OTHER_ADDRESS as u8, 0, 8, 0, 1]);
        packet.extend(elsewhere.port().to_be_bytes());
        packet.extend(elsewhere.ip().octets());
    }
    packet
}

/// What a Binding success says: the address it saw, and the other address the server can answer
/// from when it names one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Answer {
    pub mapped: SocketAddr,
    pub elsewhere: Option<SocketAddr>,
}

/// The address a Binding success reports for `transaction`, or `None` for any other packet.
pub fn mapped(packet: &[u8], transaction: [u8; 12]) -> Option<SocketAddr> {
    Some(answer(packet, transaction)?.mapped)
}

/// A Binding success for `transaction`, or `None` for any other packet.
pub fn answer(packet: &[u8], transaction: [u8; 12]) -> Option<Answer> {
    let header = packet.get(..20)?;
    if header[..2] != BINDING_SUCCESS.to_be_bytes() || header[4..8] != MAGIC_COOKIE || header[8..] != transaction {
        return None;
    }
    // The length in the header is the whole of what follows it, and every attribute lies inside it
    // with its padding (RFC 8489, section 6.3): a packet that says otherwise is not an answer.
    let mut attributes = &packet[20..];
    if attributes.len() != usize::from(u16::from_be_bytes([header[2], header[3]])) {
        return None;
    }
    let (mut masked, mut plain, mut elsewhere) = (None, None, None);
    while !attributes.is_empty() {
        let [kind_high, kind_low, length_high, length_low, rest @ ..] = attributes else { return None };
        let length = usize::from(u16::from_be_bytes([*length_high, *length_low]));
        let value = rest.get(..length)?;
        match u16::from_be_bytes([*kind_high, *kind_low]) {
            XOR_MAPPED_ADDRESS => masked = Some(address(value, Some(&header[4..20]))?),
            MAPPED_ADDRESS => plain = Some(address(value, None)?),
            CHANGED_ADDRESS | OTHER_ADDRESS => elsewhere = address(value, None).or(elsewhere),
            _ => {}
        }
        attributes = rest.get(length.div_ceil(4) * 4..)?;
    }
    Some(Answer { mapped: masked.or(plain)?, elsewhere })
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
    fn a_request_to_answer_from_elsewhere_carries_one_attribute_with_the_two_flags() {
        let packet = request_from_elsewhere(TRANSACTION, true, true);
        assert_eq!(packet[..8], [0, 1, 0, 8, 0x21, 0x12, 0xa4, 0x42]);
        assert_eq!(packet[20..], [0, 3, 0, 4, 0, 0, 0, 6]);
        assert_eq!(request_from_elsewhere(TRANSACTION, false, true)[27], 2);
    }

    #[test]
    fn a_server_reads_what_is_asked_and_its_answer_reads_back() {
        assert_eq!(asked(&request(TRANSACTION)), Some(Asked { transaction: TRANSACTION, from_other_address: false, from_other_port: false }));
        assert_eq!(asked(&request_from_elsewhere(TRANSACTION, false, true)), Some(Asked { transaction: TRANSACTION, from_other_address: false, from_other_port: true }));
        assert_eq!(asked(&request_from_elsewhere(TRANSACTION, true, true)).map(|asked| asked.from_other_address), Some(true));
        assert_eq!(asked(&super::success(TRANSACTION, "192.0.2.1:32853".parse().unwrap(), None)), None);
        let (mapped, elsewhere): (SocketAddrV4, SocketAddrV4) = ("192.0.2.1:32853".parse().unwrap(), "198.51.100.7:3479".parse().unwrap());
        assert_eq!(answer(&super::success(TRANSACTION, mapped, Some(elsewhere)), TRANSACTION), Some(Answer { mapped: mapped.into(), elsewhere: Some(elsewhere.into()) }));
        assert_eq!(answer(&super::success(TRANSACTION, mapped, None), TRANSACTION), Some(Answer { mapped: mapped.into(), elsewhere: None }));
    }

    #[test]
    fn reads_the_other_address_a_server_names() {
        // MAPPED-ADDRESS 192.0.2.1:32853 and CHANGED-ADDRESS 198.51.100.7:3479, as an RFC 3489 server sends them.
        let attributes = [0, 1, 0, 8, 0, 1, 0x80, 0x55, 192, 0, 2, 1, 0, 5, 0, 8, 0, 1, 0x0d, 0x97, 198, 51, 100, 7];
        assert_eq!(
            answer(&success(&attributes), TRANSACTION),
            Some(Answer { mapped: "192.0.2.1:32853".parse().unwrap(), elsewhere: Some("198.51.100.7:3479".parse().unwrap()) })
        );
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
        // Bytes past the declared length, an attribute that runs past the end, and padding that is
        // missing are all refused.
        let mut longer = success(&plain);
        longer.push(0);
        assert_eq!(mapped(&longer, TRANSACTION), None);
        assert_eq!(mapped(&success(&[0x00, 0x01, 0x00, 0x08, 0x00, 0x01]), TRANSACTION), None);
        assert_eq!(mapped(&success(&[0x80, 0x22, 0x00, 0x01, b'x']), TRANSACTION), None);
    }
}
