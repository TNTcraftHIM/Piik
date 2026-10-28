import { z } from "zod";

// This is the experimental channel wire boundary; production room contracts stay separate.
const id = z.string().min(1).max(128);
const signingKey = z.array(z.number().int().min(0).max(255)).length(32);
export const userSchema = z.object({ id, name: z.string().max(40), roles: z.array(id).max(16) });
export const roomSchema = z.object({
  id, name: z.string().max(64), creatorId: id, access: z.enum(["public", "private"]),
  hidden: z.boolean(), hasPassword: z.boolean(), authorized: z.boolean(), canManage: z.boolean(),
  members: z.array(id).optional(),
  available: z.boolean(), reading: z.boolean(),
  capabilities: z.object({ attachments: z.boolean() }),
  delivery: z.object({ hostSessionId: id, bindingId: id, nextHops: z.record(id, id) }).optional(),
});
export const publicationSchema = z.object({
  id, roomId: id, sessionId: id, userId: id,
  kind: z.enum(["screen", "voice"]), muted: z.boolean(),
});
export const attachmentSchema = z.object({
  id, name: z.string().min(1).max(240), size: z.number().int().nonnegative().safe(),
  mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp", "application/octet-stream"]),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
});
export const fileKeySchema = z.object({ roomId: id, messageSeq: z.number().int().positive(), attachmentId: id });
export const filePlanSchema = z.object({
  roomId: id, messageSeq: z.number().int().positive(), attachment: attachmentSchema,
  sourceId: id.nullable(), upstream: id.nullable(), downstream: z.array(id), receiving: z.boolean(),
});
export const messageSchema = z.object({
  id, userId: id, text: z.string().max(4000), time: z.number(), seq: z.number().int().positive(), attachments: z.array(attachmentSchema),
});
export const snapshotSchema = z.object({
  channel: z.object({
    id, name: z.string(), ownerId: id.nullable(), rooms: z.array(roomSchema).max(32), historyWindow: z.number().int().positive(),
    roles: z.array(z.object({ id, name: z.string(), permissions: z.array(z.string()) })),
  }),
  users: z.array(userSchema).max(64),
  sessions: z.array(z.object({ id, userId: id, online: z.boolean(), signingKey })).max(20),
  publications: z.array(publicationSchema),
  voice: z.array(z.object({ sessionId: id, roomId: id, muted: z.boolean(), deafened: z.boolean() })),
  subscriptions: z.array(id),
  files: z.array(filePlanSchema),
  pairs: z.array(z.object({ id, peerId: id, rooms: z.array(id), outgoing: z.array(z.object({ id, publicationId: id, selected: z.boolean(), inputFlowId: id.nullable() })), incoming: z.array(z.object({ id, publicationId: id, selected: z.boolean(), inputFlowId: id.nullable() })) })).max(19),
  iceServers: z.array(z.object({ urls: z.union([z.string(), z.array(z.string())]), username: z.string().optional(), credential: z.string().optional() })),
});
export const signalSchema = z.object({
  resync: z.boolean().optional(),
  exchangeId: z.string().uuid().optional(),
  description: z.object({ type: z.enum(["offer", "answer"]), sdp: z.string().max(150000).optional() }).optional(),
  candidate: z.object({ candidate: z.string().max(4096).optional(), sdpMid: z.string().nullable().optional(), sdpMLineIndex: z.number().nullable().optional(), usernameFragment: z.string().nullable().optional() }).optional(),
  tracks: z.array(z.object({ flowId: id, streamId: id })).optional(),
}).refine(signal => Boolean(signal.description) === Boolean(signal.exchangeId), { message: "SDP requires an exchange", path: ["exchangeId"] });
export const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), credential: id, sessionId: id, state: snapshotSchema, inviteKey: id.optional() }),
  z.object({ type: z.literal("state"), state: snapshotSchema }),
  z.object({ type: z.literal("history"), roomId: id, messages: z.array(messageSchema).max(100), hasMore: z.boolean(), before: z.number().optional(), oldestSeq: z.number().nullable() }),
  z.object({ type: z.literal("room_invite"), roomId: id, key: id, requestId: id.optional() }),
  z.object({ type: z.literal("message"), roomId: id, message: messageSchema }),
  z.object({ type: z.literal("message_confirmed"), roomId: id, message: messageSchema, requestId: id.optional() }),
  z.object({ type: z.literal("host_bound"), roomId: id, bindingId: id }),
  z.object({ type: z.literal("host_input"), roomId: id, input: z.object({ bindingId: id }).passthrough() }),
  z.object({ type: z.literal("room_reply"), roomId: id, requestId: id.optional(), result: z.object({ type: z.string(), code: z.string().optional() }).passthrough() }),
  z.object({ type: z.literal("signal"), pairId: id, fromSessionId: id, payload: signalSchema }),
  z.object({ type: z.literal("ack"), requestId: id }),
  z.object({ type: z.literal("error"), code: z.string(), requestId: id.optional() }),
]);

export type ChannelSnapshot = z.infer<typeof snapshotSchema>;
export type ChannelPublication = z.infer<typeof publicationSchema>;
export type ChannelMessage = z.infer<typeof messageSchema>;
export type ChannelAttachment = z.infer<typeof attachmentSchema>;
export type ChannelFileKey = z.infer<typeof fileKeySchema>;
export type ChannelFilePlan = z.infer<typeof filePlanSchema>;
export type ChannelUser = z.infer<typeof userSchema>;
export type ChannelRoom = z.infer<typeof roomSchema>;
export type RoomSummary = Pick<ChannelRoom, "id" | "name" | "creatorId" | "access" | "hidden" | "hasPassword">;
export type ChannelPair = ChannelSnapshot["pairs"][number];
export type ChannelSignal = z.infer<typeof signalSchema>;
export type ChannelEvent = z.infer<typeof eventSchema>;
export type ChannelReply = Extract<ChannelEvent, { type: "room_invite" | "message_confirmed" }>;
export interface SignedConversationPacket { sender: string; payload: string; signature: number[]; remainingHops: number }
export interface ConversationAddress { roomId: string; bindingId: string; sender: string; recipient: string; requestId: string }
export type ConversationReply = ConversationAddress & { record:
  | { type: "confirmed"; message: ChannelMessage; inserted: boolean }
  | { type: "history_message" | "live_message"; message: ChannelMessage }
  | { type: "history_end"; count: number; hasMore: boolean; oldestSeq: number | null; before: number | null }
  | { type: "error"; code: string }
};
export interface RoomSettings {
  name: string; access: "public" | "private"; hidden: boolean; password?: string | null;
}
export type ChannelCommand =
  | { type: "join"; name: string; signingKey: number[]; credential?: string; key?: string; roomId?: string; sessionId?: string }
  | { type: "set_name"; name: string }
  | { type: "host_register"; room: RoomSummary; resumeBinding?: string }
  | { type: "host_output"; roomId: string; output: unknown }
  | { type: "host_stop"; roomId: string; bindingId: string }
  | { type: "browse"; roomId: string; active: boolean }
  | { type: "history"; roomId: string; before?: number }
  | { type: "chat"; roomId: string; text: string; nonce: string; attachments: ChannelAttachment[] }
  | ({ type: "file_offer"; available: boolean } & ChannelFileKey)
  | ({ type: "file_receive"; enabled: boolean } & ChannelFileKey)
  | ({ type: "update_room"; roomId: string } & RoomSettings)
  | { type: "enter_room"; roomId: string; password?: string; inviteKey?: string }
  | { type: "room_invite"; roomId: string }
  | { type: "revoke_room_access"; roomId: string; userId: string }
  | { type: "set_roles"; userId: string; roles: string[] }
  | { type: "publish"; publication: { id: string; roomId: string; kind: "screen" | "voice"; muted: boolean } }
  | { type: "unpublish"; publicationId: string }
  | { type: "subscribe"; publicationId: string; enabled: boolean }
  | { type: "voice"; roomId: string; joined: boolean; muted: boolean; deafened: boolean }
  | { type: "signal"; pairId: string; payload: ChannelSignal }
  | { type: "link_state"; pairId: string; state: "connected" | "failed" }
  | { type: "flow_state"; flowId: string; pairId: string; state: "failed" | "forwardable" | "decoded" | "switch_ready" }
  | { type: "base_state"; roomId: string; pairId: string; ready: boolean }
  | { type: "leave" };
export type ChannelRequest = ChannelCommand & { requestId?: string };
