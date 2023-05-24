import type { Config } from '@jest/types'

const config: Config.InitialOptions = {
  verbose: true,
  roots: [
    '<rootDir>/test',
  ],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest'
  },
}
export default config
