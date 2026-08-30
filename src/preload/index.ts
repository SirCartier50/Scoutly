import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS, EVENTS } from '@shared/ipc'
import type { IpcApi } from '@shared/ipc'

/**
 * The only bridge between the page and Node. Everything is invoke/handle, so
 * the renderer can never reach ipcRenderer, the filesystem, or the network
 * stack directly.
 */
const call = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>

const api: IpcApi & {
  onRunFinished(cb: () => void): () => void
  onRunStarted(cb: () => void): () => void
} = {
  getStatus: () => call(CHANNELS.getStatus),
  runCheckNow: () => call(CHANNELS.runCheckNow),
  openExternal: (url) => call(CHANNELS.openExternal, url),

  listCompanies: () => call(CHANNELS.listCompanies),
  setWatched: (id, watched) => call(CHANNELS.setWatched, id, watched),
  addCompany: (name, careersUrl) => call(CHANNELS.addCompany, name, careersUrl),
  removeCompany: (id) => call(CHANNELS.removeCompany, id),
  searchSeed: (q) => call(CHANNELS.searchSeed, q),
  suggestByTopics: (topics) => call(CHANNELS.suggestByTopics, topics),
  importCsv: () => call(CHANNELS.importCsv),

  listPostings: (q) => call(CHANNELS.listPostings, q),
  listNewSinceLastOpen: () => call(CHANNELS.listNewSinceLastOpen),
  listPrograms: () => call(CHANNELS.listPrograms),

  getSettings: () => call(CHANNELS.getSettings),
  saveSettings: (patch) => call(CHANNELS.saveSettings, patch),
  saveSecret: (key, value) => call(CHANNELS.saveSecret, key, value),
  verifyMail: () => call(CHANNELS.verifyMail),
  sendTestDigest: () => call(CHANNELS.sendTestDigest),

  configureServer: (url, token) => call(CHANNELS.configureServer, url, token),
  testServerConnection: () => call(CHANNELS.testServerConnection),
  listMaybePostings: () => call(CHANNELS.listMaybePostings),
  setPostingStatus: (id, status, note) => call(CHANNELS.setPostingStatus, id, status, note),

  onRunFinished(cb) {
    const l = (): void => cb()
    ipcRenderer.on(EVENTS.runFinished, l)
    return () => ipcRenderer.off(EVENTS.runFinished, l)
  },
  onRunStarted(cb) {
    const l = (): void => cb()
    ipcRenderer.on(EVENTS.runStarted, l)
    return () => ipcRenderer.off(EVENTS.runStarted, l)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type PreloadApi = typeof api
