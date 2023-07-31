import { AxiosRequestConfig } from 'axios'
import { PassThrough, Readable } from 'stream'
import { path as ffmpegpath } from '@ffmpeg-installer/ffmpeg'
import { path as ffprobepath } from '@ffprobe-installer/ffprobe'
import { randomUUID } from 'crypto'
import client from './client'
import ffmpeg from 'fluent-ffmpeg'
ffmpeg.setFfmpegPath(ffmpegpath)
ffmpeg.setFfprobePath(ffprobepath)

class Transcript {
  private filePath: string
  private prompt?: string
  private source?: string
  private toEng?: boolean
  private whisperConfig: AxiosRequestConfig = {
    maxBodyLength: 25 * 1024 * 1024,
    maxContentLength: 25 * 1024 * 1024,
  }
  constructor(filePath: string, prompt?: string, source?: string, toEng?: boolean) {
    this.filePath = filePath
    this.prompt = prompt
    this.source = source
    this.toEng = toEng
  }

  private toMp3 = async (input_file: string, max_duration_sec = 1800) => {
    const duration_sec = await new Promise<number>((resolve, reject) =>
      ffmpeg.ffprobe(input_file, (err, metadata) => err ? reject(err) : resolve(Number(metadata.format.duration))))
    const times = Math.ceil(duration_sec / max_duration_sec)
    return await Promise.all([...Array(times)].map(async (_, index) =>
      new Promise<Buffer>(async (resolve) => {
        const stream = new PassThrough()
        ffmpeg(input_file)
          .format('mp3')
          .audioBitrate(64)
          .seekInput(duration_sec / times * index)
          .duration(duration_sec / times)
          .pipe(stream)
        const chunks: Buffer[] = []
        stream.on('data', chunk => chunks.push(chunk))
        stream.on('end', () => resolve(Buffer.concat(chunks)))
      })))
  }

  /** @see https://github.com/axios/axios/issues/4888 */
  private transcript = async (buffer: Buffer) => {
    const fileStream = Readable.from(buffer) as any
    const name = `${randomUUID()}.mp3`
    fileStream.lastModified = Date.now()
    fileStream.name = name
    fileStream.webkitRelativePath = name
    const { data: { text } } = this.toEng
      ? await client.createTranslation(fileStream, 'whisper-1', this.prompt, 'json', undefined, this.whisperConfig)
      : await client.createTranscription(fileStream, 'whisper-1', this.prompt, 'json', undefined, this.source, this.whisperConfig)
    return text
  }

  start = async () => {
    const mp3s = await this.toMp3(this.filePath)
    return await Promise.all(mp3s.map(async (mp3) => this.transcript(mp3))).then(texts => texts.join('\n'))
  }
}
export default Transcript
