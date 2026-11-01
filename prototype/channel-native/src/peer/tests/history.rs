//! Two ordinary subtree readers share one reliable Control hop.
use super::*;
use crate::data::MessageScope;
use crate::peer::tests::support::message;
use piik_channel_core::{
    conversation::{
        self, ControlFrame, ConversationAddress, ConversationRecord, ConversationReply,
        ConversationResult, SessionSigner,
    },
    history::{ConfirmationInput, HistoryResult, MessageDraft, HISTORY_PAGE},
};

pub(super) fn pages() -> Result<Vec<(Vec<u8>, MessageScope)>> {
    let (_, base) = message("two subtree history readers")?;
    let MessageScope::Conversation {
        snapshot,
        local,
        peer,
        ..
    } = base
    else {
        unreachable!()
    };
    let mut snapshot = snapshot.borrow().as_ref().unwrap().clone();
    let readers = [Uuid::from_u128(3), Uuid::from_u128(4)];
    let room = &mut snapshot.channel.rooms[0];
    for reader in readers {
        room.participant_session_ids.push(reader);
        room.delivery
            .as_mut()
            .unwrap()
            .next_hops
            .insert(reader, peer);
    }
    let signer = SessionSigner::from_seed([6; 32]);
    let messages = (0..HISTORY_PAGE)
        .map(|index| {
            MessageDraft {
                user_id: local,
                nonce: format!("history-{index}"),
                text: format!("History record {index}: {}", "x".repeat(900)),
                attachments: vec![],
                time: index as u64,
            }
            .prepare_confirmation(ConfirmationInput::New {
                last_seq: index as u64,
            })
            .map(|confirmation| confirmation.message)
            .map_err(anyhow::Error::msg)
        })
        .collect::<Result<Vec<_>>>()?;
    let mut frames = Vec::new();
    for reader in readers {
        let request = ConversationAddress {
            room_id: "transport-check".into(),
            binding_id: Uuid::from_u128(4),
            sender: reader,
            recipient: local,
            request_id: format!("history-{reader}"),
        };
        let replies = request
            .replies(Ok(ConversationResult::History(HistoryResult::Page {
                messages: messages.clone(),
                has_more: false,
                oldest_seq: Some(1),
                before: None,
            })))
            .map_err(anyhow::Error::msg)?;
        for reply in replies {
            let original = signer.sign(local, &reply).map_err(anyhow::Error::msg)?;
            let mut routed = original.clone();
            ensure!(
                conversation::route(&mut routed, local, &snapshot, None)
                    .map_err(anyhow::Error::msg)?
                    .next_hop
                    == Some(peer)
            );
            let bytes = conversation::encode_control(&ControlFrame::Conversation(routed))
                .map_err(anyhow::Error::msg)?;
            let scope = MessageScope::Conversation {
                snapshot: watch::channel(Some(snapshot.clone())).1,
                local,
                peer,
                from: None,
                packet: original,
            };
            frames.push((bytes, scope));
        }
    }
    ensure!(
        frames.len() == 202
            && frames.iter().map(|(bytes, _)| bytes.len()).sum::<usize>() < 1024 * 1024
    );
    Ok(frames)
}

pub(super) fn verify_pages(frames: &[Vec<u8>]) -> Result<()> {
    let key = SessionSigner::from_seed([6; 32]).signing_key();
    let mut ends = std::collections::BTreeMap::new();
    for bytes in frames {
        let ControlFrame::Conversation(packet) =
            conversation::decode_control(bytes).map_err(anyhow::Error::msg)?
        else {
            anyhow::bail!("unexpected file control");
        };
        let reply: ConversationReply =
            conversation::verify(&packet, key).map_err(anyhow::Error::msg)?;
        if let ConversationRecord::HistoryEnd { count, .. } = reply.record {
            ensure!(count == HISTORY_PAGE);
            *ends.entry(reply.address.recipient).or_insert(0) += 1;
        }
    }
    ensure!(ends.len() == 2 && ends.values().all(|count| *count == 1));
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_core_history_pages_survive_one_ordered_sctp_gap() -> Result<()> {
    let receipt = super::bulk::scenario(super::bulk::Window::History).await?;
    println!("CONTROL_HISTORY_RECEIPT {receipt}");
    Ok(())
}
