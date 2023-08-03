import { encode } from 'wav-encoder'
import { join } from 'path'
import { path as ffmpegpath } from '@ffmpeg-installer/ffmpeg'
import { path as ffprobepath } from '@ffprobe-installer/ffprobe'
import { Readable, PassThrough } from 'stream'
import { RtAudio, RtAudioFormat, RtAudioStreamFlags } from 'audify'
import { strictEqual } from 'assert'
import client, { whisperPayloadSizeLimit } from './client'
import ffmpeg from 'fluent-ffmpeg'
import tokenizer from 'gpt-tokenizer'
ffmpeg.setFfmpegPath(ffmpegpath)
ffmpeg.setFfprobePath(ffprobepath)
interface FileStream extends PassThrough {
  name?: string
  lastModified?: number
  webkitRelativePath?: string
}
class Transcribe {
  public transcripts: string[] = []
  private tmp: Buffer[] = []
  private buffer: Buffer[] = []
  private rtAudio!: RtAudio
  private sampleRate!: number
  private mp3Bitrate: number = 128
  private frameSize: number = 1920
  private frameVolumes: number[] = []
  private interval?: NodeJS.Timer
  private prompt?: string
  private source?: string
  private toEng?: boolean
  private output?: string
  private textStream: Readable = new PassThrough()
  constructor({ prompt, source, toEng, output }: { prompt?: string, source?: string, toEng?: boolean, output: string }) {
    this.validatePrompt(prompt)
    this.initializeAudioDevice()
    this.prompt = prompt
    this.source = source
    this.toEng = toEng
    this.output = output
  }

  /**
   * The model will only consider the final 224 tokens of the prompt and ignore anything earlier.
   * For multilingual inputs, Whisper uses a custom tokenizer.
   * For English only inputs, it uses the standard GPT-2 tokenizer which are both accessible through the open source Whisper Python package.
   * @see https://platform.openai.com/docs/guides/speech-to-text/longer-inputs
   */
  private validatePrompt = (prompt?: string) =>
    prompt && strictEqual(225 > tokenizer.encode(prompt).length, true, `prompt is too long (${tokenizer.encode(prompt).length} tokens).`)

  /** @see https://github.com/almoghamdani/audify */
  private initializeAudioDevice = () => {
    this.rtAudio = new RtAudio()
    const device = this.rtAudio.getDevices().find(device => device.isDefaultInput)!
    const { id, inputChannels, preferredSampleRate } = device
    this.sampleRate = preferredSampleRate
    this.rtAudio.openStream(
      null,
      {
        deviceId: id,
        nChannels: inputChannels,
      },
      RtAudioFormat.RTAUDIO_SINT16,
      preferredSampleRate,
      this.frameSize,
      new Date().toISOString(),
      (pcm) => { /** `frame per sec = frameSize / preferredSampleRate` ごとに発火 */
        const silence = this.isSilent(pcm)
        if (!silence) {
          this.tmp.push(pcm)
          this.buffer.push(pcm)
        }
        return this.rtAudio.write(Buffer.from([]))
      },
      null,
      RtAudioStreamFlags.RTAUDIO_ALSA_USE_DEFAULT,
    )
  }

  /** 無音区間を検出する */
  private isSilent = (pcm: Buffer, seconds: number = 3, threshold: number = 0.05) => {
    const maxVolume = pcm.reduce((value, _, index, pcm) => {
      if (index % 2 !== 0) return value
      const sample = Buffer.from(pcm.buffer).readInt16LE(index)
      const normalizedSample = sample / (1 << 15) /** max of signed 16bit Int */
      return Math.max(value, Math.abs(normalizedSample))
    }, 0)
    const segments = this.frameVolumes.push(maxVolume)
    const frames = this.sampleRate / this.frameSize * seconds
    if (segments > frames)
      this.frameVolumes.shift()

    // const avgVolume = this.frameVolumes.reduce((total, current) => total + current, 0) / this.frameVolumes.length
    // process.env.DEBUG && console.debug(`Average Volume: ${avgVolume}`)

    return this.frameVolumes.slice(-frames)
      .every((volume) => threshold > volume)
  }

  /**
   * @param temperature `0` is not same as `undefined` (automatically increase)
   * @see https://github.com/axios/axios/issues/4888
   */
  private transcribe = async (stream: FileStream) => {
    const { data: { text } } = this.toEng
      ? await client.createTranslation(stream as unknown as File, 'whisper-1', this.prompt, 'json', undefined)
      : await client.createTranscription(stream as unknown as File, 'whisper-1', this.prompt, 'json', undefined, this.source)
    return text
  }

  /** 音声ファイルを`whisperPayloadSizeLimit`の範囲で分割し`.mp3`に変換する */
  private splitAudioToStreams = async (filePath: string) => {
    const durationSec = await new Promise<number>((resolve, reject) =>
      ffmpeg.ffprobe(filePath, (err, metadata) => err ? reject(err) : resolve(Number(metadata.format.duration))))
    const maxDurationSec = Math.floor(whisperPayloadSizeLimit / (this.mp3Bitrate * 1024 / 8))
    const times = Math.ceil(durationSec / maxDurationSec)
    return [...Array(times)].map((_, index) => {
      const stream: FileStream = new PassThrough()
      stream.lastModified = Date.now()
      stream.name = `${filePath}_${index}.mp3`
      stream.webkitRelativePath = stream.name
      ffmpeg(filePath)
        .format('mp3')
        .audioBitrate(this.mp3Bitrate)
        .seekInput(durationSec / times * index)
        .duration(durationSec / times)
        .stream(stream)
      return stream
    })
  }

  private convertRawToWav = async (bin: Buffer) => {
    const float32ArrayData = new Float32Array(bin.length / 2).map((_, index) => bin.readInt16LE(index * 2) / 32768)
    const encoded = await encode({
      sampleRate: this.sampleRate!,
      channelData: [float32ArrayData]
    })
    return encoded
  }

  /** @see https://github.com/openai/openai-node/issues/77#issuecomment-1455247809 */
  private emitTranscription = async () => {
    if (this.tmp.length > 0) {
      const bin = Buffer.concat(this.tmp.splice(-Infinity))
      const encoded = await this.convertRawToWav(bin)
      const stream = Readable.from(Buffer.from(encoded)) as FileStream
      stream.lastModified = this.rtAudio.streamTime
      stream.name = `${stream.lastModified}.wav`
      stream.webkitRelativePath = stream.name
      const text = await this.transcribe(stream)
      this.textStream.push(`${text}\n`)
    }
  }

  private saveAudio = () => new Promise(async resolve => {
    const wav = await this.convertRawToWav(Buffer.concat(this.buffer.splice(-Infinity)))
    const [yyyy, MM, dd, hh, mm] = new Date().toISOString().split(/[-:TZ]/)
    const filePath = join(this.output ?? './', `${[yyyy, MM, dd, hh, mm].join('-')}.mp3`)
    ffmpeg(Readable.from(Buffer.from(wav)))
      .format('mp3')
      .audioBitrate(this.mp3Bitrate)
      .saveToFile(filePath)
      .on('end', resolve)
  })

  start = () => {
    this.rtAudio.start()
    this.interval = setInterval(async () => await this.emitTranscription(), 30 * 1000)
    this.textStream.on('data', chunk => this.transcripts.push(chunk))
    return this.textStream
  }

  stop = () => new Promise(async resolve => {
    this.rtAudio.stop()
    clearInterval(this.interval)
    this.interval = undefined
    this.textStream.removeAllListeners()
    this.saveAudio().then(resolve)
  })

  fromAudioFile = async (filePath: string) => {
    const streams = await this.splitAudioToStreams(filePath)
    return await Promise.all(streams.map(async (stream) => this.transcribe(stream))).then(texts => texts.join('\n'))
  }
}
export default Transcribe
