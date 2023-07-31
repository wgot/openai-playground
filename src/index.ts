import { notStrictEqual } from 'assert'
import { summarize } from './summarize'
import Transcribe from './transcribe'
import Transcript from './transcript'

(async ([cmd, arg]) => {
  console.log(cmd, arg)
  switch (cmd) {
    case 'transcript':
      notStrictEqual(arg, undefined)
      const transcript = await new Transcript(arg).start()
      console.log(transcript)
      const summary = await summarize(transcript)
      console.log('summary:', summary)
      break
    case 'transcribe':
      notStrictEqual(arg, undefined)
      new Transcribe(arg, 'ja').start()
      break
    default:
      console.error(cmd, arg)
  }
})(process.argv.slice(2))
