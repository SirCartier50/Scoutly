/// <reference types="vite/client" />
import type { IpcApi, UpdateStatus } from '@shared/ipc'

declare global {
  interface Window {
    api: IpcApi & {
      onRunFinished(cb: () => void): () => void
      onRunStarted(cb: () => void): () => void
      onUpdateStatus(cb: (s: UpdateStatus) => void): () => void
    }
  }
}

export {}
