/// <reference types="vite/client" />
import type { IpcApi } from '@shared/ipc'

declare global {
  interface Window {
    api: IpcApi & {
      onRunFinished(cb: () => void): () => void
      onRunStarted(cb: () => void): () => void
    }
  }
}

export {}
