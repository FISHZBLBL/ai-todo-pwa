import serverless from 'serverless-http'
import { app } from './index.js'

const httpHandler = serverless(app)

export async function main(event: any, context: any) {
  return httpHandler(event, context)
}
