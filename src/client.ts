import { Configuration, OpenAIApi } from 'openai'
import axios, { AxiosError } from 'axios'

declare module 'axios' {
  export interface AxiosRequestConfig {
    retries?: number
    retryCount?: number
  }
}

export const models = {
  'gpt-3.5-turbo': 4096,
  'gpt-4': 8192,
  'gpt-4-32k': 32768,
}
export type Model = keyof typeof models

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export const whisperPayloadSizeLimit = 25 * 1024 * 1024
const axiosInstance = axios.create({ retries: Infinity, maxBodyLength: whisperPayloadSizeLimit, maxContentLength: whisperPayloadSizeLimit })

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
axiosInstance.interceptors.request.use(request => {
  process.env.DEBUG && console.debug(`\n${new Date().toISOString()} ${request.method?.toUpperCase()} ${request.url}\n`)
  return request
})

const client = new OpenAIApi(new Configuration({ apiKey: process.env.OPENAI_API_KEY }), undefined, axiosInstance)
export default client
