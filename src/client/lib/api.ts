import {
  createRoomResponseSchema,
  type CreateRoomResponse,
} from "../../shared/protocol";

export interface SessionStatus {
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

function parseSessionStatus(value: unknown): SessionStatus {
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

export async function getSession(): Promise<SessionStatus> {
  const response = await fetch("/api/session", {
    headers: { Accept: "application/json" },
  });
  const body = await responseBody(response);
  if (!response.ok) {
    throw new ApiError(
      response.status === 401
        ? "验证已失效，请重新登录"
        : (errorMessage(body) ?? `验证失败 (${response.status})`),
      response.status,
    );
  }
  return parseSessionStatus(body);
}

export async function authenticate(
  password: string,
): Promise<SessionStatus> {
  const response = await fetch("/api/session", {
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
        ? "访问密码不正确，请重试"
        : (errorMessage(body) ?? `验证失败 (${response.status})`),
      response.status,
    );
  }
  return parseSessionStatus(body);
}

export async function createRoom(): Promise<CreateRoomResponse> {
  const response = await fetch("/api/rooms", {
    method: "POST",
    headers: { Accept: "application/json" },
  });

  const body = await responseBody(response);

  if (!response.ok) {
    throw new ApiError(
      response.status === 401
        ? "验证已失效，请重新登录"
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
