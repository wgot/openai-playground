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
  private nChannels!: number
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
    const { name, id, inputChannels, preferredSampleRate } = this.rtAudio.getDevices().find(device => device.isDefaultInput)!
    console.log(`Input Audio Device: ${name}`)
    this.nChannels = inputChannels
    this.sampleRate = preferredSampleRate
    this.rtAudio.openStream(
      null,
      {
        deviceId: id,
        nChannels: this.nChannels,
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
    )
  }

  /** 無音区間を検出する */
  private isSilent = (pcm: Buffer, seconds: number = 3, threshold: number = 0.01) => {
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
    const convertSampleToFloat32 = (bin: Buffer, index: number, channel: number) =>
      bin.readInt16LE((index * this.nChannels + channel) * 2) / 32768
    const getRMS = (data: Float32Array) =>
      Math.sqrt(data.reduce((sum, val) => sum + val * val, 0) / data.length)
    const getAllChannelData = (bin: Buffer): Float32Array[] => {
      const dataLength = bin.length / (2 * this.nChannels)
      return [...Array(this.nChannels)].map((_, channel) =>
        new Float32Array(dataLength).map((_, i) =>
          convertSampleToFloat32(bin, i, channel)
        )
      )
    }
    const allChannelData = getAllChannelData(bin)
    const rmsValues = allChannelData.map(getRMS)
    const maxRMS = Math.max(...rmsValues)
    const normalizedChannelData = allChannelData.map((channelData, index) => {
      const gain = maxRMS / rmsValues[index]
      return channelData.map(sample => sample * gain)
    })
    const dataLength = bin.length / (2 * this.nChannels)
    const monoData = new Float32Array(dataLength).map((_, i) => {
      const sum = normalizedChannelData.reduce((acc, channelData) => acc + channelData.at(i)!, 0)
      return sum / this.nChannels
    })
    const encoded = await encode({
      sampleRate: this.sampleRate,
      channelData: [monoData],
    })
    return encoded
  }

  /** @see https://github.com/openai/openai-node/issues/77#issuecomment-1455247809 */
  private emitTranscription = async (intervalSec: number) => {
    const maxLength = this.sampleRate / this.frameSize * intervalSec
    if (this.tmp.length >= maxLength * 0.8) {
      const encoded = await this.convertRawToWav(Buffer.concat(this.tmp.splice(-Infinity)))
      const stream = Readable.from(Buffer.from(encoded)) as FileStream
      stream.lastModified = this.rtAudio.streamTime
      stream.name = `${stream.lastModified}.wav`
      stream.webkitRelativePath = stream.name
      const text = await this.transcribe(stream)
      this.textStream.push(`${text}\n`)
    }
  }

  private saveAudio = () => new Promise<string>(async resolve => {
    const wav = await this.convertRawToWav(Buffer.concat(this.buffer.splice(-Infinity)))
    const [yyyy, MM, dd, hh, mm] = new Date().toISOString().split(/[-:TZ]/)
    const filePath = join(this.output ?? './.output', `${[yyyy, MM, dd, hh, mm].join('-')}.mp3`)
    ffmpeg(Readable.from(Buffer.from(wav)))
      .format('mp3')
      .audioBitrate(this.mp3Bitrate)
      .saveToFile(filePath)
      .on('end', () => resolve(filePath))
  })

  start = (intervalSec: number = 60) => {
    this.rtAudio.start()
    this.interval = setInterval(async (intervalSec) => await this.emitTranscription(intervalSec), intervalSec * 1000, intervalSec)
    this.textStream.on('data', chunk => this.transcripts.push(`${chunk}\n`))
    return this.textStream
  }

  stop = () => new Promise(resolve => {
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
