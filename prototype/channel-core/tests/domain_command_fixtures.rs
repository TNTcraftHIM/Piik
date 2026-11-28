use piik_channel_core::{
    conversation::{ConversationAddress, ConversationCommand, ConversationRequest, SessionSigner},
    host::{HostAction, HostInput, RoomHost},
    wire::{Command, Request, RoomAccess},
    RoomState, PRODUCT_VERSION,
};
use serde_json::json;
use uuid::Uuid;

// Each row supplies both a specimen and an arm of the exhaustive Command match.
macro_rules! command_specimens {
    ($($variant:pat => $specimen:expr),+ $(,)?) => {{
        #[deny(unreachable_patterns)]
        fn known_variant(command: &Command) -> Option<&'static str> {
            match command {
                $($variant => Some(stringify!($variant)),)+
                // Request::parse refuses the sentinel with "unsupported".
                Command::Unknown => None,
            }
        }

        for (expected, specimen) in [$( (stringify!($variant), $specimen) ),+] {
            let text = specimen.to_string();
            let request = if specimen["type"] == "join" {
                Request::parse_first(&text).unwrap_or_else(|_| panic!("{expected} join rejected"))
            } else {
                Request::parse(&text).unwrap_or_else(|error| panic!("{expected} rejected: {error:?}"))
            };
            assert_eq!(known_variant(&request.command), Some(expected));
        }
    }};
}

#[test]
fn domain_reads_each_known_command_kind() {
    let user = Uuid::from_u128(1);
    let sender = Uuid::from_u128(2);
    let host_session = Uuid::from_u128(3);
    let binding = Uuid::from_u128(4);
    let resource = Uuid::from_u128(5);
    let pair = Uuid::from_u128(6);

    let signer = SessionSigner::from_seed([1; 32]);
    let mut host = RoomHost::new(
        RoomState::new(
            "room".into(),
            "Friends".into(),
            Default::default(),
            user,
            RoomAccess::Public,
            false,
            None,
        )
        .unwrap(),
    );
    let summary = host.summary();
    let room = &summary.id;
    host.dispatch(HostInput {
        hosting_mode: Default::default(),
        channel_owner_id: user,
        now: 1000,
        binding_id: binding,
        host_session_id: host_session,
        revision: 1,
        failed_pairs: Default::default(),
        confirmed_pairs: Default::default(),
        disconnected_pairs: Default::default(),
        endpoints: Default::default(),
        service_endpoint: None,
        action: HostAction::Sync,
    })
    .unwrap();
    let output = host.finish(None).unwrap();

    let packet = signer
        .sign(
            sender,
            &ConversationRequest {
                address: ConversationAddress {
                    room_id: room.clone(),
                    binding_id: binding,
                    sender,
                    recipient: host_session,
                    request_id: "conversation".into(),
                },
                command: ConversationCommand::InteractionReady,
            },
        )
        .unwrap();

    let playback =
        json!({"timeline":"media","position":12.5,"paused":false,"rate":1.5,"anchorTime":1000});
    let input_secret = [2_u8; 32];
    let byte_source = json!({"sessionId":sender,"resourceId":resource,"format":"file"});

    command_specimens! {
        Command::Join { .. } => json!({
            "type":"join","name":"Reader",
            "major":PRODUCT_VERSION.major,"minor":PRODUCT_VERSION.minor,
            "signingKey":signer.signing_key(),
        }),
        Command::SetProfile { .. } => json!({"type":"set_profile","name":"Reader"}),
        Command::Profiles { .. } => json!({"type":"profiles","ids":[user]}),
        Command::UpdateDomain { .. } => json!({"type":"update_domain","name":"Friends"}),
        Command::SetRoomCreationPolicy { .. } => json!({"type":"set_room_creation_policy","policy":"ordinary"}),
        Command::Conversation { .. } => json!({"type":"conversation","packet":packet}),
        Command::Browse { .. } => json!({"type":"browse","roomId":room,"active":true}),
        Command::FileOffer { .. } => json!({
            "type":"file_offer","roomId":room,"messageSeq":1,"attachmentId":resource,
            "sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            "available":true,
        }),
        Command::ByteBranchRefused { .. } => json!({
            "type":"byte_branch_refused","roomId":room,"downstreamId":sender,
            "target":{"kind":"file","messageSeq":1,"attachmentId":resource,"sourceId":host_session},
        }),
        Command::ForwardingAvailable { .. } => json!({"type":"forwarding_available","roomId":room,"kind":"file"}),
        Command::FileReceive { .. } => json!({
            "type":"file_receive","roomId":room,"messageSeq":1,"attachmentId":resource,"enabled":true,
        }),
        Command::ObserveFiles { .. } => json!({
            "type":"observe_files","roomId":room,"observationId":binding,"keys":[[1, resource]],
        }),
        Command::HostRegister { .. } => json!({"type":"host_register","room":summary}),
        Command::CancelRoomCreation { .. } => json!({"type":"cancel_room_creation","roomId":room}),
        Command::CreateRoom { .. } => json!({"type":"create_room","room":summary}),
        Command::AdmitRoom { .. } => json!({"type":"admit_room","room":summary}),
        Command::DeleteRoom { .. } => json!({"type":"delete_room","roomId":room,"deleteData":false}),
        Command::HostUnsupported { .. } => json!({
            "type":"host_unsupported","roomId":room,"bindingId":binding,"revision":1,
        }),
        Command::HostOutput { .. } => json!({"type":"host_output","roomId":room,"output":output}),
        Command::HostStop { .. } => json!({"type":"host_stop","roomId":room,"bindingId":binding}),
        Command::UpdateRoom { .. } => json!({"type":"update_room","roomId":room,"name":"Renamed"}),
        Command::EnterRoom { .. } => json!({"type":"enter_room","roomId":room}),
        Command::RelayCapacity { .. } => json!({"type":"relay_capacity","roomId":room,"capacity":2}),
        Command::RoomInvite { .. } => json!({"type":"room_invite","roomId":room}),
        Command::GetRoomInvite { .. } => json!({"type":"get_room_invite","roomId":room}),
        Command::RoomTopology { .. } => json!({"type":"room_topology","roomId":room,"publicationId":resource}),
        Command::RevokeRoomAccess { .. } => json!({"type":"revoke_room_access","roomId":room,"userId":user}),
        Command::StartWatch { .. } => json!({
            "type":"start_watch","roomId":room,"id":resource,
            "source":{"kind":"media","url":"https://example.com/movie.mp4"},"playback":playback,
        }),
        Command::UpdateWatch { .. } => json!({"type":"update_watch","roomId":room,"id":resource,"playback":playback}),
        Command::SetWatchByteSource { .. } => json!({
            "type":"set_watch_byte_source","roomId":room,"id":resource,"byteSource":byte_source,
        }),
        Command::JoinWatch { .. } => json!({"type":"join_watch","roomId":room,"id":resource,"mode":"direct"}),
        Command::StopWatch { .. } => json!({"type":"stop_watch","roomId":room,"id":resource}),
        Command::Publish { .. } => json!({
            "type":"publish","publication":{"id":resource,"roomId":room,"kind":"voice"},
        }),
        Command::Unpublish { .. } => json!({"type":"unpublish","publicationId":resource}),
        Command::SetScreenDirectLimit { .. } => json!({"type":"set_screen_direct_limit","publicationId":resource,"limit":2}),
        Command::SetTitle { .. } => json!({"type":"set_title","publicationId":resource,"title":"Screen"}),
        Command::SetPaused { .. } => json!({"type":"set_paused","publicationId":resource,"paused":true}),
        Command::TransferSource { .. } => json!({"type":"transfer_source","publicationId":resource,"toSessionId":sender}),
        Command::Subscribe { .. } => json!({"type":"subscribe","publicationId":resource,"enabled":true}),
        Command::InputRegister { .. } => json!({
            "type":"input_register","publicationId":resource,"flowId":binding,"secret":input_secret,
        }),
        Command::Voice { .. } => json!({
            "type":"voice","roomId":room,"joined":true,"muted":false,"deafened":false,
        }),
        Command::Signal { .. } => json!({"type":"signal","pairId":pair,"payload":{"resync":true}}),
        Command::LinkState { .. } => json!({"type":"link_state","pairId":pair,"state":"connected"}),
        Command::FlowState { .. } => json!({
            "type":"flow_state","flowId":binding,"pairId":pair,"state":"forwardable",
        }),
        Command::RoomDataState { .. } => json!({"type":"room_data_state","roomId":room,"pairId":pair,"ready":true}),
        Command::Leave => json!({"type":"leave"}),
    }
}
