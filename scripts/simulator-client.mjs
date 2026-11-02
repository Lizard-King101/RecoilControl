/** Copy/import into a browser simulator. The lab URL is supplied by the user, never hard-code it. */
export function connectRecoilLab(url, { onMove = () => {}, onBurst = () => {}, onEnd = () => {}, onStatus = () => {} } = {}) {
  const base = new URL(url);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !base.searchParams.get('token')) throw new Error('Paste the private localhost link from Vision lab.');
  const endpoint = path => { const value = new URL(base); value.pathname = path; return value.href; };
  const events = new EventSource(endpoint('/events'));
  let firing = false, sending = false, closed = false;
  async function send() {
    if (sending || closed) return;
    sending = true;
    try {
      const response = await fetch(endpoint('/input'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ firing }), signal: AbortSignal.timeout(250) });
      if (!response.ok) throw new Error(`Lab rejected input (${response.status}).`);
    } catch (error) { firing = false; onEnd({ reason: 'Lab input unavailable.' }); onStatus(error.message); }
    finally { sending = false; }
  }
  events.onmessage = event => {
    const value = JSON.parse(event.data);
    if (value.type === 'move' && value.mode === 'simulator') onMove(value.x, value.y);
    else if (value.type === 'burst-start') onBurst(value);
    else if (value.type === 'burst-end') onEnd(value);
    else if (value.type !== 'move') onStatus(value);
  };
  events.onerror = () => { firing = false; onEnd({ reason: 'Lab disconnected.' }); onStatus('Lab disconnected; release fire before retrying.'); };
  const heartbeat = setInterval(send, 100);
  const blur = () => { firing = false; void send(); };
  window.addEventListener('blur', blur);
  return {
    setFiring(value) { firing = value === true; void send(); },
    close() { firing = false; void send(); closed = true; clearInterval(heartbeat); events.close(); window.removeEventListener('blur', blur); onEnd({ reason: 'Lab link closed.' }); },
  };
}
