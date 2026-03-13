'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

const SELECTED_CHILD_STORAGE_KEY = 'mashov.selectedChildGuid';

function normalizeSelectedChildGuid(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.includes('/')) return null;
  return trimmed;
}

export function readSelectedChildGuidFromStorage(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const rawValue = window.localStorage.getItem(SELECTED_CHILD_STORAGE_KEY);
    return normalizeSelectedChildGuid(rawValue);
  } catch {
    return null;
  }
}

export function writeSelectedChildGuidToStorage(
  studentGuid: string | null | undefined,
): void {
  if (typeof window === 'undefined') return;

  try {
    const normalizedGuid = normalizeSelectedChildGuid(studentGuid);
    if (!normalizedGuid) {
      window.localStorage.removeItem(SELECTED_CHILD_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(SELECTED_CHILD_STORAGE_KEY, normalizedGuid);
  } catch {
    // No-op when storage is unavailable.
  }
}

interface SelectedChildContextValue {
  selectedChildGuid: string | null;
  setSelectedChildGuid: (studentGuid: string | null | undefined) => void;
  hasHydrated: boolean;
}

const SelectedChildContext = createContext<SelectedChildContextValue | null>(null);

interface SelectedChildProviderProps {
  children: React.ReactNode;
}

export function SelectedChildProvider({ children }: SelectedChildProviderProps) {
  const [selectedChildGuid, setSelectedChildGuidState] = useState<string | null>(null);
  const [hasHydrated, setHasHydrated] = useState(false);

  const setSelectedChildGuid = useCallback((studentGuid: string | null | undefined) => {
    const normalizedGuid = normalizeSelectedChildGuid(studentGuid);
    setSelectedChildGuidState(normalizedGuid);
    writeSelectedChildGuidToStorage(normalizedGuid);
  }, []);

  useEffect(() => {
    setSelectedChildGuidState(readSelectedChildGuidFromStorage());
    setHasHydrated(true);
  }, []);

  useEffect(() => {
    const handleStorageUpdate = (event: StorageEvent) => {
      if (event.key !== SELECTED_CHILD_STORAGE_KEY) return;
      setSelectedChildGuidState(normalizeSelectedChildGuid(event.newValue));
    };

    window.addEventListener('storage', handleStorageUpdate);
    return () => {
      window.removeEventListener('storage', handleStorageUpdate);
    };
  }, []);

  const value = useMemo<SelectedChildContextValue>(
    () => ({
      selectedChildGuid,
      setSelectedChildGuid,
      hasHydrated,
    }),
    [selectedChildGuid, setSelectedChildGuid, hasHydrated],
  );

  return (
    <SelectedChildContext.Provider value={value}>
      {children}
    </SelectedChildContext.Provider>
  );
}

export function useSelectedChild(): SelectedChildContextValue {
  const context = useContext(SelectedChildContext);
  if (!context) {
    throw new Error('useSelectedChild must be used within SelectedChildProvider');
  }
  return context;
}
