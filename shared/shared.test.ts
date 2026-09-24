import { test, expect, describe } from 'bun:test'
import { fmtDuration, estimateEta, slugify, buildMeta, parseUploadDate, fmtBytes } from './format.ts'
import { stageProgress, isTerminal } from './types.ts'
import { signMedia, verifyMedia, mediaUrl } from './mediaToken.ts'
import { encodeProgress, decodeProgress } from './progress.ts'
import { workerAppName, WORKER_APP_PREFIX } from './queue.ts'

describe('fmtDuration', () => {
  test('matches the prototype fixtures', () => {
    expect(fmtDuration(7104)).toBe('1:58:24')
    expect(fmtDuration(2712)).toBe('45:12')
  })

  test('pads seconds under ten', () => {
    expect(fmtDuration(65)).toBe('1:05')
  })

  test('handles zero and negatives', () => {
    expect(fmtDuration(0)).toBe('0:00')
    expect(fmtDuration(-10)).toBe('0:00')
  })
})

describe('estimateEta', () => {
  test('grows with source duration', () => {
    const short = estimateEta(600)
    const long = estimateEta(7200)
    expect(short).toMatch(/^~/)
    expect(long).not.toBe(short)
  })

  test('switches to hours for a long job', () => {
    expect(estimateEta(36000)).toMatch(/hr/)
  })

  test('never reports less than a minute', () => {
    expect(estimateEta(0, 0)).toBe('~1 min')
  })

  // Rendering is per-clip, so 24 clips is meaningfully slower than 6.
  test('grows with clip count at a fixed duration', () => {
    expect(estimateEta(3600, 24)).not.toBe(estimateEta(3600, 6))
  })
})

describe('slugify', () => {
  // The clip browser reverses this rule; diverging would break that UI.
  test('replaces every non-alphanumeric with an underscore', () => {
    expect(slugify('Hello, World! (2026)')).toBe('Hello__World___2026')
  })

  test('keeps hyphens', () => {
    expect(slugify('a-b-c')).toBe('a-b-c')
  })

  test('caps at 120 characters and trims trailing underscores', () => {
    const out = slugify('x'.repeat(200))
    expect(out.length).toBe(120)
    expect(out.endsWith('_')).toBe(false)
  })
})

describe('buildMeta', () => {
  test('joins present parts with a middot', () => {
    const meta = buildMeta({ uploader: 'channel', publishedAt: null, maxHeight: 1080 })
    expect(meta).toBe('channel · 1080p available')
  })

  test('omits missing parts rather than rendering empties', () => {
    expect(buildMeta({ uploader: null, publishedAt: null, maxHeight: null })).toBe('')
  })
})

describe('parseUploadDate', () => {
  test('parses yt-dlp YYYYMMDD', () => {
    expect(parseUploadDate('20260115')).toBe(Date.UTC(2026, 0, 15))
  })

  test('rejects anything else', () => {
    expect(parseUploadDate('2026-01-15')).toBeNull()
    expect(parseUploadDate(null)).toBeNull()
  })
})

describe('fmtBytes', () => {
  test('scales units', () => {
    expect(fmtBytes(500)).toBe('500 B')
    expect(fmtBytes(1536)).toBe('1.5 KB')
    expect(fmtBytes(5 * 1024 ** 2)).toBe('5.0 MB')
  })
})

describe('stageProgress', () => {
  // These weights must line up with ProcessingScreen's four 24% steps.
  test('maps each stage into its own band', () => {
    expect(stageProgress('downloading', 0)).toBe(0)
    expect(stageProgress('downloading', 1)).toBe(24)
    expect(stageProgress('transcribing', 0)).toBe(24)
    expect(stageProgress('transcribing', 1)).toBe(48)
    expect(stageProgress('rendering', 1)).toBe(96)
  })

  test('never overshoots into the next stage', () => {
    expect(stageProgress('downloading', 5)).toBe(24)
    expect(stageProgress('downloading', -3)).toBe(0)
  })

  test('is monotonic across the pipeline', () => {
    const seq = [
      stageProgress('downloading', 0.5),
      stageProgress('transcribing', 0.5),
      stageProgress('analyzing', 0.5),
      stageProgress('rendering', 0.5),
    ]
    expect(seq).toEqual([...seq].sort((a, b) => a - b))
  })
})

describe('isTerminal', () => {
  test('identifies end states', () => {
    expect(isTerminal('completed')).toBe(true)
    expect(isTerminal('failed')).toBe(true)
    expect(isTerminal('cancelled')).toBe(true)
    expect(isTerminal('rendering')).toBe(false)
  })
})

describe('media tokens', () => {
  const secret = 'a'.repeat(32)
  const claim = {
    clipId: '11111111-1111-1111-1111-111111111111',
    ratio: '9:16',
    kind: 'video' as const,
    exp: Math.floor(Date.now() / 1000) + 600,
  }

  test('a freshly signed claim verifies', () => {
    expect(verifyMedia(secret, claim, signMedia(secret, claim))).toBe(true)
  })

  test('rejects an expired claim', () => {
    const old = { ...claim, exp: Math.floor(Date.now() / 1000) - 10 }
    expect(verifyMedia(secret, old, signMedia(secret, old))).toBe(false)
  })

  test('rejects a signature from a different secret', () => {
    expect(verifyMedia(secret, claim, signMedia('b'.repeat(32), claim))).toBe(false)
  })

  // Without this, one valid link would grant every clip.
  test('a signature does not transfer to another clip', () => {
    const sig = signMedia(secret, claim)
    expect(verifyMedia(secret, { ...claim, clipId: '22222222-2222-2222-2222-222222222222' }, sig)).toBe(false)
  })

  test('a signature does not transfer to another ratio or kind', () => {
    const sig = signMedia(secret, claim)
    expect(verifyMedia(secret, { ...claim, ratio: '1:1' }, sig)).toBe(false)
    expect(verifyMedia(secret, { ...claim, kind: 'thumb' }, sig)).toBe(false)
  })

  test('rejects a garbage signature without throwing', () => {
    expect(verifyMedia(secret, claim, 'nonsense')).toBe(false)
    expect(verifyMedia(secret, claim, '')).toBe(false)
  })

  test('mediaUrl produces a verifiable link and never leaks the token', () => {
    const url = mediaUrl('http://localhost:3014', secret, claim.clipId, '9:16', 'video')
    const parsed = new URL(url)
    expect(parsed.pathname).toBe(`/api/media/${claim.clipId}.mp4`)
    expect(url).not.toContain(secret)

    const ok = verifyMedia(
      secret,
      {
        clipId: claim.clipId,
        ratio: parsed.searchParams.get('ratio')!,
        kind: 'video',
        exp: Number(parsed.searchParams.get('exp')),
      },
      parsed.searchParams.get('sig')!,
    )
    expect(ok).toBe(true)
  })
})

describe('progress encoding', () => {
  test('round-trips', () => {
    const e = { jobId: 'j1', status: 'rendering' as const, stage: 'Rendering 1 of 3', progress: 70, error: null }
    expect(decodeProgress(encodeProgress(e))).toEqual(e)
  })

  // Postgres caps a NOTIFY payload at 8000 bytes; an ffmpeg dump would blow it
  // and stall every connected browser.
  test('truncates a huge error rather than risking the NOTIFY', () => {
    const encoded = encodeProgress({
      jobId: 'j1',
      status: 'failed',
      stage: 'Failed',
      progress: 40,
      error: 'x'.repeat(50_000),
    })
    expect(encoded.length).toBeLessThan(2000)
  })

  test('returns null on malformed input instead of throwing', () => {
    expect(decodeProgress('not json')).toBeNull()
  })
})

/**
 * scripts/workers.sh parses these names back apart, splitting on ':' and taking
 * the last field as the pid. So the pid must survive Postgres's 63-byte cap.
 */
describe('workerAppName', () => {
  test('carries prefix, host and pid', () => {
    expect(workerAppName('box-1', 4242)).toBe(`${WORKER_APP_PREFIX}:box-1:4242`)
  })

  test('truncates the host, never the pid, to fit application_name', () => {
    const name = workerAppName('h'.repeat(100), 4242)
    expect(name.length).toBe(63)
    expect(name.endsWith(':4242')).toBe(true)
  })
})
