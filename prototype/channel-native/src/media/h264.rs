//! NAL boundaries in one complete H264 Annex B access unit.
use anyhow::{ensure, Result};

pub(crate) fn nals(bytes: &[u8]) -> Result<impl Iterator<Item = &[u8]>> {
    let mut remaining = if bytes.is_empty() {
        bytes
    } else {
        let (start, end) =
            delimiter(bytes).ok_or_else(|| anyhow::anyhow!("missing H264 Annex B delimiter"))?;
        ensure!(start == 0, "data precedes H264 Annex B delimiter");
        &bytes[end..]
    };
    Ok(std::iter::from_fn(move || {
        while !remaining.is_empty() {
            let (end, next) = delimiter(remaining).unwrap_or((remaining.len(), remaining.len()));
            let nal = &remaining[..end];
            remaining = &remaining[next..];
            // Annex B trailing_zero_8bits are outside the NAL unit.
            let end = nal
                .iter()
                .rposition(|byte| *byte != 0)
                .map_or(0, |at| at + 1);
            if end > 0 {
                return Some(&nal[..end]);
            }
        }
        None
    }))
}

fn delimiter(bytes: &[u8]) -> Option<(usize, usize)> {
    let at = bytes.windows(3).position(|prefix| prefix == [0, 0, 1])?;
    let mut start = at;
    while start > 0 && bytes[start - 1] == 0 {
        start -= 1;
    }
    Some((start, at + 3))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_au_keeps_sei_and_escaped_payload_between_borrowed_nals() -> Result<()> {
        let bytes = [
            0, 0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0, 0, 1, 0x06, 0x05, 0, 0, 3, 1, 0, 0, 0, 1,
            0x65, 0x80, 0, 0,
        ];
        assert_eq!(
            nals(&bytes)?.collect::<Vec<_>>(),
            [
                &[0x67, 0x42, 0xe0, 0x1f][..],
                &[0x06, 0x05, 0, 0, 3, 1][..],
                &[0x65, 0x80][..],
            ]
        );
        Ok(())
    }

    #[test]
    fn empty_units_are_skipped_but_unframed_data_is_rejected() -> Result<()> {
        for bytes in [&[][..], &[0, 0, 1][..], &[0, 0, 0, 1][..]] {
            assert!(nals(bytes)?.next().is_none());
        }
        assert_eq!(
            nals(&[0, 0, 1, 0, 0, 0, 1, 0x68, 0x80, 0, 0, 1])?.collect::<Vec<_>>(),
            [&[0x68, 0x80][..]]
        );
        for bytes in [&[0x65, 0x80][..], &[9, 0, 0, 1, 0x65][..], &[0, 0, 0][..]] {
            assert!(nals(bytes).is_err());
        }
        Ok(())
    }
}
