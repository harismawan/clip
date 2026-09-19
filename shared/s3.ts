/**
 * S3 access, shared by backend (presign, delete) and worker (upload).
 *
 * A factory rather than a module-level singleton because the two services
 * validate their own environments; passing config in keeps this file free of
 * env coupling and trivially testable.
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3'

export interface S3Config {
  endpoint: string
  region: string
  bucket: string
  accessKey: string
  secretKey: string
  forcePathStyle: boolean
}

export function makeS3(cfg: S3Config) {
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
    // MinIO addresses buckets by path; real S3 uses virtual-host style.
    forcePathStyle: cfg.forcePathStyle,
  })

  return {
    client,
    bucket: cfg.bucket,

    async upload(key: string, body: Uint8Array | Buffer, contentType: string) {
      await client.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      )
      return key
    },

    /** Presigned GET. Callers set their own expiry; default one hour. */
    async presign(key: string, expiresIn = 3600) {
      const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner')
      return getSignedUrl(client, new GetObjectCommand({ Bucket: cfg.bucket, Key: key }), {
        expiresIn,
      })
    },

    async getStream(key: string) {
      const res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }))
      return res.Body as NodeJS.ReadableStream
    },

    /** Batch delete. S3 caps DeleteObjects at 1000 keys, so chunk. */
    async deleteMany(keys: string[]) {
      for (let i = 0; i < keys.length; i += 1000) {
        const chunk = keys.slice(i, i + 1000)
        if (chunk.length === 0) continue
        await client.send(
          new DeleteObjectsCommand({
            Bucket: cfg.bucket,
            Delete: { Objects: chunk.map((Key) => ({ Key })) },
          }),
        )
      }
    },
  }
}

export type S3 = ReturnType<typeof makeS3>

/** Object key layout. Kept in one place so backend and worker cannot drift. */
export const keys = {
  render: (jobId: string, clipId: string, ratio: string) =>
    `jobs/${jobId}/clips/${clipId}/${ratio.replace(':', 'x')}.mp4`,
  thumb: (jobId: string, clipId: string, ratio: string) =>
    `jobs/${jobId}/clips/${clipId}/${ratio.replace(':', 'x')}.jpg`,
  srt: (videoId: string) => `transcripts/${videoId}.srt`,
}
