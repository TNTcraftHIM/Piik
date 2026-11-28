import { z } from "zod";
import { productVersionSchema, type ProductVersion } from "./product-version";
import { watchFormatSchema } from "../../shared/watch-format";
export type { WatchFormat } from "../../shared/watch-format";
import { MAX_AUDIO_SEND_BITRATE, MIN_AUDIO_BITRATE, videoSettingsSchema, type VideoSettings } from "../../shared/protocol";
import { DEFAULT_RELAY_CAPACITY, MAX_RELAY_CAPACITY } from "../../shared/relay-capacity";
export { DEFAULT_RELAY_CAPACITY, MAX_RELAY_CAPACITY } from "../../shared/relay-capacity";

// This is the experimental channel wire boundary; production room contracts stay separate.
const utf8 = new TextEncoder();
const MAX_ID_BYTES = 128;
export const id = z.string().min(1).refine(value => value.length <= MAX_ID_BYTES
  && !/\p{Surrogate}/u.test(value) && utf8.encode(value).byteLength <= MAX_ID_BYTES, "Invalid wire ID");
const identityNameSchema = z.string().refine(name => name.length <= 64, "Name exceeds 64 UTF-16 units");
export const IDENTITY_IMAGE_URL_BYTES = 24 * 1024;
export const identityImageSchema = z.string().max(IDENTITY_IMAGE_URL_BYTES)
  .regex(/^data:image\/(?:png|webp);base64,(?=[A-Za-z0-9+/])(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const shortWireKey = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const roomIconSchema = shortWireKey;
export const identityIconSchema = z.union([roomIconSchema, identityImageSchema]);
const signingKey = z.array(z.number().int().min(0).max(255)).length(32);
export const CHANNEL_SESSION_LIMIT = 128;
export const CHANNEL_ROOM_LIMIT = 64;
export const roomCreationPolicySchema = z.enum(["ordinary", "invite_only", "owner_only"]);
export type RoomCreationPolicy = z.infer<typeof roomCreationPolicySchema>;
const signedConversationPacketSchema = z.object({ sender: id, payload: z.string(), signature: z.array(z.number().int().min(0).max(255)).length(64) });
export const roomInvitationSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("missing") }),
  z.object({ state: z.literal("available"), key: id }),
]);
export const MAX_USER_NAME_UNITS = 40;
export const userSummarySchema = z.object({ id, name: z.string().max(MAX_USER_NAME_UNITS), version: z.string().regex(/^[a-f0-9]{64}$/) });
export const userSchema = userSummarySchema.extend({ avatar: identityImageSchema.nullable() });
export const PROFILE_PAGE_SIZE = 32;
export const profilePageSchema = z.object({ profiles: z.array(userSchema).max(PROFILE_PAGE_SIZE), total: z.number().int().nonnegative(), nextCursor: id.nullable() });
export type ProfilePage = z.infer<typeof profilePageSchema>;
export const DEFAULT_ROOM_VOICE_BITRATE = 64_000;
export const roomSchema = z.object({
  id, name: identityNameSchema, icon: roomIconSchema, picture: identityImageSchema.optional(), creatorId: id, access: z.enum(["public", "private"]),
  hidden: z.boolean(), hasPassword: z.boolean(), authorized: z.boolean(), canManage: z.boolean(),
  voiceBitrate: z.number().int().min(MIN_AUDIO_BITRATE).max(MAX_AUDIO_SEND_BITRATE).default(DEFAULT_ROOM_VOICE_BITRATE),
  relayCapacity: z.number().int().min(1).max(MAX_RELAY_CAPACITY).default(DEFAULT_RELAY_CAPACITY),
  relayOverride: z.number().int().min(0).max(MAX_RELAY_CAPACITY).nullable().default(null),
  members: z.array(id).optional(),
  participantSessionIds: z.array(id),
  fileActivity: z.array(z.object({ sessionId: id, sending: z.boolean(), receiving: z.boolean() })).max(CHANNEL_SESSION_LIMIT),
  available: z.boolean(), reading: z.boolean(),
  historyLineage: z.uuid().optional(),
  lastMessageSeq: z.number().int().nonnegative(),
  serviceRelay: z.object({ enabled: z.boolean(), available: z.boolean() }).optional(),
  capabilities: z.object({
    attachments: z.boolean(),
  }),
  fileAvailability: z.object({ observationId: z.uuid(), available: z.array(z.boolean()) }).optional(),
  delivery: z.object({ hostSessionId: id, bindingId: id }).optional(),
});
export const roomSummarySchema = roomSchema.pick({ id: true, name: true, icon: true, creatorId: true, access: true, hidden: true, hasPassword: true, voiceBitrate: true, relayCapacity: true });
export const screenSourceSchema = z.object({ kind: shortWireKey, name: identityNameSchema.nullable() });
export type ScreenSource = z.infer<typeof screenSourceSchema>;
const viewSourceSchema = z.object({ kind: z.enum(["screen", "watch"]), id });
const publicationBaseSchema = z.object({
  id, roomId: id, sessionId: id, userId: id,
  paused: z.boolean(),
  audience: z.array(z.object({ sessionId: id, state: z.enum(["preparing", "active", "failed"]) })).max(CHANNEL_SESSION_LIMIT),
});
export const publicationSchema = z.discriminatedUnion("kind", [
  publicationBaseSchema.extend({ kind: z.literal("screen"), predecessor: viewSourceSchema.optional(), directLimit: z.number().int().min(1).max(MAX_RELAY_CAPACITY).optional(), videoSettings: videoSettingsSchema.optional(), source: screenSourceSchema, title: identityNameSchema.nullable() }),
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
  archivedAuthorName: z.string().max(MAX_USER_NAME_UNITS).optional(),
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
    return value.trim() === value && utf8.encode(value).byteLength <= MAX_WATCH_URL_LENGTH
      && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
});
export const watchSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("media"), url: watchURLSchema }),
  z.object({ kind: z.literal("website"), url: watchURLSchema.optional(), mediaUrl: watchURLSchema.optional() }),
]);
export type WatchSource = z.infer<typeof watchSourceSchema>;
export const watchByteSourceSchema = z.object({ sessionId: z.uuid(), resourceId: z.uuid(), format: watchFormatSchema });
export type WatchByteSource = z.infer<typeof watchByteSourceSchema>;
export type WatchMode = "direct" | "peer";
export const watchBytePlanSchema = z.object({ roomId: id, activityId: z.uuid(), source: watchByteSourceSchema, upstream: z.uuid().nullable(), downstream: z.array(z.uuid()), receiving: z.boolean() });
export type WatchBytePlan = z.infer<typeof watchBytePlanSchema>;
export const watchActivitySchema = z.object({ id, predecessor: viewSourceSchema.optional(), roomId: id, userId: id, sessionId: id, source: watchSourceSchema, playback: watchPlaybackSchema, viewerSessionIds: z.array(id).max(CHANNEL_SESSION_LIMIT), byteSource: watchByteSourceSchema.optional() });
export type WatchActivity = z.infer<typeof watchActivitySchema>;
const flowBindingSchema = z.object({ id, publicationId: id, selected: z.boolean(), inputFlowId: id.nullable(), presentation: z.boolean().optional() });
export const snapshotSchema = z.object({
  channel: z.object({
    id, name: identityNameSchema, icon: identityIconSchema, ownerId: id.nullable(), rooms: z.array(roomSchema).max(CHANNEL_ROOM_LIMIT), historyWindow: z.number().int().positive(), userCount: z.number().int().nonnegative(),
    roomCreationPolicy: roomCreationPolicySchema, askUnnamedMemberName: z.boolean(), hostingMode: z.enum(["lightweight", "hosted"]),
    managedRoomIds: z.array(id).max(CHANNEL_ROOM_LIMIT),
  }),
  users: z.array(userSummarySchema),
  sessions: z.array(z.object({ id, userId: id, online: z.boolean(), signingKey, ...productVersionSchema.shape })).max(CHANNEL_SESSION_LIMIT),
  publications: z.array(publicationSchema),
  voice: z.array(z.object({ sessionId: id, roomId: id, muted: z.boolean(), deafened: z.boolean() })),
  subscriptions: z.array(id),
  watchActivities: z.array(watchActivitySchema),
  watchSubscriptions: z.array(z.object({ id, mode: z.enum(["direct", "peer"]) })),
  watchBytes: z.array(watchBytePlanSchema),
  files: z.array(filePlanSchema),
  pairs: z.array(z.object({ id, peerId: id, canReceiveVideoLayers: z.boolean().default(false), rooms: z.array(id), outgoing: z.array(flowBindingSchema), incoming: z.array(flowBindingSchema) })).max(CHANNEL_SESSION_LIMIT - 1),
  iceServers: z.array(z.object({ urls: z.union([z.string(), z.array(z.string())]), username: z.string().optional(), credential: z.string().optional() })),
});
export const signalSchema = z.object({
  udp: z.never().optional(),
  resync: z.boolean().optional(),
  exchangeId: z.string().uuid().optional(),
  description: z.object({ type: z.enum(["offer", "answer"]), sdp: z.string().max(150000).optional() }).optional(),
  candidate: z.object({ candidate: z.string().max(4096).optional(), sdpMid: z.string().nullable().optional(), sdpMLineIndex: z.number().nullable().optional(), usernameFragment: z.string().nullable().optional(), origin: z.literal("linear").optional() })
    .refine(value => value.origin !== "linear" || !!value.candidate?.trim() && !!value.usernameFragment?.trim()).optional(),
  tracks: z.array(z.object({ flowId: id, streamId: id })).optional(),
}).refine(signal => Boolean(signal.description) === Boolean(signal.exchangeId), { message: "SDP requires an exchange", path: ["exchangeId"] });
const receivedSignalSchema = z.union([
  z.looseObject({ udp: z.unknown() })
    .refine(payload => Object.keys(payload).every(key => key === "udp" || !Object.hasOwn(signalSchema.shape, key)))
    .transform(() => null),
  signalSchema,
]);
export const channelTopologySchema = z.object({
  serviceAvailable: z.boolean(),
  serviceEnabled: z.boolean(),
  bindingId: id,
  transitSession: id.nullable(),
  sessionIds: z.array(id),
  pairs: z.array(z.object({ first: id, second: id, confirmed: z.boolean() })
    .refine(pair => pair.first < pair.second)),
  screen: z.object({ publicationId: id, sourceSessionId: id, edges: z.array(z.object({
    sender: id, receiver: id, selected: z.boolean(), proof: z.enum(["forwardable", "decoded"]).nullable(),
    presented: z.boolean().nullable(), presentation: z.boolean(),
  })) }).nullable(),
});
export type ChannelTopology = z.infer<typeof channelTopologySchema>;
export const channelWelcomeSchema = z.object({ type: z.literal("welcome"), ...productVersionSchema.shape, credential: id, selfProfile: userSchema, sessionId: id, state: snapshotSchema, invitationOrigin: z.string().url().optional() });

const typeHeaderSchema = z.object({ type: z.string() });

export class DomainVersionMismatch extends Error {
  constructor(readonly update: "participant" | "domain") {
    super(update === "participant" ? "Update this Piik client." : "Update the Piik App or Server that hosts this site.");
  }
}

// Check the handshake header before reading the body owned by its major version.
export function checkDomainVersion(raw: unknown, localVersion: ProductVersion): void {
  if (!record(raw) || (raw.type !== "welcome" && raw.type !== "incompatible_version")) return;
  const { major } = productVersionSchema.parse(raw);
  if (major !== localVersion.major)
    throw new DomainVersionMismatch(major > localVersion.major ? "participant" : "domain");
  if (raw.type === "incompatible_version") throw new Error("invalid_response");
}
const replyResultSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("done") }),
  z.object({ type: z.literal("error"), code: z.string() }),
  profilePageSchema.extend({ type: z.literal("profiles") }),
  z.object({ type: z.literal("room_created"), room: roomSummarySchema }),
  z.object({ type: z.literal("watch_ready"), serverTime: z.number().int().nonnegative() }),
  z.object({ type: z.literal("deleted"), dataRemoved: z.boolean() }),
  z.object({ type: z.literal("topology"), topology: channelTopologySchema }),
  z.object({ type: z.literal("invite"), key: id }),
  z.object({ type: z.literal("invite_state"), invitation: roomInvitationSchema }),
  z.object({ type: z.literal("unknown_outcome") }),
]);
const replyResultTypes = new Set<string>(replyResultSchema.options.map(option => option.shape.type.value));
const replySchema = z.object({
  type: z.literal("reply"),
  requestId: id,
  roomId: id.optional(),
  result: typeHeaderSchema.passthrough().transform(result =>
    replyResultTypes.has(result.type) ? result : { type: "unknown_outcome" },
  ).pipe(replyResultSchema),
});
export const eventSchema = z.discriminatedUnion("type", [
  channelWelcomeSchema,
  replySchema,
  z.object({ type: z.literal("conversation"), packet: signedConversationPacketSchema }),
  z.object({ type: z.literal("state"), state: snapshotSchema }),
  z.object({ type: z.literal("input_state"), registrations: z.array(z.object({ publicationId: id, controllerSessionId: id, flowId: id, secret: signingKey })) }),
  z.object({ type: z.literal("host_bound"), roomId: id, bindingId: id }),
  z.object({ type: z.literal("host_input"), roomId: id, input: z.object({ bindingId: id, hostSessionId: id }).passthrough() }),
  z.object({ type: z.literal("signal"), pairId: id, fromSessionId: id, payload: receivedSignalSchema }),
  z.object({ type: z.literal("error"), code: z.string(), roomId: id.optional() }),
]);

export type ChannelSnapshot = z.infer<typeof snapshotSchema>;
export type ChannelPublication = z.infer<typeof publicationSchema>;
export interface MessageReactions { revision: number; counts: Record<string, number> }
export interface MessageReactionSnapshot extends MessageReactions { messageId: string; messageSeq: number }
export interface PublicationReactionSnapshot extends MessageReactions { publicationId: string }
export type ReactionTarget = { type: "message"; messageSeq: number; messageId: string } | { type: "publication"; publicationId: string } | { type: "person"; userId: string };
export interface ReactionEvent { id: string; occurredAt: number; senderUserId: string; target: ReactionTarget; reaction: string }
export type ReactionSnapshot = ({ type: "message" } & MessageReactionSnapshot) | ({ type: "publication" } & PublicationReactionSnapshot);
export type ChannelMessage = z.infer<typeof messageSchema> & { reactions?: MessageReactions };
export type StoredMessage = ChannelMessage & { reactions: MessageReactions };
export interface ChatOptions { mentions?: z.infer<typeof mentionSchema>[]; reply?: { seq: number; messageId: string; notify: boolean } }
export type ChannelAttachment = z.infer<typeof attachmentSchema>;
export type ChannelFileKey = z.infer<typeof fileKeySchema>;
export const fileKeyString = (key: ChannelFileKey) => JSON.stringify([key.roomId, key.messageSeq, key.attachmentId]);
export type ChannelFilePlan = z.infer<typeof filePlanSchema>;
export type ChannelUser = z.infer<typeof userSchema>;
export type ChannelUserSummary = z.infer<typeof userSummarySchema>;
export type ChannelRoom = z.infer<typeof roomSchema>;

export function requireConversationDelivery(
  room: Pick<ChannelRoom, "authorized" | "available" | "delivery"> | undefined,
): NonNullable<ChannelRoom["delivery"]> {
  if (!room) throw new Error("room_unavailable");
  if (!room.authorized) throw new Error("room_access_required");
  if (!room.available) throw new Error("room_host_offline");
  if (!room.delivery) throw new Error("room_unavailable");
  return room.delivery;
}

export type RoomSummary = z.infer<typeof roomSummarySchema>;
export type ChannelPair = ChannelSnapshot["pairs"][number];
export type ChannelSignal = z.infer<typeof signalSchema>;
export type ChannelEvent = z.infer<typeof eventSchema>;

export const CHANNEL_EVENT_BYTES = 4 * 1024 * 1024;
const eventTypes = new Set<string>(eventSchema.options.map(option => option.shape.type.value));
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** One physical socket's last validated snapshot supplies omitted identity pictures. */
export class ChannelEventDecoder {
  private channelId: string | null = null;
  private channelIcon: string | undefined;
  private roomPictures = new Map<string, string>();

  decode(raw: unknown, wireBytes: number): ChannelEvent | undefined {
    if (wireBytes > CHANNEL_EVENT_BYTES) throw new Error("Channel event exceeds frame limit");
    const { type } = typeHeaderSchema.parse(raw);
    if (!eventTypes.has(type)) return;
    if (wireBytes > 1024 * 1024 && record(raw) && type === "reply" && record(raw.result) && raw.result.type === "profiles")
      throw new Error("Profile page exceeds frame limit");
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
export type DomainReplyResult = Extract<ChannelEvent, { type: "reply" }>["result"];
export type ChannelReply = DomainReplyResult | Extract<ConversationReply["record"], { type: "confirmed" | "history_seek_result" }>;
export const HISTORY_INLINE_IMAGES = "inlineImages";
export type SignedConversationPacket = z.infer<typeof signedConversationPacketSchema>;
export type RoomInvitationState = { state: "available"; url: string } | { state: "missing" };
export interface ConversationAddress { roomId: string; bindingId: string; sender: string; recipient: string; requestId: string }
export type ConversationReply = ConversationAddress & { record:
  | { type: "reaction"; nonce: number; event: ReactionEvent | null; snapshot: ReactionSnapshot | null }
  | { type: "interaction_ready"; serverTime: number; reactionIds: string[]; publicationReactions: PublicationReactionSnapshot[] }
  | { type: "confirmed"; message: StoredMessage; inserted: boolean }
  | { type: "live_message"; message: ChannelMessage }
  | { type: "message_deleted"; messageSeq: number }
  | { type: "history_cleared"; throughSeq: number }
  | { type: "room_media_cleared"; throughSeq: number }
  | { type: "history_seek_result"; after: number; seq: number | null }
  | { type: "history_page"; parts?: string[]; messages: StoredMessage[]; hasMore: boolean; oldestSeq: number | null; before: number | null }
  | { type: "error"; code: string }
};
export type ConversationNotice = ConversationAddress & { notice: ConversationReply["record"] };
export type ReceivedRecord =
  | (ConversationReply & { role: "record" })
  | (ConversationNotice & { role: "notice" })
  | (ConversationAddress & { role: "unknown_record" });
export type ReceivedConversation = ReceivedRecord | (ConversationAddress & { role: "command" }) | { role: "ignored" };
export interface DomainSettings { name: string; icon: string; askUnnamedMemberName: boolean }
export interface RoomSettings extends Pick<DomainSettings, "name" | "icon"> {
  picture?: string | null;
  access: "public" | "private"; hidden: boolean; password?: string | null;
  voiceBitrate?: number;
  relayCapacity?: number;
  allowServiceRelay?: boolean;
}
export function createRoomCommand(settings: RoomSettings, creatorId: string, serverHosted: boolean): Extract<ChannelCommand, { type: "create_room" }> {
  const password = settings.access === "private" && settings.password ? settings.password : undefined;
  return {
    type: "create_room",
    room: roomSummarySchema.parse({ ...settings, id: "new", creatorId, hasPassword: Boolean(password) }),
    ...(serverHosted ? { picture: settings.picture ?? undefined, password, allowServiceRelay: settings.allowServiceRelay } : {}),
  };
}

export type ChannelCommand =
  | { type: "start_watch"; replaceId?: string; roomId: string; id: string; source: WatchSource; playback: WatchPlayback; byteSource?: WatchByteSource }
  | { type: "update_watch"; roomId: string; id: string; playback: WatchPlayback }
  | { type: "join_watch"; roomId: string; id: string; mode: WatchMode | null }
  | { type: "set_watch_byte_source"; roomId: string; id: string; byteSource: WatchByteSource | null }
  | { type: "stop_watch"; successorScreenId?: string; roomId: string; id: string }
  | (ProductVersion & { type: "join"; snapshotForm?: "conversation"; canUsePeerTransport?: boolean; name: string; signingKey: number[]; credential?: string; ownerKey?: string; sessionId?: string })
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
  | { type: "host_unsupported"; roomId: string; bindingId: string; revision: number }
  | { type: "host_stop"; roomId: string; bindingId: string }
  | { type: "browse"; roomId: string; active: boolean }
  | { type: "relay_capacity"; roomId: string; capacity: number | null }
  | { type: "interaction_ready"; roomId: string }
  | { type: "react"; roomId: string; reaction: string; target: ReactionTarget; nonce: number }
  | { type: "history_seek"; roomId: string; after: number }
  | { type: "history"; roomId: string; before?: number; parts?: readonly string[] }
  | { type: "delete_message"; roomId: string; messageSeq: number; messageId: string }
  | { type: "clear_history"; roomId: string; throughSeq: number }
  | ({ type: "chat"; roomId: string; text: string; nonce: string; attachments: ChannelAttachment[]; inlineImages?: Record<string, ImageRendition> } & ChatOptions)
  | ({ type: "file_offer"; sha256: string; available: boolean } & ChannelFileKey)
  | ({ type: "file_receive"; enabled: boolean } & ChannelFileKey)
  | { type: "observe_files"; roomId: string; observationId: string; keys: [number, string][] }
  | { type: "byte_branch_refused"; roomId: string; downstreamId: string; target:
      | { kind: "file"; messageSeq: number; attachmentId: string; sourceId: string }
      | { kind: "watch"; activityId: string; source: WatchByteSource } }
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
  | { type: "unpublish"; successorWatchId?: string; publicationId: string }
  | { type: "set_paused"; publicationId: string; paused: boolean }
  | { type: "transfer_source"; publicationId: string; toSessionId: string }
  | { type: "subscribe"; publicationId: string; enabled: boolean; helperSessionId?: string }
  | { type: "voice"; roomId: string; joined: boolean; muted: boolean; deafened: boolean }
  | { type: "signal"; pairId: string; payload: ChannelSignal }
  | { type: "link_state"; pairId: string; state: "connected" | "disconnected" | "failed" }
  | { type: "flow_state"; flowId: string; pairId: string; state: "failed" | "forwardable" | "decoded" | "switch_ready" }
  | { type: "room_data_state"; roomId: string; pairId: string; ready: boolean }
  | { type: "leave" };
export type ProfileUpdate = Omit<Extract<ChannelCommand, { type: "set_profile" }>, "type">;
