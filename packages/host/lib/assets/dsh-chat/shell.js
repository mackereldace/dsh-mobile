/** One viewport, one panel displacement, and measured room below the floating dock. */
export function mountMobileShell({ root, navigation, statistics, management, controls, boot }) {
  const doc = root.ownerDocument || root, win = doc.defaultView || globalThis
  const app = root.querySelector('.app'), main = root.querySelector('main'), dock = root.querySelector('#floating-dock')
  if (!app || !main || !doc.documentElement) return { dispose() {}, sync() {} }
  let disposed = false, frame = null, gesture = null, dockHeight = 0, suppressClick = false
  const html = doc.documentElement, body = doc.body
  const width = () => win.innerWidth || 412
  const leftWidth = () => Math.min(width() * .64, 264)
  const rightWidth = () => Math.min(width() * .8, 330)
  const leftOpen = () => body.getAttribute('data-dsh-mobile-drawer') === 'open'
  const rightOpen = () => body.getAttribute('data-dshm-files') === 'open'
  const report = () => boot?.reportBackAvailable?.()
  const available = () => statistics?.available() || controls?.available?.() || management?.available() || navigation?.available?.() || boot?.filesOpen?.() || false
  const back = () => {
    if (statistics?.close(true)) return true
    if (controls?.back?.()) return true
    if (management?.back()) return true
    if (boot?.filesOpen?.()) { if (!boot.filesBack?.()) boot.closeFiles?.(); return true }
    return navigation?.back?.() || false
  }
  boot?.setNavigationHandlers?.({ back, available })
  const sync = () => {
    if (disposed) return
    if (leftOpen() && rightOpen()) navigation?.hide?.()
    const push = rightOpen() ? -rightWidth() : leftOpen() ? leftWidth() : 0
    if (!gesture && html.style.getPropertyValue('--dshm-push') !== push + 'px') html.style.setProperty('--dshm-push', push + 'px')
    report()
    if (!dock?.getBoundingClientRect) return
    const next = Math.ceil(dock.getBoundingClientRect().height)
    if (next === dockHeight) return
    const following = main.scrollHeight - main.clientHeight - main.scrollTop <= 48
    dockHeight = next
    html.style.setProperty('--dshm-dock-height', next + 'px')
    if (following) main.scrollTop = Math.max(0, main.scrollHeight - main.clientHeight)
  }
  const schedule = () => { if (frame !== null || disposed) return; frame = (win.requestAnimationFrame || (fn => setTimeout(fn, 0)))(() => { frame = null; sync() }) }
  const observer = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(schedule) : null
  if (dock) observer?.observe(dock)
  const mutations = typeof win.MutationObserver === 'function' ? new win.MutationObserver(schedule) : null
  mutations?.observe(body, { attributes: true, attributeFilter: ['data-dsh-mobile-drawer', 'data-dshm-files'] })
  const htmlChanges = typeof win.MutationObserver === 'function' ? new win.MutationObserver(schedule) : null
  htmlChanges?.observe(html, { attributes: true, attributeFilter: ['data-dshm-kb', 'style'] })
  const lockRoot = () => { if (win.scrollY || win.scrollX) win.scrollTo?.(0, 0); schedule() }
  const down = event => {
    if (event.button !== 0 || event.isPrimary === false || management?.available()) return
    const target = event.target, editing = target?.closest?.('input,textarea,select,[contenteditable],.native-trace-graph,.native-trace-scrollbar')
    if (editing || rightOpen()) return
    const open = leftOpen()
    if (!open && event.clientX > 24) return
    gesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, start: open ? leftWidth() : 0, open, at: event.timeStamp, horizontal: false }
  }
  const move = event => {
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y
    if (!gesture.horizontal) {
      if (Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx)) { gesture = null; return }
      if (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy)) return
      gesture.horizontal = true
      try { app.setPointerCapture?.(event.pointerId) } catch { /* Synthetic or cancelled pointers have no active capture. */ }
      app.style.transition = 'none'
      if (!gesture.open) { navigation?.openDrawer?.(); sync() }
    }
    event.preventDefault()
    html.style.setProperty('--dshm-push', Math.max(0, Math.min(leftWidth(), gesture.start + dx)) + 'px')
  }
  const end = event => {
    if (!gesture || event.pointerId !== gesture.pointerId) return
    const saved = gesture; gesture = null; app.style.transition = ''
    try { app.releasePointerCapture?.(event.pointerId) } catch { /* Pointer cancellation may already release it. */ }
    if (!saved.horizontal) return
    suppressClick = true
    win.setTimeout(() => { suppressClick = false }, 0)
    const dx = event.clientX - saved.x, toward = saved.open ? -dx : dx, elapsed = Math.max(1, event.timeStamp - saved.at)
    const commit = event.type !== 'pointercancel' && (toward >= Math.max(90, leftWidth() * .35) || toward >= 48 && toward / elapsed >= .45)
    const open = commit ? !saved.open : saved.open
    if (open) navigation?.openDrawer?.(); else navigation?.hide?.()
    sync()
  }
  const click = event => { if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation() } }
  doc.addEventListener('click', click, true)
  doc.addEventListener('pointerdown', down); doc.addEventListener('pointermove', move, { passive: false }); doc.addEventListener('pointerup', end); doc.addEventListener('pointercancel', end)
  doc.addEventListener('focusin', lockRoot); win.addEventListener?.('scroll', lockRoot); win.addEventListener?.('resize', schedule)
  win.visualViewport?.addEventListener('resize', schedule); doc.addEventListener('dshm:files-state', schedule)
  sync()
  return { sync, back, available, dispose() {
    disposed = true; observer?.disconnect(); mutations?.disconnect(); htmlChanges?.disconnect()
    if (frame !== null) (win.cancelAnimationFrame || clearTimeout)(frame)
    for (const [name, handler] of [['pointerdown', down], ['pointermove', move], ['pointerup', end], ['pointercancel', end], ['focusin', lockRoot], ['dshm:files-state', schedule]]) doc.removeEventListener(name, handler)
    win.removeEventListener?.('scroll', lockRoot); win.removeEventListener?.('resize', schedule); win.visualViewport?.removeEventListener('resize', schedule)
    boot?.setNavigationHandlers?.(null)
    doc.removeEventListener('click', click, true)
  } }
}
