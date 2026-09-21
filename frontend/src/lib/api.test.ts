/**
 * The progress stream must survive a dropped connection.
 *
 * An API restart, a laptop waking up or a throttled background tab all kill the
 * EventSource. Before this, `subscribe` closed the socket on the first error and
 * never came back, so a job that finished after the drop was invisible until the
 * user reloaded the page.
 */
import { test, expect, describe } from 'bun:test'
import { retryDelay, subscribe } from './api'
import type { ProgressEvent } from './api'

/** Stands in for the browser's EventSource so the reconnect logic is testable. */
class FakeEventSource {
  static opened: FakeEventSource[] = []
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  url: string

  constructor(url: string) {
    this.url = url
    FakeEventSource.opened.push(this)
  }

  close() {
    this.closed = true
  }

  /** Pretend the server sent a frame. */
  emit(e: Partial<ProgressEvent>) {
    this.onmessage?.({ data: JSON.stringify(e) })
  }

  /** Pretend the connection dropped. */
  drop() {
    this.onerror?.()
  }

  static reset() {
    FakeEventSource.opened = []
  }
}

/** Collects the delays `subscribe` asks to wait, and lets the test run them. */
const fakeClock = () => {
  const pending: Array<() => void> = []
  const delays: number[] = []
  return {
    delays,
    setTimeout: (fn: () => void, ms: number) => {
      delays.push(ms)
      pending.push(fn)
      return pending.length as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: () => {},
    /** Fire every timer queued so far. */
    tick: () => {
      const due = pending.splice(0)
      for (const fn of due) fn()
    },
  }
}

const harness = () => {
  FakeEventSource.reset()
  const clock = fakeClock()
  const events: ProgressEvent[] = []
  let errors = 0
  const stop = subscribe(
    'job-1',
    (e) => events.push(e),
    () => {
      errors++
    },
    {
      open: (url) => new FakeEventSource(url) as unknown as EventSource,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    },
  )
  return { clock, events, stop, errors: () => errors }
}

const latest = () => FakeEventSource.opened[FakeEventSource.opened.length - 1]!

describe('retryDelay', () => {
  test('backs off exponentially', () => {
    expect(retryDelay(0)).toBe(1000)
    expect(retryDelay(1)).toBe(2000)
    expect(retryDelay(2)).toBe(4000)
    expect(retryDelay(3)).toBe(8000)
  })

  test('caps so a long outage still retries promptly', () => {
    expect(retryDelay(4)).toBe(15000)
    expect(retryDelay(50)).toBe(15000)
  })
})

describe('subscribe', () => {
  test('delivers progress frames', () => {
    const h = harness()
    latest().emit({ jobId: 'job-1', status: 'rendering', progress: 62 })
    expect(h.events).toHaveLength(1)
    expect(h.events[0]!.progress).toBe(62)
    h.stop()
  })

  test('ignores keep-alive pings and malformed frames', () => {
    const h = harness()
    latest().onmessage?.({ data: '' })
    latest().onmessage?.({ data: 'not json' })
    expect(h.events).toHaveLength(0)
    expect(latest().closed).toBe(false)
    h.stop()
  })

  test('reopens the stream after a drop', () => {
    const h = harness()
    expect(FakeEventSource.opened).toHaveLength(1)

    latest().drop()
    expect(h.errors()).toBe(1)
    expect(FakeEventSource.opened).toHaveLength(1) // not yet — it waits

    h.clock.tick()
    expect(FakeEventSource.opened).toHaveLength(2)
    expect(h.clock.delays).toEqual([1000])
    h.stop()
  })

  test('a job that finishes after a drop still arrives', () => {
    const h = harness()
    latest().drop()
    h.clock.tick()
    latest().emit({ jobId: 'job-1', status: 'completed', progress: 100 })
    expect(h.events.at(-1)!.status).toBe('completed')
    h.stop()
  })

  test('backs off further on repeated failures', () => {
    const h = harness()
    latest().drop()
    h.clock.tick()
    latest().drop()
    h.clock.tick()
    expect(h.clock.delays).toEqual([1000, 2000])
    h.stop()
  })

  test('a successful frame resets the backoff', () => {
    const h = harness()
    latest().drop()
    h.clock.tick()
    latest().emit({ jobId: 'job-1', status: 'rendering', progress: 10 })
    latest().drop()
    h.clock.tick()
    expect(h.clock.delays).toEqual([1000, 1000])
    h.stop()
  })

  test('unsubscribing stops reconnecting', () => {
    const h = harness()
    h.stop()
    expect(latest().closed).toBe(true)

    latest().drop()
    h.clock.tick()
    expect(FakeEventSource.opened).toHaveLength(1)
  })
})
