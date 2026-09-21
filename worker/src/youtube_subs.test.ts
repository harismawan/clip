import { test, expect } from 'bun:test'
import { isYouTubeUrl } from './youtube_subs.ts'

test('isYouTubeUrl checks', () => {
  expect(isYouTubeUrl('https://www.youtube.com/watch?v=xp9EpAJingQ')).toBe(true)
  expect(isYouTubeUrl('https://youtu.be/xp9EpAJingQ')).toBe(true)
  expect(isYouTubeUrl('https://m.youtube.com/watch?v=123')).toBe(true)
  expect(isYouTubeUrl('https://twitch.tv/videos/123')).toBe(false)
  expect(isYouTubeUrl('invalid-url')).toBe(false)
})
