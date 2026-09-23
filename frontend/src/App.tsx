import type { ComponentType } from 'react'
import { AppShell } from './components/AppShell'
import { ClipPlayer } from './components/ClipPlayer'
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
      {/*
        Dynamic viewport height, not the static one. On mobile browsers 100vh
        is the *large* viewport, so with the URL bar showing, the bottom
        ~60-100px sits underneath it -- and because the body cannot scroll,
        that strip was clipped rather than reachable, which put the Download
        and Save buttons out of reach entirely.
      */}
      <div className="relative flex h-dvh w-full flex-col overflow-hidden">
        {/*
          'booting' renders nothing on purpose: /api/auth/me has not answered, and
          showing either the login screen or the app would be a guess that flashes
          when it turns out wrong.
        */}
        {state.screen === 'login' && <LoginScreen />}
        {/*
          Gated as well as unreachable: openEditor refuses to set this screen
          while the editor is off, but a restored session or a stale state
          should not be able to mount it either.
        */}
        {state.screen === 'editor' && state.user?.features?.editor && <EditorScreen />}
        {Inside && (
          <AppShell>
            <Inside />
          </AppShell>
        )}
        {/*
          Above every screen, so a clip stays watchable whether you got here
          from the results grid or reopened an old project.
        */}
        <ClipPlayer
          clip={snipline.state.clips.find((c) => c.id === state.playingClipId) ?? null}
          ratio={state.filter}
          onClose={snipline.closePlayer}
        />
        {state.toast && <Toast message={state.toast} />}
      </div>
    </AppContext>
  )
}
