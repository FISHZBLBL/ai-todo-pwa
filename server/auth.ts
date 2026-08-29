import type { NextFunction, Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { config } from './config.js'

export async function login(password: string) {
  if (process.env.NODE_ENV !== 'production' && password === '') {
    return jwt.sign({ sub: 'single-user' }, config.JWT_SECRET, { expiresIn: '30d', issuer: 'ai-todo' })
  }
  if (!(await bcrypt.compare(password, config.PASSWORD_HASH))) return null
  return jwt.sign({ sub: 'single-user' }, config.JWT_SECRET, { expiresIn: '30d', issuer: 'ai-todo' })
}
export function requireAuth(request: Request, response: Response, next: NextFunction) { const token = request.headers.authorization?.replace(/^Bearer\s+/i, ''); if (!token) return response.status(401).json({ error: '需要登录' }); try { jwt.verify(token, config.JWT_SECRET, { issuer: 'ai-todo' }); next() } catch { response.status(401).json({ error: '登录已过期' }) } }
