// Minimal hand-rolled validators. Each returns the parsed value or throws
// ApiError(400) with a user-facing message.

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError(400, 'request body must be a JSON object')
  }
  return body as Record<string, unknown>
}

export function reqString(value: unknown, field: string, maxLength = 100): string {
  if (typeof value !== 'string') throw new ApiError(400, `${field} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new ApiError(400, `${field} is required`)
  if (trimmed.length > maxLength) throw new ApiError(400, `${field} is too long`)
  return trimmed
}

export function optString(value: unknown, field: string, maxLength = 100): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new ApiError(400, `${field} must be a string`)
  if (value.length > maxLength) throw new ApiError(400, `${field} is too long`)
  return value.trim()
}

export function reqInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ApiError(400, `${field} must be an integer between ${min} and ${max}`)
  }
  return value
}

export function reqBool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new ApiError(400, `${field} must be true or false`)
  return value
}

export function intArray(value: unknown, field: string): number[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'number' || !Number.isInteger(v))) {
    throw new ApiError(400, `${field} must be an array of ids`)
  }
  return value as number[]
}

export function idParam(raw: string | undefined): number {
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, 'invalid id')
  return id
}
