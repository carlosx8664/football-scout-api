import { useEffect, useRef } from "react";
import "./RightSidebar.css";

declare global {
  interface Window {
    twttr?: {
      widgets?: {
        load: (element?: HTMLElement | null) => void;
      };
    };
  }
}

const RightSidebar = () => {
  const timelineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const script = document.querySelector<HTMLScriptElement>(
      'script[src="https://platform.x.com/widgets.js"]',
    );
    const loadTimeline = () => window.twttr?.widgets?.load(timelineRef.current);

    loadTimeline();
    script?.addEventListener("load", loadTimeline);

    return () => script?.removeEventListener("load", loadTimeline);
  }, []);

  return (
    <aside className="right-sidebar">
      <section className="tipsters-container">
        <h3>Latest from Tipsters</h3>
        <div className="twitter-timeline-container" ref={timelineRef}>
          <a
            className="twitter-timeline"
            href="https://x.com/AndyRobsonTips"
            data-tweet-limit="3"
            data-chrome="nofooter noborders transparent"
            data-theme="light"
          >
            Tweets by AndyRobsonTips
          </a>
        </div>
      </section>
    </aside>
  );
};

export default RightSidebar;