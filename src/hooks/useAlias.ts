import { useState, useCallback } from 'react'
import type { Alias } from '@/types'

function generateAlias(): Alias {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes as Uint8Array<ArrayBuffer>)
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

export function useAlias() {
  const [alias, setAlias] = useState<Alias>(generateAlias)

  // Call on room leave/rejoin to get a new alias
  // There is no link between old and new alias — unlinkable by design
  const rotateAlias = useCallback(() => {
    setAlias(generateAlias())
  }, [])

  return { alias, rotateAlias }
}
