// Shared helpers for the pages.
export async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body && JSON.stringify(options.body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status })
  return data
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

export function art(url) {
  return url ? `<img src="${esc(url)}" alt="" loading="lazy">` : '<div class="art"></div>'
}

export function showError(el, message) {
  el.textContent = message
  el.classList.toggle('hidden', !message)
}
