import serverless from 'serverless-http'
import { app } from './index.js'

export const main = serverless(app)
