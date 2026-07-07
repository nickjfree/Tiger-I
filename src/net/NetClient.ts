/* ---------------------------------------------------------------------------
 * WebSocket client: connection, clock sync and typed message dispatch.
 *
 * Clock sync: pings every 2 s; the smoothed offset maps server timestamps to
 * the local clock so RemoteTanks can render `INTERP_DELAY_MS` in the past
 * regardless of latency or jitter.
 * ------------------------------------------------------------------------ */

import { ClientMsg, ServerMsg } from './protocol';

export class NetClient {
  private ws: WebSocket | null = null;
  private offset = 0; // serverTime − clientTime (ms), EMA-smoothed
  private offsetInit = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  rttMs = 0;

  onMessage: ((msg: ServerMsg) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;

  connected = false;

  connect(url: string): void {
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.sendPing();
      this.pingTimer = setInterval(() => this.sendPing(), 2000);
    };
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data as string) as ServerMsg;
      } catch {
        return;
      }
      if (msg.t === 'pong') {
        const now = performance.now();
        const rtt = now - msg.c;
        this.rttMs = rtt;
        const est = msg.s - (now - rtt / 2); // server time at halfway point
        if (!this.offsetInit) {
          this.offset = est;
          this.offsetInit = true;
        } else {
          this.offset += (est - this.offset) * 0.15;
        }
        return;
      }
      this.onMessage?.(msg);
    };
    ws.onclose = () => {
      this.connected = false;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.onClose?.('connection closed');
    };
    ws.onerror = () => {
      // onclose follows; nothing extra to do
    };
  }

  private sendPing(): void {
    this.send({ t: 'ping', c: performance.now() });
  }

  send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** Current estimate of the server clock (ms). */
  serverNow(): number {
    return performance.now() + this.offset;
  }

  close(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
  }
}
