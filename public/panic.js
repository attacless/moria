;(function () {
  const PANIC_COUNT  = 3
  const PANIC_WINDOW = 1_500
  let presses = []

  function coverPage() {
    try { window.history.replaceState({}, '', '/') } catch (_) {}
    document.title = ''
    try { sessionStorage.clear() } catch (_) {}
    try { localStorage.clear()   } catch (_) {}
    try {
      document.documentElement.innerHTML =
        '<head><meta charset="utf-8"><title></title>' +
        '<style>*{margin:0;padding:0}body{background:#fff}</style></head><body></body>'
    } catch (_) {}
    try { window.stop() } catch (_) {}
    window.addEventListener('popstate', function () {
      try { window.history.replaceState({}, '', '/') } catch (_) {}
      document.title = ''
    })
  }

  window.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return
    const now = Date.now()
    presses.push(now)
    presses = presses.filter(t => now - t < PANIC_WINDOW)
    if (presses.length >= PANIC_COUNT) {
      presses = []
      coverPage()
    }
  }, true)

  window.addEventListener('pageshow', function (e) {
    if (e.persisted) {
      try { window.history.replaceState({}, '', '/') } catch (_) {}
      document.title = ''
      console.log('PANIC: replaceState fired')
      try { sessionStorage.clear() } catch (_) {}
      try { localStorage.clear()   } catch (_) {}
      try {
        document.documentElement.innerHTML =
          '<head><meta charset="utf-8"><title></title>' +
          '<style>*{margin:0;padding:0}body{background:#fff}</style></head><body></body>'
      } catch (_) {}
      try { window.stop() } catch (_) {}
      window.addEventListener('popstate', function () {
        try { window.history.replaceState({}, '', '/') } catch (_) {}
        document.title = ''
      })
    }
  })
})()
