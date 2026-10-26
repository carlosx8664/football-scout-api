import { useEffect, useRef, useState } from "react";
import { relativeTime, useNotifications } from "../lib/notifications";
import "./NotificationBell.css";

const BellIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true" width="18" height="18">
    <path
      d="M10 2.2a4.6 4.6 0 0 0-4.6 4.6v2.6l-1.2 2.4a.8.8 0 0 0 .7 1.2h10.2a.8.8 0 0 0 .7-1.2l-1.2-2.4V6.8A4.6 4.6 0 0 0 10 2.2Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
    <path
      d="M8.2 15.2a1.9 1.9 0 0 0 3.6 0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </svg>
);

/** Bell button with an unread badge and a dropdown inbox (newest first). */
const NotificationBell = () => {
  const { notifications, unreadCount, markAllRead, dismiss } = useNotifications();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="notification-bell" ref={wrapRef}>
      <button
        type="button"
        className={`bell-button${open ? " open" : ""}`}
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={
          unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"
        }
      >
        <BellIcon />
        {unreadCount > 0 && (
          <span className="bell-badge">{unreadCount > 9 ? "9+" : unreadCount}</span>
        )}
      </button>

      {open && (
        <div className="notification-panel" role="dialog" aria-label="Notifications">
          <header className="notification-panel-header">
            <h3>Notifications</h3>
            <button
              type="button"
              className="notification-mark-read"
              onClick={markAllRead}
              disabled={unreadCount === 0}
            >
              Mark all as read
            </button>
          </header>

          {notifications.length === 0 ? (
            <p className="notification-empty">You're all caught up.</p>
          ) : (
            <ul className="notification-list">
              {notifications.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`notification-item ${item.tone}${item.read ? " read" : ""}`}
                    onClick={() => dismiss(item.id)}
                    title="Dismiss"
                  >
                    <span className="notification-message">{item.message}</span>
                    <span className="notification-time">{relativeTime(item.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

export default NotificationBell;
