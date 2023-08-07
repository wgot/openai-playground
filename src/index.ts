import { Command } from 'commander'
import { join } from 'path'
import { summarize } from './summarize'
import { Transform } from 'stream'
import { writeFileSync } from 'fs'
import readline from 'readline'
import Transcribe from './transcribe'

const realtimeTranscriptionHandler = async (transcribe: Transcribe) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const stream = transcribe.start()
  const transform = new Transform({ transform(chunk, _, callback) { callback(null, `[${new Date().toISOString()}] ${chunk.toString()}`) } })
  stream
    .pipe(transform)
    .pipe(process.stdout)
  /** @todo 実行中 prompt(whisper) を追加/修正可能にする */
  rl.on('SIGINT', async () => {
    console.log('\nFile Save Processing...')
    const filePath = await transcribe.stop()
    console.log(`\nFile Saved: ${filePath}`)
    process.exit()
  })
  rl.on('line', async (input) => {
    switch (input) {
      case '':
        if (transcribe.transcripts.length > 0) {
          console.log('Summarize..')
          console.log('Summary:', await summarize(transcribe.transcripts.join('\n')))
        }
        break
      default:
        console.log('User:', input)
        console.log('Assistant:', await summarize(transcribe.transcripts.join('\n'), input))
    }
  })
}

const fileTranscriptionHandler = async (transcribe: Transcribe, summary: boolean, input: string, output: string) => {
  const transcript = await transcribe.fromAudioFile(input)
  if (summary) {
    const summary = await summarize(transcript)
    console.log('\nSummary:', summary)
  }
  if (output)
    writeFileSync(join(output, `${input}.log`), `${transcript}\n\n${summary}`)
  process.exit()
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
      await realtimeTranscriptionHandler(transcribe)
    } else {
      await fileTranscriptionHandler(transcribe, summarize, input, output)
    }
  })
program.parse()
