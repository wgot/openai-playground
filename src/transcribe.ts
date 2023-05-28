import { RtAudio, RtAudioFormat, RtAudioStreamFlags } from 'audify'
import { AxiosRequestConfig } from 'axios'
import { createReadStream, writeFileSync } from 'fs'
import { Readable } from 'stream'
import { encode } from 'wav-encoder'
import client from './client'

class Transcribe {
  private data: Buffer[] = []
  private rtAudio: RtAudio
  private interval?: NodeJS.Timer
  private prompt?: string
  private source?: string
  private toEng?: boolean
  private sampleRate?: number
  private whisperConfig: AxiosRequestConfig = {
    maxBodyLength: 25 * 1024 * 1024,
    maxContentLength: 25 * 1024 * 1024,
  }
  constructor(prompt?: string, source?: string, toEng?: boolean) {
    this.rtAudio = new RtAudio()
    const { id, inputChannels, preferredSampleRate } = this.rtAudio.getDevices().find(device => device.isDefaultInput)!
    this.prompt = prompt
    this.source = source
    this.toEng = toEng
    this.sampleRate = preferredSampleRate
    this.rtAudio.openStream(
      null,
      {
        deviceId: id,
        nChannels: inputChannels,
      },
      RtAudioFormat.RTAUDIO_SINT16,
      preferredSampleRate,
      1920,
      new Date().toISOString(),
      (pcm) => {
        this.data.push(pcm)
        return this.rtAudio.write(Buffer.from([]))
      },
      null,
      RtAudioStreamFlags.RTAUDIO_ALSA_USE_DEFAULT,
    )
  }

  /** @see https://github.com/axios/axios/issues/4888 */
  private transcribe = async (stream: any) => {
    const { data: { text } } = this.toEng
      ? await client.createTranslation(stream, 'whisper-1', this.prompt, 'json', undefined, this.whisperConfig)
      : await client.createTranscription(stream, 'whisper-1', this.prompt, 'json', undefined, this.source, this.whisperConfig)
    return text
  }

  private binToWav = async (bin: Buffer) => {
    const float32ArrayData = new Float32Array(bin.length / 2).map((_, index) => bin.readInt16LE(index * 2) / 32768)
    const encoded = await encode({
      sampleRate: this.sampleRate!,
      channelData: [float32ArrayData]
    })
    return encoded
  }

  /** @see https://github.com/openai/openai-node/issues/77#issuecomment-1455247809 */
  private emit = async () => {
    const encoded = await this.binToWav(Buffer.concat(this.data.splice(-Infinity)))
    const fileStream = Readable.from(Buffer.from(encoded))
    // @ts-expect-error
    fileStream.path = `${Date.now()}.wav`
    // writeFileSync(`${Date.now()}.wav`, Buffer.from(encoded))
    const text = await this.transcribe(fileStream)
    console.log(text)
  }

  start = () => {
    this.rtAudio.start()
    this.interval = setInterval(async () => await this.emit(), 30 * 1000)
  }

  stop = () => {
    this.rtAudio.stop()
    clearInterval(this.interval)
    this.interval = undefined
  }

  convert = async (filePath: string) => {
    const text = await this.transcribe(createReadStream(filePath))
    console.log(text)
  }
}
export default Transcribe
