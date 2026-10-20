import React from 'react';

const RightSidebar = () => {
  return (
    <aside className="right-sidebar">
      <div className="betslip-container">
        <h3>Betslip</h3>
        <p className="betslip-empty-text">
          Log in to your bookmaker accounts here so you can place bets without leaving ABC.
        </p>

        <div className="bookmaker-logins">
          <div className="login-row"><span>Paddy Power</span> <button>Log in</button></div>
          <div className="login-row"><span>Betfair</span> <button>Log in</button></div>
          <div className="login-row"><span>Sky Bet</span> <button>Log in</button></div>
          <div className="login-row"><span>bet365</span> <button>Log in</button></div>
        </div>

        <div className="betslip-slip">
          <h4>Your betslip is empty</h4>
          <p>Add one or more selections to place bets.</p>
        </div>
      </div>
    </aside>
  );
};

export default RightSidebar;