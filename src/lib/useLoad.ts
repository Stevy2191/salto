import { useCallback, useEffect, useState } from 'react'

/** Load data from the API with reload support. */
export function useLoad<T>(loader: () => Promise<T>): {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => Promise<void>
} {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    try {
      setData(await loader())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'something went wrong')
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  return { data, error, loading, reload }
}
