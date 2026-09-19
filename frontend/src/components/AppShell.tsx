import type { ReactNode } from 'react'
import { MobileNav } from './MobileNav'
import { Sidebar } from './Sidebar'

/** The signed-in frame: sidebar plus whichever screen is showing. */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 bg-cream">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileNav />
        {children}
      </div>
    </div>
  )
}
