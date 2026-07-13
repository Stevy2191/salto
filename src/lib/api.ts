export class ApiRequestError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function api<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    let message = res.statusText
    try {
      const data = (await res.json()) as { error?: string }
      if (data.error) message = data.error
    } catch {
      // non-JSON error body; keep statusText
    }
    throw new ApiRequestError(res.status, message)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export const apiGet = <T>(path: string) => api<T>(path, 'GET')
export const apiPost = <T>(path: string, body?: unknown) => api<T>(path, 'POST', body)
export const apiPut = <T>(path: string, body: unknown) => api<T>(path, 'PUT', body)
export const apiDelete = (path: string) => api<void>(path, 'DELETE')

export const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const
