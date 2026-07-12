// Bounded waits for the zero-dependency IMAP/SMTP socket clients. A half-open
// connection (peer gone, no FIN/RST delivered) leaves a data waiter pending
// forever; on 2026-07-11 one such hang kept `mailctl poll` alive ~20h holding
// the ingest lock, stalling the whole mail pipeline. Every socket wait must
// therefore carry a deadline.
export function mailSocketTimeoutMs(): number {
  const raw = Number(process.env.ORCH_MAIL_SOCKET_TIMEOUT_MS ?? "120000");
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}

// Push a waiter onto `waiters` that either gets flushed (resolve) or times out
// (reject). The timed-out waiter is removed from the queue so a late flush
// cannot resolve a settled promise's slot twice.
export function waitWithTimeout(waiters: Array<() => void>, label: string, timeoutMs = mailSocketTimeoutMs()): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const entry = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      const index = waiters.indexOf(entry);
      if (index >= 0) waiters.splice(index, 1);
      reject(new Error(`${label} timed out after ${timeoutMs}ms (half-open connection?)`));
    }, timeoutMs);
    timer.unref?.();
    waiters.push(entry);
  });
}
