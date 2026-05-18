export async function stripExif(file: File): Promise<Blob> {
  return new Promise((resolve) => {
    const img = new Image()
    const url = URL.createObjectURL(file)

    img.onload = () => {
      let width  = img.naturalWidth
      let height = img.naturalHeight

      // Resize if either dimension exceeds 1600px
      const MAX_DIM = 1600
      if (width > MAX_DIM || height > MAX_DIM) {
        const ratio = Math.min(MAX_DIM / width, MAX_DIM / height)
        width  = Math.round(width  * ratio)
        height = Math.round(height * ratio)
      }

      const canvas = document.createElement('canvas')
      canvas.width  = width
      canvas.height = height

      const ctx = canvas.getContext('2d')
      if (!ctx) {
        URL.revokeObjectURL(url)
        resolve(file)
        return
      }

      ctx.drawImage(img, 0, 0, width, height)
      URL.revokeObjectURL(url)

      const dataUrl = canvas.toDataURL('image/jpeg', 0.85)

      const byteString = atob(dataUrl.split(',')[1]!)
      const ab = new ArrayBuffer(byteString.length)
      const ia = new Uint8Array(ab)
      for (let i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i)
      }

      const blob = new Blob([ab], { type: 'image/jpeg' })

      // If compression made it larger somehow, use original
      if (blob.size > file.size) {
        resolve(file)
        return
      }

      resolve(blob)
    }

    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(file)
    }

    img.src = url
  })
}
