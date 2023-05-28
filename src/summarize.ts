import { ChatCompletionRequestMessage } from 'openai'
import { encode, decode } from 'gpt-3-encoder'
import client, { Model, models } from './client'

/**
 * `text`を`max_tokens`単位の文に分割して`prompt[]`を作成する
 * @see https://platform.openai.com/docs/models/gpt-4
 */
export const splitTextIntoPrompts = (text: string, max_tokens: number): string[] => {
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

/**
 * テキストを要約する
 * @see https://platform.openai.com/docs/guides/chat
 * @see https://platform.openai.com/docs/models/gpt-4
 * @see https://platform.openai.com/tokenizer
 */
export const summarize = async (text: string, model: Model = 'gpt-4') => {
  const prompts = splitTextIntoPrompts(text, models[model])
  /** `prompts`を要約する */
  const summaries = await prompts.reduce<Promise<ChatCompletionRequestMessage[]>>(async (promise, content) => {
    /** 直列実行してここまでの要約を文脈として含める */
    return promise.then(async (contents) => {
      try {
        const messages: (typeof contents) = [
          ...contents.filter(content => ['system', 'assistant'].includes(content.role)),
          { role: 'user', content }
        ]
        const { data: { choices: [choice] } } = await client.createChatCompletion({
          model,
          messages,
        })
        return [...contents, choice.message!]
      } catch (error) {
        console.error(JSON.stringify(error, null, 2))
        return contents
      }
    })
    /** @see https://wfhbrian.com/the-best-way-to-summarize-a-paragraph-using-gpt-3/ */
  }, Promise.resolve([{ role: 'system', content: '以下の文章を要約してください:' }]))
  /** 要約結果を抽出する */
  const summary = summaries
    .filter(({ role }) => role === 'assistant')
    .reduce<string>((contents, { content }) => contents.concat(content, '\n'), '')
  return summary
}
