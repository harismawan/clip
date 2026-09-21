import { test, expect, describe } from 'bun:test'
import { parseVttToSegments } from './vtt.ts'

describe('parseVttToSegments', () => {
  test('parses simple cue lines', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.500
Hello world

00:00:04.000 --> 00:00:06.000
Second sentence
`
    const segs = parseVttToSegments(vtt)
    expect(segs).toHaveLength(2)
    expect(segs[0]).toEqual({ start: 1, end: 3.5, text: 'Hello world' })
    expect(segs[1]).toEqual({ start: 4, end: 6, text: 'Second sentence' })
  })

  test('cleans youtube karaoke tags and deduplicates rolling cue lines', () => {
    const vtt = `WEBVTT
Kind: captions
Language: id

00:00:00.120 --> 00:00:02.270 align:start position:0%
 
Hari<00:00:00.280><c> ini</c><00:00:00.440><c> bersama</c><00:00:00.960><c> Tara</c>

00:00:02.270 --> 00:00:02.280 align:start position:0%
Hari ini bersama Tara
 

00:00:02.280 --> 00:00:05.869 align:start position:0%
Hari ini bersama Tara
Terima<00:00:02.520><c> kasih</c><00:00:02.840><c> sudah</c><00:00:03.040><c> mampir</c>
`
    const segs = parseVttToSegments(vtt)
    expect(segs).toHaveLength(2)
    expect(segs[0].text).toBe('Hari ini bersama Tara')
    expect(segs[0].start).toBeCloseTo(0.12, 2)
    expect(segs[0].end).toBeCloseTo(2.27, 2)
    expect(segs[1].text).toBe('Terima kasih sudah mampir')
    expect(segs[1].start).toBeCloseTo(2.28, 2)
    expect(segs[1].end).toBeCloseTo(5.869, 2)
  })
})
