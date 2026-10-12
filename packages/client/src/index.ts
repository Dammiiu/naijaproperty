/**
 * Typed API client for the Naijaproperty API.
 *
 * Web and mobile both consume the API through this surface rather than calling
 * fetch directly, so contract changes surface as type errors everywhere at
 * once. Auth is cookie-based: the refresh token is an httpOnly cookie the
 * browser attaches automatically, and the short-lived access token is held in
 * memory only.
 */

import type {
  ApiError,
  OtpRequestResponse,
  OtpVerifyResponse,
  SearchQuery,
  SearchQuery as Query,
  UserProfile,
} from '@naijaproperty/contracts';

const BASE_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError['error'],
  ) {
    super(body.message);
    this.name = 'ApiClientError';
  }

  get code(): string {
    return this.body.code;
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  accessToken?: string | null;
  signal?: AbortSignal;
};

let inMemoryAccessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  inMemoryAccessToken = token;
}

export function getAccessToken(): string | null {
  return inMemoryAccessToken;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';

  const token = opts.accessToken ?? inMemoryAccessToken;
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(`${BASE_URL}/api/v1${path}`, {
    method: opts.method ?? 'GET',
    headers,
    credentials: 'include',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const parsed: unknown = text ? JSON.parse(text) : undefined;

  if (!response.ok) {
    const body = (parsed as ApiError | undefined)?.error ?? {
      code: 'INTERNAL_ERROR' as const,
      message: 'Request failed',
    };
    throw new ApiClientError(response.status, body);
  }

  return parsed as T;
}

// --- Auth ------------------------------------------------------------------

export const api = {
  auth: {
    methods: () => request<{ email: boolean; google: boolean; phoneOtp: boolean }>('/auth/methods'),

    register: (body: { email: string; password: string; displayName: string; phone?: string; acceptedTerms: true }) =>
      request<{ user: UserProfile; accessToken: string; expiresInSeconds: number }>('/auth/register', {
        method: 'POST',
        body,
      }),

    login: (body: { email: string; password: string }) =>
      request<{ user: UserProfile; accessToken: string; expiresInSeconds: number }>('/auth/login', {
        method: 'POST',
        body,
      }),

    /**
     * Exchanges the httpOnly refresh cookie for an access token. This is how the
     * app restores a session on page load without a refresh token ever entering
     * JavaScript.
     */
    refresh: () =>
      request<{ user: UserProfile; accessToken: string; expiresInSeconds: number }>('/auth/refresh', {
        method: 'POST',
        body: {},
      }),

    logout: () => request<void>('/auth/logout', { method: 'POST', body: {} }),

    me: (accessToken?: string | null) => request<UserProfile>('/auth/me', { accessToken }),

    /** WhatsApp-first, with SMS automatically following on delivery failure. */
    requestOtp: (body: { phone: string; clientHint?: 'WHATSAPP' | 'SMS' | 'AUTO' }) =>
      request<OtpRequestResponse>('/auth/otp/request', { method: 'POST', body }),

    verifyOtp: (body: { phone: string; code: string }) =>
      request<OtpVerifyResponse>('/auth/otp/verify', { method: 'POST', body }),

    otpChannels: () =>
      request<{ whatsapp: boolean; sms: boolean; fallbackDelaySeconds: number }>('/auth/otp/channels'),

    googleStartUrl: (state?: string) =>
      `${BASE_URL}/api/v1/auth/google/start${state ? `?state=${encodeURIComponent(state)}` : ''}`,
  },

  listings: {
    search: (query: Partial<Query> & { kind: SearchQuery['kind'] }) => {
      const params = new URLSearchParams();
      params.set('kind', query.kind);
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || key === 'kind') continue;
        if (Array.isArray(value)) {
          for (const v of value) params.append(key, String(v));
        } else {
          params.set(key, String(value));
        }
      }
      return request(`/listings/search?${params.toString()}`);
    },
  },
};

export type { Query as SearchQuery };
