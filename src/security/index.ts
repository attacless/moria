import { mountCopyPrevention, unmountCopyPrevention } from './copyPrevention'
import { mountScreenshotPrevention, unmountScreenshotPrevention } from './screenshotPrevention'

export function mountSecurityMeasures(): void {
  mountCopyPrevention()
  mountScreenshotPrevention()
}

export function unmountSecurityMeasures(): void {
  unmountCopyPrevention()
  unmountScreenshotPrevention()
}
