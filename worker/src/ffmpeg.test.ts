import { test, expect } from 'bun:test'
import { centreCrop } from './ffmpeg.ts'

test('landscape to 9:16 keeps full height and centres a column', () => {
  expect(centreCrop(1920, 1080, 1080, 1920)).toEqual({ w: 608, h: 1080, x: 656, y: 0 })
})

test('portrait to 16:9 keeps full width and crops rows instead of stretching', () => {
  expect(centreCrop(1080, 1920, 1920, 1080)).toEqual({ w: 1080, h: 608, x: 0, y: 656 })
})

test('same aspect is the whole frame', () => {
  expect(centreCrop(1080, 1080, 1080, 1080)).toEqual({ w: 1080, h: 1080, x: 0, y: 0 })
})
