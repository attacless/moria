export async function stripExif(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)

    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight

      const ctx = canvas.getContext('2d')
      if (!ctx) {
        URL.revokeObjectURL(url)
        reject(new Error('canvas context failed'))
        return
      }

      ctx.drawImage(img, 0, 0)
      URL.revokeObjectURL(url)

      const dataUrl = canvas.toDataURL(
        file.type === 'image/png' ? 'image/png' : 'image/jpeg',
        0.92
      )

      // Convert data URL to Blob synchronously - avoids toBlob callback inconsistencies
      const byteString = atob(dataUrl.split(',')[1]!)
      const mimeString = dataUrl.split(',')[0]!.split(':')[1]!.split(';')[0]!
      const ab = new ArrayBuffer(byteString.length)
      const ia = new Uint8Array(ab)
      for (let i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i)
      }

      resolve(new Blob([ab], { type: mimeString }))
    }

    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(file) // fallback: send original if strip fails
    }

    img.src = url
  })
}
