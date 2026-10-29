import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, errorMessage } from './api';

/** Loads a GET endpoint, exposes reload(), and signs out on 401. */
export function useApi<T>(path: string, token: string, onUnauthorized: () => void) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setData(await api<T>(path, { token }));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onUnauthorized();
        return;
      }
      setError(errorMessage(err));
    }
  }, [path, token, onUnauthorized]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, reload };
}
