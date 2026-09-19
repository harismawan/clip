import { makeS3 } from '../../shared/s3.ts'
import { env } from './env.ts'

export const s3 = makeS3({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  bucket: env.S3_BUCKET,
  accessKey: env.S3_ACCESS_KEY,
  secretKey: env.S3_SECRET_KEY,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
})

export { keys } from '../../shared/s3.ts'
