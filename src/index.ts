import { Command } from 'commander'
import { join } from 'path'
import { summarize } from './summarize'
import { writeFileSync } from 'fs'
import readline from 'readline'
import Transcribe from './transcribe'

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const realtimeTranscriptionHandler = async (transcribe: Transcribe, summary: boolean) => {
  const stream = transcribe.start()
  stream.pipe(process.stdout)
  /** @todo 実行中 prompt(whisper) を追加/修正可能にする */
  rl.on('line', async (input) => {
    if (!input.length) { /** Enter */
      const summary = await summarize(transcribe.transcripts.join('\n'))
      console.log('\n\nSummary:', summary)
    } else { /** some input then Enter */
      console.log('\n\nUser:', input)
      const summary = await summarize(transcribe.transcripts.join('\n'), input) /** experimental */
      console.log('\n\nAssistant:', summary)
    }
  })
  process.on('SIGINT', async () => { /** Cmd (Ctrl) + C */
    await transcribe.stop()
    if (summary) {
      const summary = await summarize(transcribe.transcripts.splice(-Infinity).join('\n'))
      console.log('\n\nSummary:', summary)
    }
    process.exit(0)
  })
}

const fileTranscriptionHandler = async (transcribe: Transcribe, summary: boolean, input: string, output: string) => {
  const transcript = await transcribe.fromAudioFile(input)
  console.log(`${transcript}\n\n`)
  if (summary) {
    const summary = await summarize(transcript)
    console.log('\n\nSummary:', summary)
  }
  if (output)
    writeFileSync(join(output, `${input}.log`), `${transcript}\n\n${summary}`)
  process.exit(0)
}

const program = new Command()
program
  .option('--prompt <string>', 'Prompt for the transcription.')
  .option('--source <language>', 'ja|en|...', 'ja')
  .option('--summarize', 'Summarize the transcription.')
  .option('--input <path>', 'input file path.')
  .option('--output <path>', 'output dir path.')
program
  .command('transcription', { isDefault: true })
  .description('transcription from real-time or specific audio file.')
  .action(async (_localOpts) => {
    const { input, prompt, source, summarize, output } = program.opts()
    const transcribe = new Transcribe({ prompt, source, output })
    if (!input) {
      await realtimeTranscriptionHandler(transcribe, summarize)
    } else {
      await fileTranscriptionHandler(transcribe, summarize, input, output)
    }
  })
program.parse()
