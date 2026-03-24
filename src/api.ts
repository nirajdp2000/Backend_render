export class ApiError extends Error {
  status: number;
  payload: unknown;

  constructor(message: string, status: number, payload?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

const extractMessage = (payload: unknown, status: number) => {
  if (typeof payload === 'string') {
    return payload.trim() || `Request failed with status ${status}`;
  }

  if (payload && typeof payload === 'object') {
    const candidate = payload as {
      error?: string;
      message?: string;
      errors?: Array<{ message?: string }>;
    };

    return (
      candidate.error ||
      candidate.message ||
      candidate.errors?.[0]?.message ||
      `Request failed with status ${status}`
    );
  }

  return `Request failed with status ${status}`;
};

export async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    throw new ApiError(extractMessage(payload, response.status), response.status, payload);
  }

  return payload as T;
}
