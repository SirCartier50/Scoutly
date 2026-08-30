/**
 * Distinguishes "user closed the window" (hide to tray) from "user chose Quit"
 * (really exit). The timers only fire while the process is alive, so closing
 * the window must not kill it.
 */
export const appState = {
  isQuitting: false
}
