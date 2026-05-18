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

      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob)
          else reject(new Error('toBlob failed'))
        },
        file.type === 'image/png' ? 'image/png' : 'image/jpeg',
        0.92
      )
    }

    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('image load failed'))
    }

    img.src = url
  })
}
