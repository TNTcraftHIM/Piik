//! Same directional AES-GCM envelope as the shared Browser EncryptedInput.
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use anyhow::{anyhow, ensure, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use uuid::Uuid;

pub(super) struct Cipher {
    key: Aes256Gcm,
    sent: u64,
    received: u64,
}

impl Cipher {
    pub fn new(secret: &[u8; 32]) -> Self {
        Self {
            key: Aes256Gcm::new(secret.into()),
            sent: 0,
            received: 0,
        }
    }

    pub fn open(&mut self, data: &str, flow: Uuid) -> Result<Vec<u8>> {
        ensure!(data.len() <= 6144, "input_packet_too_large");
        let bytes = STANDARD.decode(data)?;
        ensure!((36..=4132).contains(&bytes.len()), "invalid_input_packet");
        let sequence = u64::from_be_bytes(bytes[..8].try_into()?);
        ensure!(sequence > self.received, "stale_input_packet");
        let plain = self
            .key
            .decrypt(
                Nonce::from_slice(&bytes[8..20]),
                Payload {
                    msg: &bytes[20..],
                    aad: &aad(0, &bytes[..8], flow),
                },
            )
            .map_err(|_| anyhow!("invalid_input_authentication"))?;
        self.received = sequence;
        Ok(plain)
    }

    pub fn seal(&mut self, plain: &[u8], flow: Uuid) -> Result<String> {
        self.sent = self
            .sent
            .checked_add(1)
            .ok_or_else(|| anyhow!("input_counter_exhausted"))?;
        let mut bytes = vec![0; 20];
        bytes[..8].copy_from_slice(&self.sent.to_be_bytes());
        getrandom::fill(&mut bytes[8..]).map_err(|_| anyhow!("input_random_unavailable"))?;
        let encrypted = self
            .key
            .encrypt(
                Nonce::from_slice(&bytes[8..20]),
                Payload {
                    msg: plain,
                    aad: &aad(1, &bytes[..8], flow),
                },
            )
            .map_err(|_| anyhow!("input_encryption_failed"))?;
        bytes.extend(encrypted);
        Ok(STANDARD.encode(bytes))
    }
}

fn aad(direction: u8, sequence: &[u8], flow: Uuid) -> [u8; 41] {
    let mut aad = [0; 41];
    aad[0] = direction;
    aad[1..9].copy_from_slice(sequence);
    aad[9..].copy_from_slice(flow.simple().to_string().as_bytes());
    aad
}
