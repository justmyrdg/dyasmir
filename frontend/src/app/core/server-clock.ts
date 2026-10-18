import { Injectable, signal } from '@angular/core';

/**
 * Countdown clock anchored to the server. The browser clock is only used to measure elapsed time since the
 * last server timestamp, so a wrong device clock never changes when a quiz opens or ends.
 */
@Injectable({ providedIn: 'root' })
export class ServerClock {
  private offsetMs = 0;
  private readonly tickSignal = signal(Date.now());

  constructor() {
    setInterval(() => this.tickSignal.set(Date.now()), 1000);
  }

  /** Call with any serverNow received from the API. */
  sync(serverNow: string | Date) {
    this.offsetMs = new Date(serverNow).getTime() - Date.now();
    this.tickSignal.set(Date.now());
  }

  /** Server time in ms; reading it inside a computed/template re-evaluates every second. */
  now(): number {
    return this.tickSignal() + this.offsetMs;
  }

  msUntil(iso: string | Date): number {
    return new Date(iso).getTime() - this.now();
  }
}
