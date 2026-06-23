import { useEffect, useState, useCallback, useRef } from 'react'
import { loadAll } from '../lib/sheets.js'

const REFRESH_MS = 5 * 60 * 1000 // 5 minutes

export default function useSheets() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const mounted = useRef(true)

  const fetchData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const next = await loadAll()
      if (!mounted.current) return
      setData(next)
    } catch (e) {
      if (!mounted.current) return
      setError(e.message || String(e))
    } finally {
      if (!mounted.current) return
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    fetchData(false)
    const id = setInterval(() => fetchData(true), REFRESH_MS)
    return () => {
      mounted.current = false
      clearInterval(id)
    }
  }, [fetchData])

  const refresh = useCallback(() => fetchData(true), [fetchData])

  return { data, loading, refreshing, error, refresh }
}
