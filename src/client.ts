import { Configuration, OpenAIApi } from 'openai'
import axios, { AxiosError } from 'axios'
import { encode, decode } from 'gpt-3-encoder'

declare module 'axios' {
  export interface AxiosRequestConfig {
    retries?: number
    retryCount?: number
  }
}

/**
 * `text`を`max_tokens`単位の文に分割して`prompt[]`を作成する
 * @see https://platform.openai.com/docs/models/gpt-4
 */
export const splitTextIntoPrompts = (text: string, max_tokens: number = 8192): string[] => {
  const tokens = text.split(/(?<=[。！？.!?])/)
    .flatMap((sentence, index) => index === 0 && encode(sentence).length > max_tokens ? sentence.split(' ').map(s => s.concat(' ')) : sentence) /** 分割に失敗した場合のケア */
    .map(sentence => encode(sentence))
    .reduce<number[][]>((tokens, token) => {
      const prompt = tokens.splice(-1)[0]
      return max_tokens > prompt.length + token.length
        ? [...tokens, [...prompt, ...token]]
        : [...tokens, prompt, token]
    }, [[]])
  return tokens.map(token => decode(token))
}
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const whisperPayloadSizeLimit = 25 * 1024 * 1024
const axiosInstance = axios.create({ retries: 3, maxBodyLength: whisperPayloadSizeLimit, maxContentLength: whisperPayloadSizeLimit })

axiosInstance.interceptors.response.use(response => response, async (error: AxiosError) => {
  const request = error.config
  request.retryCount ??= 0
  request.retries ??= 0
  if (request.retryCount < request.retries) {
    if (error.response && error.response.status >= 500) {
      request.retryCount += 1
      await sleep(request.retryCount * 1000)
      return axiosInstance(request)
    }
  }
  return Promise.reject(error)
})

const client = new OpenAIApi(new Configuration({ apiKey: process.env.OPENAI_API_KEY }), undefined, axiosInstance)
export default client
