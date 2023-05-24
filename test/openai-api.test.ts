import client from '../src/client'

describe('OpenAI APIを使用できる', () => {
  test('有効な`process.env.OPENAI_API_KEY`を使用できる', async () => {
    const { status } = await client.listModels()
    expect(status).toBe(200)
  })
  test('MODEL:`GPT-4`を使用できる', async () => {
    const { data: { data } } = await client.listModels()
    const model = data.find(({ id }) => id === 'gpt-4')
    expect(model?.id).toBe('gpt-4')
  })
})
