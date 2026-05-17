import React from 'react'

const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/g

export function linkifyText(text: string): (string | React.ReactElement)[] {
  const parts: (string | React.ReactElement)[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  const regex = new RegExp(URL_REGEX.source, 'g')
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }
    const url = match[0]
    parts.push(
      <a
        key={match.index}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="msg-link"
        onClick={(e) => e.stopPropagation()}
      >
        {url}
      </a>
    )
    lastIndex = regex.lastIndex
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  return parts.length > 0 ? parts : [text]
}
