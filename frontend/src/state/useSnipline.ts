import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import {
  ALT_TITLES,
  CLIPS,
  FREE_VIDEO_ALLOWANCE,
  LENGTHS,
  RATIOS,
  SOURCES,
  TIMELINE_LEAD_IN,
  TIMELINE_SPAN,
} from '../data/fixtures'
import { loadPersisted, savePersisted } from '../lib/persist'
import type { Clip, Project, Ratio, Screen, SourceKey } from '../types'

/** Smallest trim window, as a percentage of the visible timeline. */
const MIN_TRIM_SPAN = 4

const DEFAULT_TRIM = { trimIn: 22, trimOut: 54, playhead: 34 }

export interface SnipState {
  screen: Screen
  url: string
  source: SourceKey
  count: number
  lengthIdx: number
  formats: Record<Ratio, boolean>
  subs: boolean
  emailMe: boolean
  progress: number
  jobDone: boolean
  videosUsed: number
  /** Finished jobs, newest first. */
  projects: Project[]
  /** Identifies the run in flight, so a regenerate replaces its project. */
  jobId: string
  clips: Clip[]
  filter: Ratio
  sortByScore: boolean
  editing: number | null
  trimIn: number
  trimOut: number
  ratio: string
  playing: boolean
  playhead: number
  regenerating: Record<number, boolean>
  toast: string | null
  captionIdx: number
  pwCurrent: string
  pwNext: string
}

const initialState: SnipState = {
  screen: 'login',
  url: '',
  source: 'stream',
  count: 12,
  lengthIdx: 1,
  formats: { '9:16': true, '1:1': true, '4:5': false },
  subs: true,
  emailMe: true,
  progress: 0,
  jobDone: false,
  videosUsed: 1,
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

function makeClips(n: number): Clip[] {
  return CLIPS.slice(0, n).map((c, i) => ({ ...c, id: i, selected: i < 2 }))
}

/** The format tab results should open on: the first one the job rendered. */
export function firstEnabled(formats: Record<Ratio, boolean>): Ratio {
  return RATIOS.find((r) => formats[r]) ?? RATIOS[0]
}

/** Record a finished job, replacing the earlier run if this was a regenerate. */
export function saveProject(s: SnipState): Project[] {
  const project: Project = {
    id: s.jobId,
    title: SOURCES[s.source].title,
    source: s.source,
    clips: s.clips,
    createdAt: Date.now(),
  }
  return [project, ...s.projects.filter((p) => p.id !== project.id)]
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

/** Reopen where we left off, with the last job's clips back in hand. */
export function restored(): Partial<SnipState> {
  const slice = loadPersisted()
  // The editor needs one clip in particular; come back to the grid instead.
  if (slice.screen === 'editor') slice.screen = 'results'
  const project = slice.projects?.find((p) => p.id === slice.jobId)
  if (project) return { ...slice, clips: project.clips, source: project.source }
  // Without its clips the results grid would come back empty.
  return slice.screen === 'results' ? { ...slice, screen: 'new' } : slice
}

export function useSnipline() {
  const [state, setState] = useState<SnipState>(() => ({ ...initialState, ...restored() }))

  const jobTimer = useRef<number | null>(null)
  const playTimer = useRef<number | null>(null)
  const toastTimer = useRef<number | null>(null)
  const redoTimers = useRef<number[]>([])
  const trackRef = useRef<HTMLDivElement | null>(null)

  const patch = useCallback((next: Partial<SnipState>) => {
    setState((s) => ({ ...s, ...next }))
  }, [])

  useEffect(
    () => () => {
      if (jobTimer.current) clearInterval(jobTimer.current)
      if (playTimer.current) clearInterval(playTimer.current)
      if (toastTimer.current) clearTimeout(toastTimer.current)
      redoTimers.current.forEach(clearTimeout)
    },
    [],
  )

  // Only the durable fields are listed, so playback ticks don't hit storage.
  useEffect(() => {
    savePersisted({
      projects: state.projects,
      jobId: state.jobId,
      videosUsed: state.videosUsed,
      count: state.count,
      lengthIdx: state.lengthIdx,
      formats: state.formats,
      subs: state.subs,
      emailMe: state.emailMe,
      screen: state.screen,
    })
  }, [
    state.projects,
    state.jobId,
    state.videosUsed,
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
    toastTimer.current = window.setTimeout(() => setState((s) => ({ ...s, toast: null })), 2200)
  }, [])

  const stopPlayback = useCallback(() => {
    if (playTimer.current) clearInterval(playTimer.current)
    playTimer.current = null
  }, [])

  const go = useCallback((screen: Screen) => patch({ screen }), [patch])

  // ---- job lifecycle ------------------------------------------------------

  const runJob = useCallback((jobId: string) => {
    if (jobTimer.current) clearInterval(jobTimer.current)
    setState((s) => ({
      ...s,
      screen: 'processing',
      progress: 0,
      jobDone: false,
      jobId,
      filter: firstEnabled(s.formats),
      clips: makeClips(s.count),
    }))
    jobTimer.current = window.setInterval(() => {
      setState((s) => {
        const progress = Math.min(100, s.progress + 2.5)
        if (progress >= 100) {
          if (jobTimer.current) clearInterval(jobTimer.current)
          jobTimer.current = null
          return { ...s, progress: 100, jobDone: true, projects: saveProject(s) }
        }
        return { ...s, progress }
      })
    }, 180)
  }, [])

  const startJob = useCallback(() => {
    if (!RATIOS.some((r) => state.formats[r])) {
      say('Pick at least one format to render.')
      return
    }
    setState((s) => ({ ...s, videosUsed: Math.min(FREE_VIDEO_ALLOWANCE, s.videosUsed + 1) }))
    runJob(crypto.randomUUID())
  }, [runJob, say, state.formats])

  const cancelJob = useCallback(() => {
    if (jobTimer.current) clearInterval(jobTimer.current)
    jobTimer.current = null
    setState((s) => ({
      ...s,
      screen: 'new',
      progress: 0,
      jobDone: false,
      videosUsed: Math.max(0, s.videosUsed - 1),
    }))
    say('Job cancelled. Free video refunded.')
  }, [say])

  const regenerateAll = useCallback(() => {
    say('Regenerating all clips…')
    runJob(state.jobId || crypto.randomUUID())
  }, [runJob, say, state.jobId])

  // ---- navigation ---------------------------------------------------------

  const goResults = useCallback(() => {
    if (state.clips.length) go('results')
    else say('Make some clips first — paste a link.')
  }, [go, say, state.clips.length])

  const signIn = useCallback(() => go('new'), [go])

  const signOut = useCallback(
    () => patch({ screen: 'login', clips: [], progress: 0, jobDone: false }),
    [patch],
  )

  const goNew = useCallback(() => patch({ screen: 'new', url: '' }), [patch])

  /** Reopen a past project with the clips it finished with. */
  const openProject = useCallback(
    (id: string) =>
      setState((s) => {
        const p = s.projects.find((x) => x.id === id)
        if (!p) return s
        return { ...s, source: p.source, clips: p.clips, jobId: p.id, screen: 'results' }
      }),
    [],
  )

  // ---- source picking -----------------------------------------------------

  const setUrl = useCallback((url: string) => patch({ url }), [patch])

  const analyze = useCallback(() => {
    if (!state.url.trim()) {
      say('Paste a link first, or try a sample.')
      return
    }
    patch({ source: /youtu/.test(state.url) ? 'podcast' : 'stream', screen: 'setup' })
  }, [patch, say, state.url])

  const loadSample = useCallback(
    (source: SourceKey) =>
      patch({
        url:
          source === 'podcast'
            ? 'https://youtube.com/watch?v=sample-podcast'
            : 'https://twitch.tv/videos/1904457221',
        source,
        screen: 'setup',
      }),
    [patch],
  )

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
    (id: number) =>
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

  const download = useCallback(() => {
    const n = state.clips.filter((c) => c.selected).length
    if (!n) {
      say('Pick a clip first.')
      return
    }
    say(n === 1 ? 'Saved 1 clip to your device.' : `Saved ${n} clips as a zip.`)
  }, [say, state.clips])

  const redoClip = useCallback(
    (id: number) => {
      setState((s) => ({ ...s, regenerating: { ...s.regenerating, [id]: true } }))
      const timer = window.setTimeout(() => {
        setState((s) => ({
          ...s,
          regenerating: { ...s.regenerating, [id]: false },
          clips: s.clips.map((c) =>
            c.id === id
              ? {
                  ...c,
                  title: ALT_TITLES[id % ALT_TITLES.length],
                  sc: Math.max(35, Math.min(97, c.sc + 5)),
                }
              : c,
          ),
        }))
      }, 1300)
      redoTimers.current.push(timer)
      say('Recutting that moment…')
    },
    [say],
  )

  // ---- editor -------------------------------------------------------------

  const openEditor = useCallback(
    (id: number) =>
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
    say('Caption rewritten.')
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
    say('Clip saved and downloaded.')
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
    say('Password updated.')
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
