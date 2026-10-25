import { Link } from "react-router-dom";
import BestArbBadge from "./BestArbBadge";
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
            <a href="#">Tip Hub</a>
            <Link to="/arbs">Arbs</Link>
            <Link to="/bet-builder">Bet Builder</Link>
          </nav>
        </div>
        <div className="header-right">
          <BestArbBadge />
        </div>
      </div>
    </header>
  );
};

export default Header;
