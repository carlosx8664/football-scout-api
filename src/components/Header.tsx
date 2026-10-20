import React from 'react';

interface HeaderProps {
  onClickLogo: () => void;
}

const Header: React.FC<HeaderProps> = ({ onClickLogo }) => {
  return (
    <header className="top-header">
      <div className="header-inner">
        <div className="header-left">
          <h1 className="logo" onClick={onClickLogo} style={{ cursor: 'pointer' }}>ABC</h1>
          <nav className="top-nav">
            <a href="#">Tip Hub</a>
            <a href="#">Champions League</a>
            <a href="#">Football ▾</a>
            <a href="#">Best Bookies</a>
          </nav>
        </div>
        <div className="header-right">
          <button className="btn-signup">🎁 Free Bets</button>
          <button className="btn-login">Log in</button>
        </div>
      </div>
    </header>
  );
};

export default Header;