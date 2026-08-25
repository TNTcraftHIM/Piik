import {
  createRoomResponseSchema,
  roomAccessUpdateResponseSchema,
  type CreateRoomResponse,
  type CodeEntryPolicy,
  type RoomAccessUpdateRequest,
  type RoomAccessUpdateResponse,
} from "../../shared/protocol";

export interface SiteAccessStatus {
  required: boolean;
  authenticated: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function responseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ApiError("服务返回了无法识别的响应", response.status);
  }
}

function parseSiteAccessStatus(value: unknown): SiteAccessStatus {
  if (!value || typeof value !== "object") {
    throw new ApiError("验证服务返回的数据格式不正确", 502);
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.required !== "boolean" ||
    typeof record.authenticated !== "boolean"
  ) {
    throw new ApiError("验证服务返回的数据格式不正确", 502);
  }
  return {
    required: record.required,
    authenticated: record.authenticated,
  };
}

export async function getSiteAccess(): Promise<SiteAccessStatus> {
  const response = await fetch("/api/site-access", {
    headers: { Accept: "application/json" },
  });
  const body = await responseBody(response);
  if (!response.ok) {
    throw new ApiError(
      response.status === 401
        ? "站点访问已失效，请重新验证"
        : `站点验证服务暂时不可用 (${response.status})`,
      response.status,
    );
  }
  return parseSiteAccessStatus(body);
}

export async function authenticateSiteAccess(
  password: string,
): Promise<SiteAccessStatus> {
  const response = await fetch("/api/site-access", {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${password.trim()}`,
    },
  });
  const body = await responseBody(response);
  if (!response.ok) {
    throw new ApiError(
      response.status === 401
        ? "站点口令不正确，请重试"
        : `站点验证服务暂时不可用 (${response.status})`,
      response.status,
    );
  }
  return parseSiteAccessStatus(body);
}

export async function createRoom(
  codeEntryPolicy: CodeEntryPolicy,
  roomPassword: string | null,
  preferredRoomId: string | null = null,
): Promise<CreateRoomResponse> {
  const response = await fetch("/api/rooms", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      codeEntryPolicy,
      ...(roomPassword === null ? {} : { roomPassword }),
      ...(preferredRoomId === null ? {} : { preferredRoomId }),
    }),
  });

  const body = await responseBody(response);

  if (!response.ok) {
    throw new ApiError(
      response.status === 401
        ? "站点访问已失效，请重新验证"
        : `当前无法创建房间 (${response.status})`,
      response.status,
    );
  }

  const parsed = createRoomResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError("建房服务返回的数据格式不正确", 502);
  }
  return parsed.data;
}

export async function updateRoomAccess(
  roomId: string,
  hostToken: string,
  request: RoomAccessUpdateRequest,
): Promise<RoomAccessUpdateResponse> {
  const response = await fetch(`/api/rooms/${roomId}/access`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${hostToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });
  const body = await responseBody(response);
  if (!response.ok) {
    throw new ApiError(
      response.status === 401
        ? "站点访问已失效，请重新验证"
        : response.status === 404
          ? "房间不存在或已过期"
          : `当前无法更新房间设置 (${response.status})`,
      response.status,
    );
  }

  const parsed = roomAccessUpdateResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError("房间设置服务返回的数据格式不正确", 502);
  }
  return parsed.data;
}
