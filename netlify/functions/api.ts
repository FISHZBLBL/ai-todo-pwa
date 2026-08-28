import type { Config } from '@netlify/functions'
import { withLambda } from '@netlify/aws-lambda-compat'
import serverless from 'serverless-http'
import { app } from '../../server/index.js'

export default withLambda(serverless(app) as unknown as Parameters<typeof withLambda>[0])

export const config: Config = {
  path: '/api/*'
}
