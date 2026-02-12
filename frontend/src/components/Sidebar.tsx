import React from 'react';
import { clearAuth, getUser } from '../auth';

interface SidebarProps {
    activeTab: 'overview' | 'automation' | 'settings';
    setActiveTab: (tab: 'overview' | 'automation' | 'settings') => void;
    onLogout: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({ activeTab, setActiveTab, onLogout }) => {
    const user = getUser();
    const email = user?.email || 'User';

    return (
        <aside className="sidebar">
            <div className="sidebar-header">
                <div className="brand">
                    <span className="logo-icon">⚡</span>
                    <h2>LinkedIn Bot</h2>
                </div>
                <div className="user-profile">
                    <div className="avatar">{email[0].toUpperCase()}</div>
                    <div className="user-info">
                        <span className="email-text" title={email}>{email}</span>
                        <span className="status-text">Pro Plan</span>
                    </div>
                </div>
            </div>

            <nav className="sidebar-nav">
                <button
                    className={`nav-item ${activeTab === 'overview' ? 'active' : ''}`}
                    onClick={() => setActiveTab('overview')}
                >
                    <span className="icon">📊</span> Overview
                </button>
                <button
                    className={`nav-item ${activeTab === 'automation' ? 'active' : ''}`}
                    onClick={() => setActiveTab('automation')}
                >
                    <span className="icon">🤖</span> Trending Bot
                </button>
                <button
                    className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`}
                    onClick={() => setActiveTab('settings')}
                >
                    <span className="icon">⚙️</span> Connections
                </button>
            </nav>

            <div className="sidebar-footer">
                <button className="nav-item logout" onClick={onLogout}>
                    <span className="icon">🚪</span> Logout
                </button>
            </div>
        </aside>
    );
};

export default Sidebar;
