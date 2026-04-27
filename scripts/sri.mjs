import { readFileSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { resolve, join } from 'path'

const DIST = resolve('dist')

function computeSRI(filePath) {
  const content = readFileSync(filePath)
  const hash = createHash('sha384').update(content).digest('base64')
  return `sha384-${hash}`
}

// Strip the bare `crossorigin` attribute that Vite injects, since we replace
// it with the explicit `crossorigin="anonymous"` form required by SRI.
function stripBareCrossorigin(str) {
  return str.replace(/\s+crossorigin(?!=)/g, '')
}

function addSRI() {
  const htmlPath = join(DIST, 'index.html')
  let html = readFileSync(htmlPath, 'utf-8')

  // <script src="...">
  html = html.replace(
    /<script([^>]*)\ssrc="([^"]+)"([^>]*)>/g,
    (match, before, src, after) => {
      if (match.includes('integrity')) return match
      const filePath = join(DIST, src)
      try {
        const integrity = computeSRI(filePath)
        const b = stripBareCrossorigin(before)
        const a = stripBareCrossorigin(after)
        return `<script${b} src="${src}"${a} integrity="${integrity}" crossorigin="anonymous">`
      } catch {
        console.warn('SRI: skipping ' + src + ' (file not found)')
        return match
      }
    }
  )

  // <link rel="stylesheet" href="..."> (rel before href)
  html = html.replace(
    /<link([^>]*)\srel="stylesheet"([^>]*)\shref="([^"]+)"([^>]*)>/g,
    (match, before, mid, href, after) => {
      if (match.includes('integrity')) return match
      const filePath = join(DIST, href)
      try {
        const integrity = computeSRI(filePath)
        const b = stripBareCrossorigin(before)
        const m = stripBareCrossorigin(mid)
        const a = stripBareCrossorigin(after)
        return `<link${b} rel="stylesheet"${m} href="${href}"${a} integrity="${integrity}" crossorigin="anonymous">`
      } catch {
        console.warn('SRI: skipping ' + href + ' (file not found)')
        return match
      }
    }
  )

  // <link href="..." rel="stylesheet"> (href before rel)
  html = html.replace(
    /<link([^>]*)\shref="([^"]+)"([^>]*)\srel="stylesheet"([^>]*)>/g,
    (match, before, href, mid, after) => {
      if (match.includes('integrity')) return match
      const filePath = join(DIST, href)
      try {
        const integrity = computeSRI(filePath)
        const b = stripBareCrossorigin(before)
        const m = stripBareCrossorigin(mid)
        const a = stripBareCrossorigin(after)
        return `<link${b} href="${href}"${m} rel="stylesheet"${a} integrity="${integrity}" crossorigin="anonymous">`
      } catch {
        console.warn('SRI: skipping ' + href + ' (file not found)')
        return match
      }
    }
  )

  // <link rel="modulepreload" href="..."> (rel before href)
  html = html.replace(
    /<link([^>]*)\srel="modulepreload"([^>]*)\shref="([^"]+)"([^>]*)>/g,
    (match, before, mid, href, after) => {
      if (match.includes('integrity')) return match
      const filePath = join(DIST, href)
      try {
        const integrity = computeSRI(filePath)
        const b = stripBareCrossorigin(before)
        const m = stripBareCrossorigin(mid)
        const a = stripBareCrossorigin(after)
        return `<link${b} rel="modulepreload"${m} href="${href}"${a} integrity="${integrity}" crossorigin="anonymous">`
      } catch {
        console.warn('SRI: skipping ' + href + ' (file not found)')
        return match
      }
    }
  )

  // <link href="..." rel="modulepreload"> (href before rel)
  html = html.replace(
    /<link([^>]*)\shref="([^"]+)"([^>]*)\srel="modulepreload"([^>]*)>/g,
    (match, before, href, mid, after) => {
      if (match.includes('integrity')) return match
      const filePath = join(DIST, href)
      try {
        const integrity = computeSRI(filePath)
        const b = stripBareCrossorigin(before)
        const m = stripBareCrossorigin(mid)
        const a = stripBareCrossorigin(after)
        return `<link${b} href="${href}"${m} rel="modulepreload"${a} integrity="${integrity}" crossorigin="anonymous">`
      } catch {
        console.warn('SRI: skipping ' + href + ' (file not found)')
        return match
      }
    }
  )

  writeFileSync(htmlPath, html)

  const count = (html.match(/integrity="sha384-/g) || []).length
  console.log('SRI: ' + count + ' assets protected')
}

addSRI()
