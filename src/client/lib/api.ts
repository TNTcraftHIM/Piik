import {
  createRoomResponseSchema,
  type CreateRoomResponse,
} from "../../shared/protocol";

function errorMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.message === "string") {
    return record.message;
  }
  if (typeof record.error === "string") {
    return record.error;
  }
  if (record.error && typeof record.error === "object") {
    const nested = record.error as Record<string, unknown>;
    return typeof nested.message === "string" ? nested.message : null;
  }
  return null;
}

export async function createRoom(
  creationToken: string,
): Promise<CreateRoomResponse> {
  const headers = new Headers({ Accept: "application/json" });
  const trimmedToken = creationToken.trim();
  if (trimmedToken) {
    headers.set("Authorization", `Bearer ${trimmedToken}`);
  }

  const response = await fetch("/api/rooms", {
    method: "POST",
    headers,
  });

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("建房服务返回了无法识别的响应");
  }

  if (!response.ok) {
    throw new Error(errorMessage(body) ?? `建房失败 (${response.status})`);
  }

  const parsed = createRoomResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("建房服务返回的数据格式不正确");
  }
  return parsed.data;
}
