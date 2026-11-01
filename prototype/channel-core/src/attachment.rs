//! Confirmed message descriptions; file bytes belong to participants.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentDescriptor {
    pub id: Uuid,
    pub name: String,
    pub size: u64,
    pub media_type: String,
    pub sha256: String,
}
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentLimits {
    pub max_file_bytes: u64,
    pub max_attachments_per_message: usize,
    pub max_retained_bytes: u64,
    pub max_retained_files: usize,
}
pub const ATTACHMENT_LIMITS: AttachmentLimits = AttachmentLimits {
    max_file_bytes: 16 * 1024 * 1024,
    max_attachments_per_message: 8,
    max_retained_bytes: 256 * 1024 * 1024,
    max_retained_files: 256,
};
impl AttachmentDescriptor {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.id.is_nil()
            || self.name.trim().is_empty()
            || self.name.chars().count() > 240
            || self.name.chars().any(char::is_control)
            || self.size > ATTACHMENT_LIMITS.max_file_bytes
            || !matches!(
                self.media_type.as_str(),
                "image/png"
                    | "image/jpeg"
                    | "image/gif"
                    | "image/webp"
                    | "application/octet-stream"
            )
            || self.sha256.len() != 64
            || !self.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("invalid_attachments");
        }
        Ok(())
    }
}
pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[derive(Default)]
pub struct AttachmentHash(Sha256);
impl AttachmentHash {
    pub fn update(&mut self, bytes: &[u8]) {
        self.0.update(bytes);
    }
    pub fn finish(self) -> String {
        format!("{:x}", self.0.finalize())
    }
}

/// Only recognized raster formats receive image MIME types. Everything else is
/// downloaded as bytes, regardless of a supplied extension or Content-Type.
pub fn sniff_media_type(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else {
        "application/octet-stream"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn byte_preparation_keeps_digest_complete_and_only_sniffs_raster_signatures() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(sniff_media_type(b"<svg>"), "application/octet-stream");
        assert_eq!(sniff_media_type(b"RIFFabcdWEBPcontent"), "image/webp");
        let file = AttachmentDescriptor {
            id: Uuid::new_v4(),
            name: "file.bin".into(),
            size: 3,
            media_type: "application/octet-stream".into(),
            sha256: sha256_hex(b"abc"),
        };
        assert!(file.validate().is_ok());
        assert_eq!(
            AttachmentDescriptor {
                sha256: "abc".into(),
                ..file.clone()
            }
            .validate(),
            Err("invalid_attachments")
        );
        assert_eq!(
            AttachmentDescriptor {
                size: ATTACHMENT_LIMITS.max_file_bytes + 1,
                ..file
            }
            .validate(),
            Err("invalid_attachments")
        );
    }
}
