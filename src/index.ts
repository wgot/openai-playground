import Transcribe from './transcribe'

(async ([cmd, arg]) => {
  console.log(cmd, arg)
  switch (cmd) {
    case 'transcribe':
      new Transcribe(arg, 'ja').start()
      break
    default:
      console.error(cmd, arg)
  }
})(process.argv.slice(2))
