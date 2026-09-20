import { test, expect, describe } from 'bun:test'
import { jobIndicator } from './derive'

/**
 * The one place that decides whether "a video is being processed" is worth
 * showing, and what it says. Both the sidebar entry and the banner read this, so
 * they cannot drift apart.
 */
describe('jobIndicator', () => {
  const active = { jobId: 'job-1', jobStatus: 'transcribing' as const, stage: 'Transcribing (12m of 48m)', progress: 42 }

  test('nothing to show when no job has ever run', () => {
    expect(jobIndicator({ jobId: '', jobStatus: null, stage: null, progress: 0 }).visible).toBe(false)
  })

  test('a running job is visible', () => {
    expect(jobIndicator(active).visible).toBe(true)
  })

  test("it reports the server's stage text, not a generic word", () => {
    expect(jobIndicator(active).label).toBe('Transcribing (12m of 48m)')
  })

  test('it falls back to a generic label before the first stage arrives', () => {
    const fresh = { jobId: 'job-1', jobStatus: 'pending' as const, stage: null, progress: 0 }
    expect(jobIndicator(fresh).label).toBe('Processing…')
  })

  test('it carries the percentage for the bar', () => {
    expect(jobIndicator(active).percent).toBe(42)
  })

  test('clicking a running job goes to the progress screen', () => {
    expect(jobIndicator(active).target).toBe('processing')
  })

  test('every mid-pipeline status counts as running', () => {
    for (const jobStatus of ['pending', 'downloading', 'transcribing', 'analyzing', 'rendering'] as const) {
      const out = jobIndicator({ ...active, jobStatus })
      expect(out.visible).toBe(true)
      expect(out.tone).toBe('active')
    }
  })

  test('a finished job flips to a done state rather than vanishing', () => {
    const out = jobIndicator({ ...active, jobStatus: 'completed', progress: 100 })
    expect(out.visible).toBe(true)
    expect(out.tone).toBe('done')
    expect(out.label).toBe('Clips ready')
  })

  test('a finished job sends you to the clips, not back to the progress screen', () => {
    expect(jobIndicator({ ...active, jobStatus: 'completed' }).target).toBe('results')
  })

  test('a done state always reads 100%, even if the last frame missed', () => {
    expect(jobIndicator({ ...active, jobStatus: 'completed', progress: 97 }).percent).toBe(100)
  })

  test('a failed job stays visible -- silently vanishing loses a 40-minute failure', () => {
    const out = jobIndicator({ ...active, jobStatus: 'failed' })
    expect(out.visible).toBe(true)
    expect(out.tone).toBe('failed')
    expect(out.label).toBe('Job failed')
    // The processing screen is where the error text lives.
    expect(out.target).toBe('processing')
  })

  test('a job the user cancelled is not worth reporting', () => {
    expect(jobIndicator({ ...active, jobStatus: 'cancelled' }).visible).toBe(false)
  })

  test('percentage is clamped, so a bad frame cannot overflow the bar', () => {
    expect(jobIndicator({ ...active, progress: 140 }).percent).toBe(100)
    expect(jobIndicator({ ...active, progress: -5 }).percent).toBe(0)
  })
})
