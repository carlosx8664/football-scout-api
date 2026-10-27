import { useEffect, useState } from "react";
import {
  formatCountdown,
  recycleCooldownEndsAt,
  recycleCooldownRemaining,
} from "../lib/cooldown";
import "./RecycleCooldown.css";

/**
 * Banner shown for 15 minutes after capital is recycled between bookies. Renders nothing when
 * no cool-down is running, so it can be dropped into any panel.
 */
const RecycleCooldown = () => {
  const [remaining, setRemaining] = useState(() => recycleCooldownRemaining());
  const active = remaining > 0;

  // Tick only while a cool-down is running, so an idle dashboard stays quiet.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setRemaining(recycleCooldownRemaining()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  if (!active || recycleCooldownEndsAt() === null) return null;

  return (
    <p className="recycle-cooldown" role="status">
      <span className="recycle-cooldown-text">
        ⏱️ Cool Down active. Wait 15 minutes before placing your next arb to mimic human browsing
        behavior.
      </span>
      <span className="recycle-cooldown-timer">{formatCountdown(remaining)}</span>
    </p>
  );
};

export default RecycleCooldown;
