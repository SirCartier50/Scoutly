import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Secrets at rest, encrypted by the OS keychain (DPAPI on Windows).
 *
 * Kept out of the SQLite file deliberately: the database is the thing most
 * likely to be copied, backed up, or handed to a support process, and a Gmail
 * app password plus an API key should not ride along with it.
 */

export type SecretKey = 'gmailAppPassword' | 'anthropicApiKey' | 'serverUrl' | 'serverToken'

interface SecretFile {
  /** base64 ciphertext per key, or plaintext when encryption is unavailable. */
  values: Record<string, string>
  encrypted: boolean
}

const FILE = (): string => join(app.getPath('userData'), 'secrets.json')

function read(): SecretFile {
  const path = FILE()
  if (!existsSync(path)) return { values: {}, encrypted: false }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SecretFile
  } catch {
    return { values: {}, encrypted: false }
  }
}

function write(data: SecretFile): void {
  const path = FILE()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 })
}

export function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function setSecret(key: SecretKey, value: string | null): void {
  const data = read()

  if (value === null || value === '') {
    delete data.values[key]
    write(data)
    return
  }

  if (isEncryptionAvailable()) {
    data.values[key] = safeStorage.encryptString(value).toString('base64')
    data.encrypted = true
  } else {
    // Better to store and warn than to silently drop the user's credential.
    data.values[key] = value
    data.encrypted = false
    console.warn('[career-watch] OS encryption unavailable; secrets stored unencrypted')
  }

  write(data)
}

export function getSecret(key: SecretKey): string | null {
  const data = read()
  const raw = data.values[key]
  if (!raw) return null

  if (!data.encrypted) return raw

  try {
    return safeStorage.decryptString(Buffer.from(raw, 'base64'))
  } catch {
    return null
  }
}

export function hasSecret(key: SecretKey): boolean {
  return getSecret(key) !== null
}
