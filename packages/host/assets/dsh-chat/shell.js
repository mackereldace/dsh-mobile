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
    if (gesture?.horizontal) dragPanel(parseFloat(html.style.getPropertyValue('--dshm-push')) || 0)
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
  // Same territories and thresholds as boot.js installSwipeNavigation; this page owns its shell.
  const blocked = target => {
    if (target?.closest?.('input,textarea,select,[contenteditable],#floating-dock,.native-trace-graph,.native-trace-scrollbar,[role="slider"],.statistics-details,.composer-menu')) return true
    if (win.getSelection?.()?.isCollapsed === false) return true
    for (let node = target, depth = 0; node && depth < 24; node = node.parentElement, depth++) {
      if (node.scrollWidth > node.clientWidth + 1 && /^(auto|scroll)$/.test(win.getComputedStyle?.(node)?.overflowX || '')) return true
    }
    return false
  }
  const pushTo = value => { const next = value + 'px'; if (html.style.getPropertyValue('--dshm-push') !== next) html.style.setProperty('--dshm-push', next) }
  const dragPanel = value => {
    const panel = gesture?.side === 'left' ? root.querySelector('#sessions') : root.querySelector('#dsh-mobile-sheet-panel')
    if (panel?.style) panel.style.transform = 'translateX(' + (gesture.side === 'left' ? value - leftWidth() : rightWidth() + value) + 'px)'
  }
  const down = event => {
    if (event.pointerType === 'touch' && event.touch !== true) return
    if (event.isPrimary === false) { if (gesture) end({ ...event, pointerId: gesture.pointerId, type: 'pointercancel' }); return }
    if (event.button !== 0 || gesture || management?.available() || statistics?.available() || controls?.available?.()) return
    const target = event.target, openLeft = leftOpen(), openRight = rightOpen()
    if (blocked(target) || !target?.closest?.('main,#sessions,#session-backdrop,#dsh-mobile-sheet')) return
    if (!openLeft && !openRight && navigation?.available?.()) return
    gesture = { pointerId: event.pointerId, touch: event.touch === true, x: event.clientX, y: event.clientY, start: openLeft ? leftWidth() : openRight ? -rightWidth() : 0, initial: openLeft ? 'left' : openRight ? 'right' : null, side: null, at: event.timeStamp, horizontal: false, slide: html.style.getPropertyValue('--dshm-slide') }
  }
  const move = event => {
    if (!gesture || gesture.pointerId !== event.pointerId) return
    if (gesture.touch && event.touch !== true) return
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y
    if (!gesture.horizontal) {
      if (Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx)) { gesture = null; return }
      if (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy)) return
      if (gesture.initial === 'left' && dx >= 0 || gesture.initial === 'right' && dx <= 0) { gesture = null; return }
      gesture.side = gesture.initial || (dx > 0 ? 'left' : 'right')
      gesture.horizontal = true
      if (!gesture.touch) try { app.setPointerCapture?.(event.pointerId) } catch { /* Synthetic or cancelled pointers have no active capture. */ }
      html.style.setProperty('--dshm-slide', 'none')
      if (!gesture.initial) {
        if (gesture.side === 'left') navigation?.openDrawer?.()
        else root.querySelector('#files')?.click()
      }
    }
    event.preventDefault()
    const value = gesture.side === 'left' ? Math.max(0, Math.min(leftWidth(), gesture.start + dx)) : Math.max(-rightWidth(), Math.min(0, gesture.start + dx))
    pushTo(value); dragPanel(value)
  }
  const end = event => {
    if (!gesture || event.pointerId !== gesture.pointerId) return
    if (gesture.touch && event.touch !== true) return
    const saved = gesture; gesture = null
    if (!saved.touch) try { app.releasePointerCapture?.(event.pointerId) } catch { /* Pointer cancellation may already release it. */ }
    if (!saved.horizontal) return
    const panel = saved.side === 'left' ? root.querySelector('#sessions') : root.querySelector('#dsh-mobile-sheet-panel')
    if (panel?.style) panel.style.transform = ''
    if (saved.slide) html.style.setProperty('--dshm-slide', saved.slide); else html.style.removeProperty('--dshm-slide')
    suppressClick = true
    win.setTimeout(() => { suppressClick = false }, 0)
    const dx = event.clientX - saved.x, toward = saved.initial ? Math.abs(dx) : saved.side === 'left' ? dx : -dx, elapsed = Math.max(1, event.timeStamp - saved.at)
    const span = saved.side === 'left' ? leftWidth() : rightWidth()
    const commit = event.type !== 'pointercancel' && Math.abs(event.clientY - saved.y) <= 70 && (saved.initial ? toward >= Math.max(90, span * .35) || toward >= 48 && toward / elapsed >= .7 : toward >= 56)
    const open = commit ? !saved.initial : Boolean(saved.initial)
    if (saved.side === 'left') { if (open) navigation?.openDrawer?.(); else navigation?.hide?.() }
    else if (!open) boot?.closeFiles?.()
    boot?.debugLine?.('[swipe] 会话页' + (saved.side === 'left' ? '左侧栏' : '文件面板') + '：' + (commit ? open ? '打开' : '关闭' : '回弹'))
    sync()
  }
  // Native mobile navigation claims horizontal touchmove; scrollable code keeps its normal pan.
  const touchEvent = (event, point, type) => ({ type, touch: true, pointerType: 'touch', pointerId: point.identifier, button: 0, isPrimary: true, target: event.target, clientX: point.clientX, clientY: point.clientY, timeStamp: event.timeStamp, preventDefault: () => event.preventDefault() })
  const cancelTouch = event => { if (gesture) end({ type: 'pointercancel', touch: gesture.touch, pointerId: gesture.pointerId, clientX: gesture.x, clientY: gesture.y, timeStamp: event.timeStamp }) }
  const touchDown = event => {
    if (event.touches.length !== 1) { cancelTouch(event); return }
    down(touchEvent(event, event.touches[0], 'pointerdown'))
  }
  const touchMove = event => {
    if (event.touches.length !== 1) { cancelTouch(event); return }
    if (gesture?.touch) move(touchEvent(event, event.touches[0], 'pointermove'))
  }
  const touchEnd = event => {
    if (!gesture?.touch) return
    const point = Array.from(event.changedTouches || []).find(point => point.identifier === gesture.pointerId)
    if (point) end(touchEvent(event, point, event.type === 'touchcancel' ? 'pointercancel' : 'pointerup'))
  }
  const click = event => { if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation() } }
  doc.addEventListener('click', click, true)
  doc.addEventListener('pointerdown', down); doc.addEventListener('pointermove', move, { passive: false }); doc.addEventListener('pointerup', end); doc.addEventListener('pointercancel', end)
  doc.addEventListener('touchstart', touchDown, { passive: true }); doc.addEventListener('touchmove', touchMove, { passive: false }); doc.addEventListener('touchend', touchEnd); doc.addEventListener('touchcancel', touchEnd)
  doc.addEventListener('focusin', lockRoot); win.addEventListener?.('scroll', lockRoot); win.addEventListener?.('resize', schedule)
  win.visualViewport?.addEventListener('resize', schedule); doc.addEventListener('dshm:files-state', schedule)
  sync()
  return { sync, back, available, dispose() {
    if (gesture) end({ pointerId: gesture.pointerId, touch: gesture.touch, type: 'pointercancel', clientX: gesture.x, clientY: gesture.y, timeStamp: gesture.at })
    disposed = true; observer?.disconnect(); mutations?.disconnect(); htmlChanges?.disconnect()
    if (frame !== null) (win.cancelAnimationFrame || clearTimeout)(frame)
    for (const [name, handler] of [['pointerdown', down], ['pointermove', move], ['pointerup', end], ['pointercancel', end], ['focusin', lockRoot], ['dshm:files-state', schedule]]) doc.removeEventListener(name, handler)
    for (const [name, handler] of [['touchstart', touchDown], ['touchmove', touchMove], ['touchend', touchEnd], ['touchcancel', touchEnd]]) doc.removeEventListener(name, handler)
    win.removeEventListener?.('scroll', lockRoot); win.removeEventListener?.('resize', schedule); win.visualViewport?.removeEventListener('resize', schedule)
    boot?.setNavigationHandlers?.(null)
    doc.removeEventListener('click', click, true)
  } }
}
