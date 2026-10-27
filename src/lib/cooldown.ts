/**
 * Post-recycle cool-down.
 *
 * Recycling capital between bookies is the most automation-looking thing the dashboard can do,
 * so after one the user is asked to leave it 15 minutes before placing the next arb. The deadline
 * lives in localStorage so a reload (or a different tab) keeps the timer running.
 */

const STORAGE_KEY = "oddtor:recycle-cooldown";
export const RECYCLE_COOLDOWN_MS = 15 * 60 * 1000;

/** Marks the cool-down as started now. */
export function startRecycleCooldown(now = Date.now()): number {
  const endsAt = now + RECYCLE_COOLDOWN_MS;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(endsAt));
  } catch {
    // Private mode: the warning simply does not survive a reload.
  }
  return endsAt;
}

/** Epoch ms when the cool-down ends, or null when none is running. */
export function recycleCooldownEndsAt(now = Date.now()): number | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const endsAt = Number(raw);
    if (!Number.isFinite(endsAt) || endsAt <= now) {
      window.localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return endsAt;
  } catch {
    return null;
  }
}

/** Milliseconds left on the cool-down; 0 when it is clear. */
export function recycleCooldownRemaining(now = Date.now()): number {
  const endsAt = recycleCooldownEndsAt(now);
  return endsAt === null ? 0 : Math.max(0, endsAt - now);
}

/** mm:ss for the countdown. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
