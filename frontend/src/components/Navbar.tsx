import React from 'react';
import { useNavigate } from 'react-router-dom';
import { clearAuth, getUser } from '../auth';

const Navbar: React.FC = () => {
  const navigate = useNavigate();
  const user = getUser();

  const handleLogout = () => {
    clearAuth();
    navigate('/login');
  };

  return (
    <nav className="navbar">
      <div className="navbar-left">
        <span className="navbar-logo">LinkedIn Bot</span>
      </div>
      <div className="navbar-right">
        {user && <span className="navbar-user">{user.email}</span>}
        <button className="btn btn-outline" onClick={handleLogout}>
          Logout
        </button>
      </div>
    </nav>
  );
};

export default Navbar;
