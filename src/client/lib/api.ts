import {
  createRoomResponseSchema,
  type CreateRoomResponse,
  type ViewerAccessPolicy,
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
        : (errorMessage(body) ?? `验证失败 (${response.status})`),
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
        : (errorMessage(body) ?? `验证失败 (${response.status})`),
      response.status,
    );
  }
  return parseSiteAccessStatus(body);
}

export async function createRoom(
  viewerPolicy: ViewerAccessPolicy,
): Promise<CreateRoomResponse> {
  const response = await fetch("/api/rooms", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ viewerPolicy }),
  });

  const body = await responseBody(response);

  if (!response.ok) {
    throw new ApiError(
      response.status === 401
        ? "站点访问已失效，请重新验证"
        : (errorMessage(body) ?? `建房失败 (${response.status})`),
      response.status,
    );
  }

  const parsed = createRoomResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError("建房服务返回的数据格式不正确", 502);
  }
  return parsed.data;
}
