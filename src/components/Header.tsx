import { Link } from "react-router-dom";
import BestArbBadge from "./BestArbBadge";
import NotificationBell from "./NotificationBell";
import PushToggle from "./PushToggle";
import SimulationToggle from "./SimulationToggle";
import ThemeToggle from "./ThemeToggle";
import "./Header.css";

const Header = () => {
  return (
    <header className="top-header">
      <div className="header-inner">
        <div className="header-left">
          <a className="logo" href="/">
            <img
              src="/logo.png"
              alt="Oddtor"
              style={{
                height: "40px",
                width: "auto",
                maxWidth: "150px",
                objectFit: "contain",
                cursor: "pointer",
              }}
            />
          </a>
          <nav className="top-nav">
            <Link to="/arbs">Arbs</Link>
            <Link to="/wallets">Wallets</Link>
          </nav>
        </div>
        <div className="header-right">
          <SimulationToggle />
          <ThemeToggle />
          <PushToggle />
          <NotificationBell />
          <BestArbBadge />
        </div>
      </div>
    </header>
  );
};

export default Header;
