import { createContext, use } from 'react'
import type { Snipline } from './useSnipline'

export const AppContext = createContext<Snipline | null>(null)

export function useApp(): Snipline {
  const ctx = use(AppContext)
  if (!ctx) throw new Error('useApp must be used inside <AppContext>')
  return ctx
}
