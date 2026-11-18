// Renders overlays/slates to full-canvas transparent PNG data URLs.
// Everything is drawn at export resolution so the ffmpeg `overlay` filter
// (centered) places it pixel-accurately over the video.

function makeCanvas(w, h) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

// Player highlight marker at a pixel position (cx,cy) with radius r.
// style: 'spotlight' (dim everything but a circle), 'ring', or 'arrow'.
export function renderPlayerHighlight({ w, h, cx, cy, r, style, accent }) {
  const c = makeCanvas(w, h)
  const ctx = c.getContext('2d')
  const col = accent || '#39d98a'

  if (style === 'spotlight') {
    // Dim the whole frame, then punch a soft transparent hole over the player.
    ctx.fillStyle = 'rgba(0,0,0,0.58)'
    ctx.fillRect(0, 0, w, h)
    const g = ctx.createRadialGradient(cx, cy, r * 0.35, cx, cy, r)
    g.addColorStop(0, 'rgba(0,0,0,1)')
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.globalCompositeOperation = 'destination-out'
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalCompositeOperation = 'source-over'
    // Accent ring around the lit area.
    ctx.strokeStyle = col
    ctx.lineWidth = Math.max(3, r * 0.03)
    ctx.beginPath()
    ctx.arc(cx, cy, r * 0.92, 0, Math.PI * 2)
    ctx.stroke()
  } else if (style === 'ring') {
    ctx.strokeStyle = col
    ctx.lineWidth = Math.max(4, r * 0.06)
    ctx.shadowColor = 'rgba(0,0,0,0.6)'
    ctx.shadowBlur = r * 0.15
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.stroke()
  } else if (style === 'arrow') {
    // Downward arrow pointing at the player from above.
    const tipY = cy - r * 0.55
    const topY = tipY - r * 1.1
    const halfW = r * 0.5
    ctx.fillStyle = col
    ctx.strokeStyle = 'rgba(0,0,0,0.55)'
    ctx.lineWidth = Math.max(3, r * 0.04)
    ctx.beginPath()
    ctx.moveTo(cx, tipY)
    ctx.lineTo(cx - halfW, tipY - halfW)
    ctx.lineTo(cx - halfW * 0.42, tipY - halfW)
    ctx.lineTo(cx - halfW * 0.42, topY)
    ctx.lineTo(cx + halfW * 0.42, topY)
    ctx.lineTo(cx + halfW * 0.42, tipY - halfW)
    ctx.lineTo(cx + halfW, tipY - halfW)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
  }
  return c.toDataURL('image/png')
}

// A lower/upper third text bar.
export function renderLowerThird({ w, h, text, subtext, position, accent }) {
  const c = makeCanvas(w, h)
  const ctx = c.getContext('2d')
  const pad = Math.round(w * 0.03)
  const fontSize = Math.round(h * 0.05)
  const subSize = Math.round(h * 0.032)
  ctx.font = `700 ${fontSize}px Arial, sans-serif`
  const textW = ctx.measureText(text || '').width
  ctx.font = `500 ${subSize}px Arial, sans-serif`
  const subW = subtext ? ctx.measureText(subtext).width : 0
  const boxW = Math.max(textW, subW) + pad * 2 + Math.round(w * 0.012)
  const lineH = fontSize + (subtext ? subSize + 8 : 0)
  const boxH = lineH + pad * 1.2
  const x = pad
  const y = position === 'upper' ? pad : h - boxH - pad

  ctx.fillStyle = 'rgba(15,17,21,0.72)'
  roundRect(ctx, x, y, boxW, boxH, Math.round(h * 0.012))
  ctx.fill()
  // Accent bar
  ctx.fillStyle = accent || '#39d98a'
  const barW = Math.round(w * 0.008)
  ctx.fillRect(x, y, barW, boxH)

  const tx = x + barW + pad
  ctx.textBaseline = 'top'
  ctx.fillStyle = '#ffffff'
  ctx.font = `700 ${fontSize}px Arial, sans-serif`
  ctx.fillText(text || '', tx, y + pad * 0.5)
  if (subtext) {
    ctx.fillStyle = 'rgba(255,255,255,0.75)'
    ctx.font = `500 ${subSize}px Arial, sans-serif`
    ctx.fillText(subtext, tx, y + pad * 0.5 + fontSize + 6)
  }
  return c.toDataURL('image/png')
}

// Player identity card, shown at the start of a clip (lower-left).
export function renderPlayerCard({ w, h, player, accent }) {
  const parts = []
  if (player.position) parts.push(player.position)
  if (player.gradYear) parts.push(`Class of ${player.gradYear}`)
  if (player.height) parts.push(player.height)
  const sub = parts.join('  •  ')
  const name = player.number ? `#${player.number}  ${player.name || ''}`.trim() : player.name || ''
  return renderLowerThird({ w, h, text: name, subtext: sub, position: 'lower', accent })
}

// Full-screen intro title slate.
export function renderTitleSlate({ w, h, player, accent, title }) {
  const c = makeCanvas(w, h)
  const ctx = c.getContext('2d')
  const grad = ctx.createLinearGradient(0, 0, w, h)
  grad.addColorStop(0, '#0f1115')
  grad.addColorStop(1, '#1b2230')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)

  // Accent underline
  ctx.fillStyle = accent || '#39d98a'
  ctx.fillRect(w * 0.5 - w * 0.12, h * 0.62, w * 0.24, Math.round(h * 0.006))

  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = '#ffffff'
  ctx.font = `800 ${Math.round(h * 0.11)}px Arial, sans-serif`
  ctx.fillText(player.name || 'Player Name', w / 2, h * 0.5)

  const line2 = []
  if (player.position) line2.push(player.position)
  if (player.number) line2.push(`#${player.number}`)
  if (player.gradYear) line2.push(`Class of ${player.gradYear}`)
  ctx.fillStyle = accent || '#39d98a'
  ctx.font = `600 ${Math.round(h * 0.045)}px Arial, sans-serif`
  ctx.fillText(line2.join('   •   '), w / 2, h * 0.58)

  const line3 = []
  if (player.team) line3.push(player.team)
  if (player.height) line3.push(player.height)
  if (title) line3.push(title)
  ctx.fillStyle = 'rgba(255,255,255,0.72)'
  ctx.font = `500 ${Math.round(h * 0.032)}px Arial, sans-serif`
  ctx.fillText(line3.join('   •   '), w / 2, h * 0.7)
  return c.toDataURL('image/png')
}

// Closing slate with contact / academic info.
export function renderOutroSlate({ w, h, player, accent }) {
  const c = makeCanvas(w, h)
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#0f1115'
  ctx.fillRect(0, 0, w, h)
  ctx.textAlign = 'center'
  ctx.fillStyle = '#ffffff'
  ctx.font = `800 ${Math.round(h * 0.07)}px Arial, sans-serif`
  ctx.fillText(player.name || 'Player Name', w / 2, h * 0.28)

  const rows = []
  if (player.position || player.gradYear)
    rows.push([player.position, player.gradYear ? `Class of ${player.gradYear}` : ''].filter(Boolean).join('  •  '))
  if (player.team) rows.push(player.team)
  if (player.height) rows.push(player.height)
  if (player.gpa) rows.push(`GPA: ${player.gpa}`)
  if (player.contact) rows.push(player.contact)

  ctx.font = `500 ${Math.round(h * 0.04)}px Arial, sans-serif`
  let y = h * 0.42
  for (const r of rows) {
    if (!r) continue
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.fillText(r, w / 2, y)
    y += h * 0.075
  }
  ctx.fillStyle = accent || '#39d98a'
  ctx.font = `600 ${Math.round(h * 0.035)}px Arial, sans-serif`
  ctx.fillText('Thank you for watching', w / 2, h * 0.9)
  return c.toDataURL('image/png')
}
