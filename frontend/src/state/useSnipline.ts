import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { LENGTHS, RATIOS, SAMPLE_URLS, TIMELINE_LEAD_IN, TIMELINE_SPAN } from '../data/fixtures'
import { loadPersisted, savePersisted } from '../lib/persist'
import { api, auth, ApiError, type Me } from '../lib/api'
import type { JobSnapshot } from '../lib/api'
import type { Clip, JobStatus, Project, Ratio, Screen, Source, SourceKey } from '../types'

/** Smallest trim window, as a percentage of the visible timeline. */
const MIN_TRIM_SPAN = 4

const DEFAULT_TRIM = { trimIn: 22, trimOut: 54, playhead: 34 }

/**
 * The action currently in flight, or null.
 *
 * A key rather than a boolean so two async buttons on one screen do not spin
 * together. `openProject` carries its row's id (`openProject:<uuid>`) because the
 * projects list renders one button per project.
 */
export type Pending =
  | null
  | 'analyze'
  | 'startJob'
  | 'cancelJob'
  | 'regenerateAll'
  | 'download'
  | 'signIn'
  | 'signOut'
  | `openProject:${string}`

export interface SnipState {
  screen: Screen
  /** Who is signed in. Null until /api/auth/me answers, and after a logout. */
  user: Me | null
  url: string
  /** The resolved source, once a URL has been analysed. */
  source: Source | null
  count: number
  lengthIdx: number
  formats: Record<Ratio, boolean>
  subs: boolean
  emailMe: boolean
  progress: number
  jobDone: boolean
  /** Server-reported stage text, e.g. "Rendering 3 of 12". */
  stage: string | null
  jobStatus: JobStatus | null
  jobError: string | null
  /**
   * Which action is in flight, as a key the buttons compare against -- not a
   * boolean, because a single flag makes every async button on a screen spin at
   * once (ResultsScreen has two). Per-clip work has its own `regenerating` map.
   */
  pending: Pending
  videosUsed: number
  /** Finished jobs, newest first. Loaded from the server. */
  projects: Project[]
  /** Identifies the run in flight, so a regenerate replaces its project. */
  jobId: string
  clips: Clip[]
  filter: Ratio
  sortByScore: boolean
  editing: string | null
  trimIn: number
  trimOut: number
  ratio: string
  playing: boolean
  playhead: number
  regenerating: Record<string, boolean>
  toast: string | null
  captionIdx: number
  pwCurrent: string
  pwNext: string
}

const initialState: SnipState = {
  screen: 'booting',
  user: null,
  url: '',
  source: null,
  count: 12,
  lengthIdx: 1,
  formats: { '9:16': true, '1:1': true, '4:5': false },
  subs: true,
  emailMe: true,
  progress: 0,
  jobDone: false,
  stage: null,
  jobStatus: null,
  jobError: null,
  pending: null,
  videosUsed: 0,
  projects: [],
  jobId: '',
  clips: [],
  filter: '9:16',
  sortByScore: true,
  editing: null,
  ...DEFAULT_TRIM,
  ratio: '9/16',
  playing: false,
  regenerating: {},
  toast: null,
  captionIdx: 0,
  pwCurrent: '',
  pwNext: '',
}

/** The format tab results should open on: the first one the job rendered. */
export function firstEnabled(formats: Record<Ratio, boolean>): Ratio {
  return RATIOS.find((r) => formats[r]) ?? RATIOS[0]
}

/** The one place the trim window's bounds are enforced. */
export function clampTrim(s: SnipState, which: 'in' | 'out', pct: number): SnipState {
  const v = Math.max(0, Math.min(100, pct))
  if (which === 'in') {
    const trimIn = Math.min(v, s.trimOut - MIN_TRIM_SPAN)
    return { ...s, trimIn, playhead: trimIn }
  }
  return { ...s, trimOut: Math.max(v, s.trimIn + MIN_TRIM_SPAN) }
}

/** The window of source video the editor timeline shows, in seconds. */
export function windowFor(clip: { s: number }) {
  return { start: Math.max(0, clip.s - TIMELINE_LEAD_IN), span: TIMELINE_SPAN }
}

/**
 * Merge a server job snapshot into local state.
 *
 * Selection is UI state the server knows nothing about, so it is preserved
 * across refreshes rather than reset every time the job is re-fetched.
 */
export function mergeJob(s: SnipState, job: JobSnapshot): SnipState {
  const wasSelected = new Set(s.clips.filter((c) => c.selected).map((c) => c.id))
  const firstLoad = s.clips.length === 0

  return {
    ...s,
    jobId: job.id,
    source: job.source,
    count: job.clipCount,
    lengthIdx: job.lengthIdx,
    /**
     * REPLACED, not merged.
     *
     * The job is the only authoritative record of which ratios were actually
     * rendered, and the API sends just those (`routes/jobs.ts` builds it as
     * `Object.fromEntries(enabled.map(r => [r, true]))`), so a missing key means
     * "not rendered" rather than "false".
     *
     * Merging these INTO the setup screen's preferences left ratios enabled that
     * the job never produced -- 1:1 is ticked by default. ResultsScreen renders
     * one tab per enabled format, and on such a tab `clip.renders[ratio]` is
     * undefined, so `thumbUrl` was null and EVERY card fell back to the hatch
     * placeholder instead of showing its thumbnail.
     */
    formats: Object.fromEntries(RATIOS.map((r) => [r, !!job.formats[r]])) as Record<Ratio, boolean>,
    subs: job.subs,
    progress: job.progress,
    stage: job.stage,
    jobStatus: job.status,
    jobError: job.error,
    jobDone: job.status === 'completed',
    filter: firstEnabled(job.formats),
    clips: job.clips.map((c) => ({
      ...c,
      // Default the first two ticked, matching the prototype, but only before
      // the user has made a choice.
      selected: firstLoad ? c.idx < 2 : wasSelected.has(c.id),
    })),
  }
}

/** Reopen where we left off. Clips are re-fetched, never restored from storage. */
export function restored(): Partial<SnipState> {
  const slice = loadPersisted()
  // Neither is a place to come back to: 'booting' would never resolve without a
  // second /me, and 'login' is decided by the session, not by last time.
  if (slice.screen === 'booting' || slice.screen === 'login') delete slice.screen
  // The editor needs one clip in particular; come back to the grid instead.
  if (slice.screen === 'editor') slice.screen = 'results'
  // Without a job to re-fetch, the clip screens would come back empty.
  if ((slice.screen === 'results' || slice.screen === 'processing') && !slice.jobId) {
    slice.screen = 'new'
  }
  return slice
}

export function useSnipline() {
  // Read once. The restored screen is held back until the session is known:
  // applying it immediately would render someone's results before /me answers.
  const [restoredSlice] = useState(restored)
  const [state, setState] = useState<SnipState>(() => ({
    ...initialState,
    ...restoredSlice,
    screen: 'booting',
  }))

  const playTimer = useRef<number | null>(null)
  const toastTimer = useRef<number | null>(null)
  const unsubscribe = useRef<(() => void) | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)

  const patch = useCallback((next: Partial<SnipState>) => {
    setState((s) => ({ ...s, ...next }))
  }, [])

  useEffect(
    () => () => {
      if (playTimer.current) clearInterval(playTimer.current)
      if (toastTimer.current) clearTimeout(toastTimer.current)
      unsubscribe.current?.()
    },
    [],
  )

  // Only durable preferences are stored. Clips and progress come from the
  // server now, so persisting them would just let them go stale.
  useEffect(() => {
    savePersisted({
      jobId: state.jobId,
      count: state.count,
      lengthIdx: state.lengthIdx,
      formats: state.formats,
      subs: state.subs,
      emailMe: state.emailMe,
      screen: state.screen,
    })
  }, [
    state.jobId,
    state.count,
    state.lengthIdx,
    state.formats,
    state.subs,
    state.emailMe,
    state.screen,
  ])

  const say = useCallback((toast: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setState((s) => ({ ...s, toast }))
    toastTimer.current = window.setTimeout(() => setState((s) => ({ ...s, toast: null })), 2600)
  }, [])

  const fail = useCallback(
    (e: unknown) => {
      // A 401 mid-session means the cookie expired or was revoked. Surfacing
      // "Unauthorized" in a toast would leave the app looking broken on a screen
      // whose every action now fails, so go back to the login screen instead.
      if (e instanceof ApiError && e.status === 401) {
        setState((s) => ({ ...s, pending: null, user: null, screen: 'login' }))
        say('Your session expired. Sign in again.')
        return
      }
      const message = e instanceof ApiError ? e.message : 'Something went wrong.'
      setState((s) => ({ ...s, pending: null }))
      say(message)
    },
    [say],
  )

  /**
   * Resolve the session once, then reveal the app. Until this answers the screen
   * is 'booting' and renders nothing.
   */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const me = await auth.me()
        if (cancelled) return
        if (!me) {
          patch({ user: null, screen: 'login' })
          return
        }
        patch({ user: me, screen: restoredSlice.screen ?? 'new' })

        /**
         * Pick the job back up, from the server rather than from storage.
         *
         * This runs whatever screen we land on, because the progress indicator
         * has to work everywhere -- and because the only reliable answer to "am I
         * processing something?" lives on the server. A job started on a phone is
         * absent from this browser's localStorage, and clearing site data loses
         * the id entirely.
         */
        const running = await api.activeJob().catch(() => null)
        if (cancelled) return

        if (running) {
          setState((s) => mergeJob(s, running))
          // Subscribe regardless of screen, so the percentage ticks live in the
          // sidebar and banner rather than sitting frozen until you navigate.
          watchJob(running.id)
        } else if (
          restoredSlice.jobId &&
          (restoredSlice.screen === 'results' || restoredSlice.screen === 'processing')
        ) {
          // Nothing running, but we came back to a clip screen: re-fetch the
          // remembered job so the grid is not empty. (activeJob answers null for
          // a finished job, which is most reloads onto 'results'.)
          await refreshJob(restoredSlice.jobId)
        }
      } catch {
        // The API is unreachable. The login screen is the honest place to land:
        // nothing else in the app can work either.
        if (cancelled) return
        patch({ user: null, screen: 'login' })
        say('Could not reach the server.')
      }
    })()
    return () => {
      cancelled = true
    }
    // Once, on mount. restoredSlice is state and never changes identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const stopPlayback = useCallback(() => {
    if (playTimer.current) clearInterval(playTimer.current)
    playTimer.current = null
  }, [])

  const go = useCallback((screen: Screen) => patch({ screen }), [patch])

  // ---- job lifecycle ------------------------------------------------------

  const refreshJob = useCallback(
    async (jobId: string) => {
      try {
        const job = await api.getJob(jobId)
        setState((s) => mergeJob(s, job))
        return job
      } catch (e) {
        fail(e)
        return null
      }
    },
    [fail],
  )

  const loadProjects = useCallback(async () => {
    try {
      patch({ projects: await api.projects() })
    } catch {
      // The projects list is secondary; a failure here should not shout.
    }
  }, [patch])

  /**
   * Follow a job to completion over SSE.
   *
   * The final clip list is fetched once on the terminal event rather than
   * streamed, because progress frames are tiny and a full job snapshot is not.
   */
  const watchJob = useCallback(
    (jobId: string) => {
      unsubscribe.current?.()
      unsubscribe.current = api.subscribe(
        jobId,
        (e) => {
          setState((s) => ({
            ...s,
            progress: e.progress,
            stage: e.stage,
            jobStatus: e.status,
            jobError: e.error,
          }))

          if (e.status === 'completed') {
            unsubscribe.current?.()
            unsubscribe.current = null
            void refreshJob(jobId).then(() => {
              setState((s) => ({
                ...s,
                jobDone: true,
                /**
                 * Only follow the job to its clips if the user is actually
                 * watching it finish. Now that the progress indicator is visible
                 * on every screen, navigating out from under someone who is
                 * mid-edit in Settings is worse than a badge they can click --
                 * the indicator flips to "Clips ready" and waits for them.
                 */
                screen: s.screen === 'processing' ? 'results' : s.screen,
              }))
              void loadProjects()
            })
          } else if (e.status === 'failed' || e.status === 'cancelled') {
            unsubscribe.current?.()
            unsubscribe.current = null
            setState((s) => ({
              ...s,
              // Same rule: a job ending elsewhere in the app does not move you.
              // On the processing screen, a cancel returns to the start and a
              // failure stays put, because that is where the error text is.
              screen:
                s.screen === 'processing' && e.status === 'cancelled' ? 'new' : s.screen,
            }))
            if (e.status === 'failed') say(e.error ?? 'That job failed.')
          }
        },
        () => {
          // The stream dropped (proxy timeout, server restart). Fall back to a
          // single fetch so the UI cannot sit on a stale bar forever.
          void refreshJob(jobId)
        },
      )
    },
    [refreshJob, loadProjects, say],
  )

  // Resuming after a reload is handled by the boot sequence above, which asks
  // the server for the running job instead of inferring one from the screen the
  // user happened to leave. The screen-gated effect that used to live here never
  // fired for a reload onto Projects or Settings, which is why an in-flight job
  // became invisible the moment you navigated away from it.

  // Needs a session, so it waits for one rather than 401-ing on first paint.
  useEffect(() => {
    if (!state.user) return
    void loadProjects()
  }, [state.user, loadProjects])

  const startJob = useCallback(async () => {
    if (!RATIOS.some((r) => state.formats[r])) {
      say('Pick at least one format to render.')
      return
    }
    if (!state.source) {
      say('Paste a link first.')
      return
    }

    patch({ pending: 'startJob' })
    try {
      const { jobId } = await api.createJob({
        videoId: state.source.videoId,
        count: state.count,
        lengthIdx: state.lengthIdx,
        formats: state.formats,
        subs: state.subs,
      })
      setState((s) => ({
        ...s,
        busy: false,
        screen: 'processing',
        jobId,
        progress: 0,
        stage: 'Queued',
        jobStatus: 'pending',
        jobError: null,
        jobDone: false,
        clips: [],
        filter: firstEnabled(s.formats),
        videosUsed: s.videosUsed + 1,
      }))
      watchJob(jobId)
    } catch (e) {
      fail(e)
    }
  }, [patch, say, fail, watchJob, state.formats, state.source, state.count, state.lengthIdx, state.subs])

  const cancelJob = useCallback(async () => {
    unsubscribe.current?.()
    unsubscribe.current = null
    const id = state.jobId
    setState((s) => ({
      ...s,
      pending: 'cancelJob',
      screen: 'new',
      progress: 0,
      jobDone: false,
      jobStatus: null,
      videosUsed: Math.max(0, s.videosUsed - 1),
    }))
    if (id) await api.cancelJob(id).catch(() => {})
    patch({ pending: null })
    say('Job cancelled.')
  }, [patch, say, state.jobId])

  const regenerateAll = useCallback(async () => {
    if (!state.jobId) return
    patch({ pending: 'regenerateAll' })
    try {
      await api.regenerate(state.jobId)
      setState((s) => ({
        ...s,
        pending: null,
        screen: 'processing',
        progress: 0,
        stage: 'Queued',
        jobStatus: 'pending',
        jobError: null,
        jobDone: false,
        clips: [],
      }))
      watchJob(state.jobId)
      say('Regenerating all clips…')
    } catch (e) {
      fail(e)
    }
  }, [patch, say, fail, watchJob, state.jobId])

  // ---- navigation ---------------------------------------------------------

  const goResults = useCallback(() => {
    if (state.clips.length) go('results')
    else say('Make some clips first — paste a link.')
  }, [go, say, state.clips.length])

  /** Leaves the app for Google's consent screen; the callback brings us back. */
  const signIn = useCallback(() => {
    // Nothing clears this: the browser is leaving the page. It exists so the
    // button reads as busy during the wait for the redirect to take effect.
    patch({ pending: 'signIn' })
    auth.signInWithGoogle()
  }, [patch])

  const signOut = useCallback(async () => {
    unsubscribe.current?.()
    unsubscribe.current = null
    patch({ pending: 'signOut' })
    // Drop the server session first, so the cookie cannot outlive the UI state.
    await auth.logout().catch(() => {
      // Already gone, or the API is down: clear the client either way.
    })
    patch({
      screen: 'login',
      user: null,
      clips: [],
      progress: 0,
      jobDone: false,
      jobId: '',
      projects: [],
    })
  }, [patch])

  const goNew = useCallback(() => patch({ screen: 'new', url: '', source: null }), [patch])

  /** Reopen a past project, re-fetching its clips. */
  const openProject = useCallback(
    async (id: string) => {
      // Keyed by id: the list shows one button per project and only the
      // clicked row should look busy.
      patch({ pending: `openProject:${id}` })
      const job = await refreshJob(id)
      if (job) setState((s) => ({ ...s, pending: null, screen: 'results' }))
      else patch({ pending: null })
    },
    [patch, refreshJob],
  )

  // ---- source picking -----------------------------------------------------

  const setUrl = useCallback((url: string) => patch({ url }), [patch])

  const analyze = useCallback(async () => {
    if (!state.url.trim()) {
      say('Paste a link first, or try a sample.')
      return
    }
    patch({ pending: 'analyze' })
    try {
      const source = await api.analyze(state.url.trim())
      patch({ source, pending: null, screen: 'setup' })
    } catch (e) {
      fail(e)
    }
  }, [patch, say, fail, state.url])

  const loadSample = useCallback((source: SourceKey) => patch({ url: SAMPLE_URLS[source] }), [patch])

  // ---- job settings -------------------------------------------------------

  const setCount = useCallback((count: number) => patch({ count }), [patch])
  const setLengthIdx = useCallback((lengthIdx: number) => patch({ lengthIdx }), [patch])
  const cycleLength = useCallback(
    () => setState((s) => ({ ...s, lengthIdx: (s.lengthIdx + 1) % LENGTHS.length })),
    [],
  )
  const toggleFormat = useCallback(
    (label: Ratio) =>
      setState((s) => ({ ...s, formats: { ...s.formats, [label]: !s.formats[label] } })),
    [],
  )
  const toggleSubs = useCallback(() => setState((s) => ({ ...s, subs: !s.subs })), [])
  const toggleEmail = useCallback(() => setState((s) => ({ ...s, emailMe: !s.emailMe })), [])

  // ---- results ------------------------------------------------------------

  const setFilter = useCallback((filter: Ratio) => patch({ filter }), [patch])
  const toggleSort = useCallback(() => setState((s) => ({ ...s, sortByScore: !s.sortByScore })), [])

  const toggleClip = useCallback(
    (id: string) =>
      setState((s) => ({
        ...s,
        clips: s.clips.map((c) => (c.id === id ? { ...c, selected: !c.selected } : c)),
      })),
    [],
  )

  const toggleSelectAll = useCallback(
    () =>
      setState((s) => {
        const all = s.clips.every((c) => c.selected)
        return { ...s, clips: s.clips.map((c) => ({ ...c, selected: !all })) }
      }),
    [],
  )

  const download = useCallback(async () => {
    const picked = state.clips.filter((c) => c.selected)
    if (!picked.length) {
      say('Pick a clip first.')
      return
    }

    const ready = picked.filter((c) => c.renders[state.filter]?.status === 'ready')
    if (!ready.length) {
      say(`No ${state.filter} clips are ready yet.`)
      return
    }

    say(ready.length === 1 ? 'Downloading…' : `Zipping ${ready.length} clips…`)
    // The toast clears itself after 2.6s, which a multi-clip zip routinely
    // outlives -- the button is what has to stay busy for the real duration.
    patch({ pending: 'download' })
    try {
      await api.download(
        ready.map((c) => c.id),
        state.filter,
        ready[0].renders[state.filter]?.url ?? null,
      )
      patch({ pending: null })
    } catch (e) {
      fail(e)
    }
  }, [patch, say, fail, state.clips, state.filter])

  /**
   * Re-cut one clip. The server re-renders it, so this polls that clip until
   * its status settles rather than guessing at a duration.
   */
  const redoClip = useCallback(
    async (id: string) => {
      setState((s) => ({ ...s, regenerating: { ...s.regenerating, [id]: true } }))
      say('Recutting that moment…')

      try {
        await api.redoClip(id)
      } catch (e) {
        setState((s) => ({ ...s, regenerating: { ...s.regenerating, [id]: false } }))
        fail(e)
        return
      }

      const jobId = state.jobId
      const deadline = Date.now() + 10 * 60_000
      const poll = async () => {
        if (Date.now() > deadline) {
          setState((s) => ({ ...s, regenerating: { ...s.regenerating, [id]: false } }))
          say('That re-cut is taking unusually long; refresh to check.')
          return
        }
        const job = await api.getJob(jobId).catch(() => null)
        const clip = job?.clips.find((c) => c.id === id)
        if (clip && clip.status !== 'pending' && clip.status !== 'rendering') {
          setState((s) => mergeJob({ ...s, regenerating: { ...s.regenerating, [id]: false } }, job!))
          say(clip.status === 'ready' ? 'Clip recut.' : 'That re-cut failed.')
          return
        }
        window.setTimeout(() => void poll(), 3000)
      }
      window.setTimeout(() => void poll(), 3000)
    },
    [say, fail, state.jobId],
  )

  // ---- editor -------------------------------------------------------------

  const openEditor = useCallback(
    (id: string) =>
      patch({ screen: 'editor', editing: id, ...DEFAULT_TRIM, ratio: '9/16', captionIdx: 0 }),
    [patch],
  )

  const setTrim = useCallback((which: 'in' | 'out', value: number) => {
    setState((s) => clampTrim(s, which, value))
  }, [])

  /** Drop an in/out point where the playhead is sitting. */
  const markTrim = useCallback((which: 'in' | 'out') => {
    setState((s) => clampTrim(s, which, s.playhead))
  }, [])

  const beginDrag = useCallback(
    (which: 'in' | 'out') => (e: ReactPointerEvent) => {
      e.preventDefault()
      const el = trackRef.current
      if (!el) return
      const move = (ev: PointerEvent) => {
        const r = el.getBoundingClientRect()
        setTrim(which, ((ev.clientX - r.left) / r.width) * 100)
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      move(e.nativeEvent)
    },
    [setTrim],
  )

  /** Snap the trim window to a transcript line. */
  const pickRange = useCallback(
    (a: number, b: number) =>
      patch({ trimIn: Math.max(0, a), trimOut: Math.min(100, b), playhead: Math.max(0, a) }),
    [patch],
  )

  const resetTrim = useCallback(() => patch(DEFAULT_TRIM), [patch])

  const setRatio = useCallback((ratio: string) => patch({ ratio }), [patch])

  const rewriteCaption = useCallback(() => {
    setState((s) => ({ ...s, captionIdx: s.captionIdx ? 0 : 1 }))
    say('Caption rewritten. (Prototype — not saved.)')
  }, [say])

  const togglePlay = useCallback(() => {
    setState((s) => {
      if (s.playing) {
        stopPlayback()
        return { ...s, playing: false }
      }
      stopPlayback()
      playTimer.current = window.setInterval(() => {
        setState((cur) => {
          const next = cur.playhead + 0.7
          if (next >= cur.trimOut) {
            stopPlayback()
            return { ...cur, playhead: cur.trimIn, playing: false }
          }
          return { ...cur, playhead: next }
        })
      }, 90)
      return { ...s, playing: true, playhead: s.trimIn }
    })
  }, [stopPlayback])

  const backToResults = useCallback(() => {
    stopPlayback()
    patch({ screen: 'results', playing: false })
  }, [patch, stopPlayback])

  const saveAndDownload = useCallback(() => {
    stopPlayback()
    patch({ screen: 'results', playing: false })
    say('Editor edits are not saved yet — download from the grid.')
  }, [patch, say, stopPlayback])

  // ---- settings -----------------------------------------------------------

  const setPwCurrent = useCallback((pwCurrent: string) => patch({ pwCurrent }), [patch])
  const setPwNext = useCallback((pwNext: string) => patch({ pwNext }), [patch])

  const updatePassword = useCallback(() => {
    if (!state.pwCurrent) {
      say('Enter your current password.')
      return
    }
    if (state.pwNext.length < 8) {
      say('New password needs 8 characters.')
      return
    }
    patch({ pwCurrent: '', pwNext: '' })
    say('Accounts are not implemented yet.')
  }, [patch, say, state.pwCurrent, state.pwNext])

  return {
    state,
    trackRef,
    say,
    go,
    signIn,
    signOut,
    goNew,
    goResults,
    openProject,
    setUrl,
    analyze,
    loadSample,
    setCount,
    setLengthIdx,
    cycleLength,
    toggleFormat,
    toggleSubs,
    toggleEmail,
    startJob,
    cancelJob,
    regenerateAll,
    setFilter,
    toggleSort,
    toggleClip,
    toggleSelectAll,
    download,
    redoClip,
    openEditor,
    setTrim,
    markTrim,
    beginDrag,
    pickRange,
    resetTrim,
    setRatio,
    rewriteCaption,
    togglePlay,
    backToResults,
    saveAndDownload,
    setPwCurrent,
    setPwNext,
    updatePassword,
  }
}

export type Snipline = ReturnType<typeof useSnipline>
