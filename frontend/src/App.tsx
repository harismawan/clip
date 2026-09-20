import type { ComponentType } from 'react'
import { AppShell } from './components/AppShell'
import { Toast } from './components/Toast'
import { EditorScreen } from './screens/EditorScreen'
import { LoginScreen } from './screens/LoginScreen'
import { NewVideoScreen } from './screens/NewVideoScreen'
import { PlanScreen } from './screens/PlanScreen'
import { ProcessingScreen } from './screens/ProcessingScreen'
import { ProjectsScreen } from './screens/ProjectsScreen'
import { ResultsScreen } from './screens/ResultsScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { SetupScreen } from './screens/SetupScreen'
import { AppContext } from './state/AppContext'
import { useSnipline } from './state/useSnipline'

/** Screens that render inside the signed-in frame, keyed by screen name. */
const INSIDE_SHELL: Partial<Record<string, ComponentType>> = {
  new: NewVideoScreen,
  setup: SetupScreen,
  processing: ProcessingScreen,
  results: ResultsScreen,
  projects: ProjectsScreen,
  plan: PlanScreen,
  settings: SettingsScreen,
}

export default function App() {
  const snipline = useSnipline()
  const { state } = snipline
  const Inside = INSIDE_SHELL[state.screen]

  return (
    <AppContext value={snipline}>
      <div className="relative flex h-screen w-full flex-col overflow-hidden">
        {/*
          'booting' renders nothing on purpose: /api/auth/me has not answered, and
          showing either the login screen or the app would be a guess that flashes
          when it turns out wrong.
        */}
        {state.screen === 'login' && <LoginScreen />}
        {state.screen === 'editor' && <EditorScreen />}
        {Inside && (
          <AppShell>
            <Inside />
          </AppShell>
        )}
        {state.toast && <Toast message={state.toast} />}
      </div>
    </AppContext>
  )
}
