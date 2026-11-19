import { z } from "zod";
import { watchFormatSchema } from "../../shared/watch-format";
export type { WatchFormat } from "../../shared/watch-format";
import { videoSettingsSchema, type VideoSettings } from "../../shared/protocol";
import { DEFAULT_RELAY_CAPACITY, MAX_RELAY_CAPACITY } from "../../shared/relay-capacity";
export { DEFAULT_RELAY_CAPACITY, MAX_RELAY_CAPACITY } from "../../shared/relay-capacity";

// This is the experimental channel wire boundary; production room contracts stay separate.
const id = z.string().min(1).max(128);
const identityNameSchema = z.string().refine(name => name.length <= 64, "Name exceeds 64 UTF-16 units");
export const IDENTITY_IMAGE_URL_BYTES = 24 * 1024;
export const identityImageSchema = z.string().max(IDENTITY_IMAGE_URL_BYTES)
  .regex(/^data:image\/(?:png|webp);base64,(?=[A-Za-z0-9+/])(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const roomIconSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const identityIconSchema = z.union([roomIconSchema, identityImageSchema]);
const signingKey = z.array(z.number().int().min(0).max(255)).length(32);
export const CHANNEL_PROTOCOL = 35;
export const CHANNEL_SESSION_LIMIT = 128;
export const CHANNEL_ROOM_LIMIT = 64;
export const roomCreationPolicySchema = z.enum(["ordinary", "invite_only", "owner_only"]);
export type RoomCreationPolicy = z.infer<typeof roomCreationPolicySchema>;
const signedConversationPacketSchema = z.object({ sender: id, payload: z.string(), signature: z.array(z.number().int().min(0).max(255)).length(64) });
const roomInvitationSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("missing") }),
  z.object({ state: z.literal("available"), key: id }),
]);
export const MAX_USER_NAME_UNITS = 40;
export const userSummarySchema = z.object({ id, name: z.string().max(MAX_USER_NAME_UNITS), version: z.string().regex(/^[a-f0-9]{64}$/) });
export const userSchema = userSummarySchema.extend({ avatar: identityImageSchema.nullable() });
export const PROFILE_PAGE_SIZE = 32;
export const profilePageSchema = z.object({ profiles: z.array(userSchema).max(PROFILE_PAGE_SIZE), total: z.number().int().nonnegative(), nextCursor: id.nullable() });
export type ProfilePage = z.infer<typeof profilePageSchema>;
export const roomSchema = z.object({
  id, name: identityNameSchema, icon: roomIconSchema, picture: identityImageSchema.optional(), creatorId: id, access: z.enum(["public", "private"]),
  hidden: z.boolean(), hasPassword: z.boolean(), authorized: z.boolean(), canManage: z.boolean(),
  voiceBitrate: z.number().int().min(6_000).max(320_000).default(64_000),
  relayCapacity: z.number().int().min(1).max(MAX_RELAY_CAPACITY).default(DEFAULT_RELAY_CAPACITY),
  relayOverride: z.number().int().min(0).max(MAX_RELAY_CAPACITY).nullable().default(null),
  members: z.array(id).optional(),
  participantSessionIds: z.array(id),
  fileActivity: z.array(z.object({ sessionId: id, sending: z.boolean(), receiving: z.boolean() })).max(CHANNEL_SESSION_LIMIT),
  available: z.boolean(), reading: z.boolean(),
  lastMessageSeq: z.number().int().nonnegative(),
  serviceRelay: z.object({ enabled: z.boolean(), available: z.boolean() }).optional(),
  capabilities: z.object({ attachments: z.boolean() }),
  delivery: z.object({ hostSessionId: id, bindingId: id, nextHops: z.record(id, id) }).optional(),
});
export const roomSummarySchema = roomSchema.pick({ id: true, name: true, icon: true, creatorId: true, access: true, hidden: true, hasPassword: true, voiceBitrate: true, relayCapacity: true });
export const screenSourceSchema = z.object({ kind: z.enum(["screen", "camera"]), name: identityNameSchema.nullable() });
export type ScreenSource = z.infer<typeof screenSourceSchema>;
const publicationBaseSchema = z.object({
  id, roomId: id, sessionId: id, userId: id,
  paused: z.boolean(),
  audience: z.array(z.object({ sessionId: id, state: z.enum(["preparing", "active", "failed"]) })).max(CHANNEL_SESSION_LIMIT),
});
export const publicationSchema = z.discriminatedUnion("kind", [
  publicationBaseSchema.extend({ kind: z.literal("screen"), directLimit: z.number().int().min(1).max(MAX_RELAY_CAPACITY).optional(), videoSettings: videoSettingsSchema.optional(), source: screenSourceSchema, title: identityNameSchema.nullable() }),
  publicationBaseSchema.extend({ kind: z.literal("voice"), directLimit: z.never().optional(), videoSettings: z.never().optional(), source: z.never().optional(), title: z.never().optional(), audience: z.array(z.never()).max(0) }),
]);
export const attachmentSchema = z.object({
  id, name: z.string().min(1).max(240), size: z.number().int().nonnegative().safe(),
  mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp", "application/octet-stream"]),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
});
export const fileKeySchema = z.object({ roomId: id, messageSeq: z.number().int().positive(), attachmentId: id });
export const filePlanSchema = z.object({
  roomId: id, messageSeq: z.number().int().positive(), attachment: attachmentSchema, authorId: z.uuid(),
  sourceId: id.nullable(), upstream: id.nullable(), downstream: z.array(id), receiving: z.boolean(),
});
export const MAX_MESSAGE_CODE_POINTS = 2000;
const mentionSchema = z.object({ userId: id, start: z.number().int().nonnegative(), end: z.number().int().positive() });
export const inlineImageSchema = z.object({ data: z.string(), mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  original: z.boolean(), width: z.number().int().positive(), height: z.number().int().positive() });
export type ImageRendition = z.infer<typeof inlineImageSchema>;
export const messageSchema = z.object({
  id, userId: id, text: z.string().max(MAX_MESSAGE_CODE_POINTS * 2), time: z.number(), seq: z.number().int().positive(), attachments: z.array(attachmentSchema),
  archivedAuthorName: z.string().min(1).max(MAX_USER_NAME_UNITS).optional(),
  mentions: z.array(mentionSchema).optional(),
  reply: z.object({ seq: z.number().int().positive(), userId: id, archivedAuthorName: z.string().max(MAX_USER_NAME_UNITS).optional(), text: z.string().max(160), notify: z.boolean() }).optional(),
  inlineImages: z.record(id, inlineImageSchema).optional(),
});
export const MAX_WATCH_URL_LENGTH = 4096;
export const watchPlaybackSchema = z.object({ timeline: z.enum(["media", "program"]), position: z.number().nonnegative().finite(), paused: z.boolean(), rate: z.number().positive().max(16), anchorTime: z.number().int().nonnegative().safe() });
export type WatchPlayback = z.infer<typeof watchPlaybackSchema>;
export type WatchTimeline = WatchPlayback["timeline"];
const watchURLSchema = z.string().url().max(MAX_WATCH_URL_LENGTH).refine(value => {
  try {
    const url = new URL(value);
    return value.trim() === value && new TextEncoder().encode(value).byteLength <= MAX_WATCH_URL_LENGTH
      && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
});
export const watchSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("media"), url: watchURLSchema }).strict(),
  z.object({ kind: z.literal("website"), url: watchURLSchema, mediaUrl: watchURLSchema.optional() }).strict(),
]);
export type WatchSource = z.infer<typeof watchSourceSchema>;
export const watchByteSourceSchema = z.object({ sessionId: z.uuid(), resourceId: z.uuid(), format: watchFormatSchema }).strict();
export type WatchByteSource = z.infer<typeof watchByteSourceSchema>;
export type WatchMode = "direct" | "peer";
export const watchBytePlanSchema = z.object({ roomId: id, activityId: z.uuid(), source: watchByteSourceSchema, upstream: z.uuid().nullable(), downstream: z.array(z.uuid()), receiving: z.boolean() }).strict();
export type WatchBytePlan = z.infer<typeof watchBytePlanSchema>;
export const watchActivitySchema = z.object({ id, roomId: id, userId: id, sessionId: id, source: watchSourceSchema, playback: watchPlaybackSchema, viewerSessionIds: z.array(id).max(CHANNEL_SESSION_LIMIT), byteSource: watchByteSourceSchema.optional() }).strict();
export type WatchActivity = z.infer<typeof watchActivitySchema>;
export const snapshotSchema = z.object({
  channel: z.object({
    id, name: identityNameSchema, icon: identityIconSchema, ownerId: id.nullable(), rooms: z.array(roomSchema).max(CHANNEL_ROOM_LIMIT), historyWindow: z.number().int().positive(), userCount: z.number().int().nonnegative(),
    roomCreationPolicy: roomCreationPolicySchema, hostingMode: z.enum(["lightweight", "hosted"]),
    managedRoomIds: z.array(id).max(CHANNEL_ROOM_LIMIT),
  }),
  users: z.array(userSummarySchema),
  sessions: z.array(z.object({ id, userId: id, online: z.boolean(), signingKey })).max(CHANNEL_SESSION_LIMIT),
  publications: z.array(publicationSchema),
  voice: z.array(z.object({ sessionId: id, roomId: id, muted: z.boolean(), deafened: z.boolean() })),
  subscriptions: z.array(id),
  watchActivities: z.array(watchActivitySchema),
  watchSubscriptions: z.array(z.object({ id, mode: z.enum(["direct", "peer"]) }).strict()),
  watchBytes: z.array(watchBytePlanSchema),
  failedSubscriptions: z.array(id),
  files: z.array(filePlanSchema),
  pairs: z.array(z.object({ id, peerId: id, canReceiveVideoLayers: z.boolean().default(false), rooms: z.array(id), outgoing: z.array(z.object({ id, publicationId: id, selected: z.boolean(), inputFlowId: id.nullable() })), incoming: z.array(z.object({ id, publicationId: id, selected: z.boolean(), inputFlowId: id.nullable() })) })).max(CHANNEL_SESSION_LIMIT - 1),
  iceServers: z.array(z.object({ urls: z.union([z.string(), z.array(z.string())]), username: z.string().optional(), credential: z.string().optional() })),
});
const udpAddressSchema = z.ipv4().refine(address => {
  const [a, b] = address.split(".").map(Number);
  return address !== "0.0.0.0" && address !== "255.255.255.255" && a !== 10 && a !== 127
    && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168)
    && !(a >= 224 && a <= 239);
});
export const udpObservationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stable"), address: udpAddressSchema, port: z.number().int().min(1024).max(65535) }).strict(),
  z.object({ kind: z.literal("sequential"), address: udpAddressSchema, port: z.number().int().min(1024).max(65535), step: z.number().int().min(-16).max(16) }).strict()
    .refine(value => value.step !== 0 && value.port + 4 * value.step >= 1024 && value.port + 4 * value.step <= 65535),
  z.object({ kind: z.literal("irregular"), address: udpAddressSchema }).strict(),
]);
export const udpSignalSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("offer"), secret: signingKey, observation: udpObservationSchema }).strict(),
  z.object({ type: z.literal("answer"), observation: udpObservationSchema }).strict(),
  z.object({ type: z.literal("ready") }).strict(),
  z.object({ type: z.literal("unavailable") }).strict(),
  z.object({ type: z.literal("complete") }).strict(),
]);
export const signalSchema = z.object({
  udp: udpSignalSchema.optional(),
  resync: z.boolean().optional(),
  exchangeId: z.string().uuid().optional(),
  description: z.object({ type: z.enum(["offer", "answer"]), sdp: z.string().max(150000).optional() }).optional(),
  candidate: z.object({ candidate: z.string().max(4096).optional(), sdpMid: z.string().nullable().optional(), sdpMLineIndex: z.number().nullable().optional(), usernameFragment: z.string().nullable().optional(), origin: z.literal("linear").optional() })
    .refine(value => value.origin !== "linear" || !!value.candidate?.trim() && !!value.usernameFragment?.trim()).optional(),
  tracks: z.array(z.object({ flowId: id, streamId: id })).optional(),
}).refine(signal => signal.udp
  ? [signal.resync, signal.exchangeId, signal.description, signal.candidate, signal.tracks].every(value => value === undefined)
  : Boolean(signal.description) === Boolean(signal.exchangeId), { message: "UDP preparation is exclusive; SDP requires an exchange", path: ["exchangeId"] });
export const channelTopologySchema = z.object({
  serviceAvailable: z.boolean(),
  serviceEnabled: z.boolean(),
  bindingId: id,
  transitSession: id.nullable(),
  base: z.object({ rootSessionId: id, edges: z.array(z.object({ sender: id, receiver: id, ready: z.boolean() }).strict()) }).strict(),
  screen: z.object({ publicationId: id, sourceSessionId: id, edges: z.array(z.object({
    sender: id, receiver: id, selected: z.boolean(), proof: z.enum(["forwardable", "decoded"]).nullable(),
    presented: z.boolean().nullable(), presentation: z.boolean(),
  }).strict()) }).strict().nullable(),
}).strict();
export type ChannelTopology = z.infer<typeof channelTopologySchema>;
export const channelWelcomeSchema = z.object({ type: z.literal("welcome"), protocol: z.literal(CHANNEL_PROTOCOL), credential: id, selfProfile: userSchema, sessionId: id, state: snapshotSchema, invitationOrigin: z.string().url().optional() });
export const eventSchema = z.discriminatedUnion("type", [
  channelWelcomeSchema,
  profilePageSchema.extend({ type: z.literal("profiles"), requestId: id }),
  z.object({ type: z.literal("conversation"), packet: signedConversationPacketSchema }),
  z.object({ type: z.literal("state"), state: snapshotSchema }),
  z.object({ type: z.literal("input_state"), registrations: z.array(z.object({ publicationId: id, controllerSessionId: id, flowId: id, secret: signingKey })) }),
  z.object({ type: z.literal("room_invite"), roomId: id, key: id, requestId: id.optional() }),
  z.object({ type: z.literal("room_invite_state"), roomId: id, invitation: roomInvitationSchema, requestId: id.optional() }),
  z.object({ type: z.literal("host_bound"), roomId: id, bindingId: id }),
  z.object({ type: z.literal("room_created"), room: roomSummarySchema, requestId: id.optional() }),
  z.object({ type: z.literal("host_input"), roomId: id, input: z.object({ bindingId: id }).passthrough() }),
  z.object({ type: z.literal("room_reply"), roomId: id, requestId: id.optional(), result: z.object({ type: z.string(), code: z.string().optional() }).passthrough() }),
  z.object({ type: z.literal("signal"), pairId: id, fromSessionId: id, payload: signalSchema }),
  z.object({ type: z.literal("ack"), requestId: id }),
  z.object({ type: z.literal("error"), code: z.string(), requestId: id.optional() }),
]);

export type ChannelSnapshot = z.infer<typeof snapshotSchema>;
export type ChannelPublication = z.infer<typeof publicationSchema>;
export interface MessageReactions { revision: number; counts: Record<string, number> }
export interface MessageReactionSnapshot extends MessageReactions { messageId: string; messageSeq: number }
export interface PublicationReactionSnapshot extends MessageReactions { publicationId: string }
export type ReactionTarget = { type: "message"; messageSeq: number } | { type: "publication"; publicationId: string } | { type: "person"; userId: string };
export interface ReactionEvent { id: string; occurredAt: number; senderUserId: string; target: ReactionTarget; reaction: string }
export type ReactionSnapshot = ({ type: "message" } & MessageReactionSnapshot) | ({ type: "publication" } & PublicationReactionSnapshot);
export type ChannelMessage = z.infer<typeof messageSchema> & { reactions?: MessageReactions };
export interface ChatOptions { mentions?: z.infer<typeof mentionSchema>[]; reply?: { seq: number; notify: boolean } }
export type ChannelAttachment = z.infer<typeof attachmentSchema>;
export type ChannelFileKey = z.infer<typeof fileKeySchema>;
export type ChannelFilePlan = z.infer<typeof filePlanSchema>;
export type ChannelUser = z.infer<typeof userSchema>;
export type ChannelUserSummary = z.infer<typeof userSummarySchema>;
export type ChannelRoom = z.infer<typeof roomSchema>;
export type RoomSummary = z.infer<typeof roomSummarySchema>;
export type ChannelPair = ChannelSnapshot["pairs"][number];
export type ChannelSignal = z.infer<typeof signalSchema>;
export type ChannelEvent = z.infer<typeof eventSchema>;

export const CHANNEL_EVENT_BYTES = 4 * 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** One physical socket's last validated snapshot supplies omitted identity pictures. */
export class ChannelEventDecoder {
  private channelId: string | null = null;
  private channelIcon: string | undefined;
  private roomPictures = new Map<string, string>();

  decode(raw: unknown, wireBytes: number): ChannelEvent {
    if (wireBytes > CHANNEL_EVENT_BYTES) throw new Error("Channel event exceeds frame limit");
    if (record(raw) && raw.type === "profiles" && wireBytes > 1024 * 1024) throw new Error("Profile page exceeds frame limit");
    let fullBytes = wireBytes;
    if (record(raw) && (raw.type === "welcome" || raw.type === "state") && record(raw.state)) {
      const channel = raw.state.channel;
      const sameDomain = record(channel) && raw.type === "state" && channel.id === this.channelId;
      const inherit = (subject: Record<string, unknown>, field: "icon" | "picture", previous: string | undefined) => {
        if (Object.hasOwn(subject, field) || previous === undefined) return;
        subject[field] = previous;
        // Pictures are ASCII. These objects already contain their ids.
        fullBytes += field.length + previous.length + 6;
      };
      if (record(channel)) {
        if (sameDomain) inherit(channel, "icon", this.channelIcon);
        if (Array.isArray(channel.rooms)) for (const room of channel.rooms) {
          if (!record(room)) continue;
          if (room.authorized !== true || room.available !== true || room.reading !== true || room.picture === null) delete room.picture;
          else if (sameDomain && typeof room.id === "string") inherit(room, "picture", this.roomPictures.get(room.id));
        }
      }
    }
    if (fullBytes > CHANNEL_EVENT_BYTES) throw new Error("Expanded channel event exceeds frame limit");
    const event = eventSchema.parse(raw);
    if (event.type === "welcome" || event.type === "state") {
      const { channel } = event.state;
      this.channelId = channel.id; this.channelIcon = channel.icon;
      this.roomPictures = new Map(channel.rooms.flatMap(room => room.picture ? [[room.id, room.picture] as const] : []));
    }
    return event;
  }
}
export type ChannelReply = Extract<ChannelEvent, { type: "room_invite" | "room_invite_state" | "room_reply" | "room_created" | "profiles" }> | Extract<ConversationReply["record"], { type: "confirmed" }>;
export type SignedConversationPacket = z.infer<typeof signedConversationPacketSchema>;
export type RoomInvitationState = { state: "available"; url: string } | { state: "missing" };
export interface ConversationAddress { roomId: string; bindingId: string; sender: string; recipient: string; requestId: string }
export type ConversationReply = ConversationAddress & { record:
  | { type: "reaction"; nonce: number; event: ReactionEvent | null; snapshot: ReactionSnapshot | null }
  | { type: "message_reactions"; snapshot: MessageReactionSnapshot }
  | { type: "interaction_ready"; serverTime: number; reactionIds: string[]; publicationReactions: PublicationReactionSnapshot[] }
  | { type: "confirmed"; message: ChannelMessage; inserted: boolean }
  | { type: "history_message" | "live_message"; message: ChannelMessage }
  | { type: "message_deleted"; messageSeq: number }
  | { type: "history_cleared"; throughSeq: number }
  | { type: "history_end"; count: number; hasMore: boolean; oldestSeq: number | null; before: number | null }
  | { type: "error"; code: string }
};
export interface DomainSettings { name: string; icon: string }
export interface RoomSettings extends DomainSettings {
  picture?: string | null;
  access: "public" | "private"; hidden: boolean; password?: string | null;
  voiceBitrate?: number;
  relayCapacity?: number;
  allowServiceRelay?: boolean;
}
export type ChannelCommand =
  | { type: "start_watch"; roomId: string; id: string; source: WatchSource; playback: WatchPlayback; byteSource?: WatchByteSource }
  | { type: "update_watch"; roomId: string; id: string; playback: WatchPlayback }
  | { type: "join_watch"; roomId: string; id: string; mode: WatchMode | null }
  | { type: "set_watch_byte_source"; roomId: string; id: string; byteSource: WatchByteSource | null }
  | { type: "stop_watch"; roomId: string; id: string }
  | { type: "join"; protocol: typeof CHANNEL_PROTOCOL; name: string; signingKey: number[]; credential?: string; ownerKey?: string; sessionId?: string }
  | { type: "conversation"; packet: SignedConversationPacket }
  | { type: "set_profile"; name?: string; avatar?: string | null }
  | ({ type: "update_domain" } & Partial<DomainSettings>)
  | { type: "set_room_creation_policy"; policy: RoomCreationPolicy }
  | { type: "profiles"; ids?: string[]; after?: string; query?: string }
  | { type: "input_register"; publicationId: string; flowId: string; secret: number[] }
  | { type: "host_register"; room: RoomSummary; resumeBinding?: string }
  | { type: "create_room"; room: RoomSummary; picture?: string; password?: string; allowServiceRelay?: boolean }
  | { type: "cancel_room_creation"; roomId: string }
  | { type: "admit_room"; room: RoomSummary }
  | { type: "delete_room"; roomId: string; deleteData: boolean }
  | { type: "host_output"; roomId: string; output: unknown }
  | { type: "host_stop"; roomId: string; bindingId: string }
  | { type: "browse"; roomId: string; active: boolean; relayCapacity?: number }
  | { type: "relay_capacity"; roomId: string; capacity: number | null }
  | { type: "interaction_ready"; roomId: string }
  | { type: "react"; roomId: string; reaction: string; target: ReactionTarget; nonce: number }
  | { type: "history"; roomId: string; before?: number }
  | { type: "delete_message"; roomId: string; messageSeq: number }
  | { type: "clear_history"; roomId: string; throughSeq: number }
  | ({ type: "chat"; roomId: string; text: string; nonce: string; attachments: ChannelAttachment[]; inlineImages?: Record<string, ImageRendition> } & ChatOptions)
  | ({ type: "file_offer"; sha256: string; available: boolean } & ChannelFileKey)
  | ({ type: "file_receive"; enabled: boolean } & ChannelFileKey)
  | ({ type: "file_branch_refused"; downstreamId: string; sourceId: string } & ChannelFileKey)
  | { type: "forwarding_available"; roomId: string; kind?: "voice" | "file" | "screen" }
  | ({ type: "update_room"; roomId: string } & Partial<RoomSettings>)
  | { type: "enter_room"; roomId: string; password?: string; inviteKey?: string }
  | { type: "room_invite"; roomId: string }
  | { type: "get_room_invite"; roomId: string }
  | { type: "room_topology"; roomId: string; publicationId?: string }
  | { type: "revoke_room_access"; roomId: string; userId: string }
  | { type: "publish"; publication: { id: string; roomId: string; kind: "screen" | "voice"; videoSettings?: VideoSettings; source?: ScreenSource } }
  | { type: "set_screen_direct_limit"; publicationId: string; limit: number | null }
  | { type: "set_title"; publicationId: string; title: string | null }
  | { type: "unpublish"; publicationId: string }
  | { type: "set_paused"; publicationId: string; paused: boolean }
  | { type: "transfer_source"; publicationId: string; toSessionId: string }
  | { type: "subscribe"; publicationId: string; enabled: boolean; helperSessionId?: string }
  | { type: "voice"; roomId: string; joined: boolean; muted: boolean; deafened: boolean }
  | { type: "signal"; pairId: string; payload: ChannelSignal }
  | { type: "link_state"; pairId: string; state: "connected" | "failed" }
  | { type: "flow_state"; flowId: string; pairId: string; state: "failed" | "forwardable" | "decoded" | "switch_ready" }
  | { type: "base_state"; roomId: string; pairId: string; ready: boolean }
  | { type: "leave" };
export type ChannelRequest = ChannelCommand & { requestId?: string };
