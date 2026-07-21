'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/ai-calendar';

export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true); setError('');
    try { setData(await api<T>(path)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Unknown error'); }
    finally { setLoading(false); }
  }, [path]);
  useEffect(() => { void load(); }, [load]);
  return { data, setData, loading, error, reload: load };
}
