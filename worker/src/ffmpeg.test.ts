import { test, expect, afterEach } from 'bun:test'
import { centreCrop, h264Args } from './ffmpeg.ts'

test('landscape to 9:16 keeps full height and centres a column', () => {
  expect(centreCrop(1920, 1080, 1080, 1920)).toEqual({ w: 608, h: 1080, x: 656, y: 0 })
})

test('portrait to 16:9 keeps full width and crops rows instead of stretching', () => {
  expect(centreCrop(1080, 1920, 1920, 1080)).toEqual({ w: 1080, h: 608, x: 0, y: 656 })
})

test('same aspect is the whole frame', () => {
  expect(centreCrop(1080, 1080, 1080, 1080)).toEqual({ w: 1080, h: 1080, x: 0, y: 0 })
})

const saved = process.env.VIDEO_ENCODER
afterEach(() => {
  if (saved === undefined) delete process.env.VIDEO_ENCODER
  else process.env.VIDEO_ENCODER = saved
})

test('unset encoder is libx264 -- a CPU box is untouched', () => {
  delete process.env.VIDEO_ENCODER
  expect(h264Args(20)).toEqual(['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'])
})

test('nvenc carries the quality into -cq', () => {
  process.env.VIDEO_ENCODER = 'nvenc'
  const a = h264Args(32)
  expect(a.slice(0, 2)).toEqual(['-c:v', 'h264_nvenc'])
  expect(a[a.indexOf('-cq') + 1]).toBe('32')
  expect(a).toContain('yuv420p')
})
