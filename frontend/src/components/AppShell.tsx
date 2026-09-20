import type { ReactNode } from 'react'
import { jobIndicator } from '../lib/derive'
import { useApp } from '../state/AppContext'
import { JobIndicator } from './JobIndicator'
import { MobileNav } from './MobileNav'
import { Sidebar } from './Sidebar'

/** The signed-in frame: sidebar plus whichever screen is showing. */
export function AppShell({ children }: { children: ReactNode }) {
  const { state, go } = useApp()
  const job = jobIndicator(state)

  return (
    <div className="flex min-h-0 flex-1 bg-cream">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileNav />
        {/*
          Above the screen content rather than inside it, so a job stays visible
          while you move around. It renders nothing when there is no job, and on
          the processing screen itself -- where the full progress view already
          says everything it would.
        */}
        {state.screen !== 'processing' && (
          <JobIndicator indicator={job} variant="banner" onOpen={() => go(job.target)} />
        )}
        {children}
      </div>
    </div>
  )
}
