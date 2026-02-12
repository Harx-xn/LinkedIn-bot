import React, { useEffect, useState, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import CreatePostForm from '../components/CreatePostForm';
import ActivityFeed from '../components/ActivityFeed';
import TrendingBotSettings from '../components/TrendingBotSettings';
import { api } from '../api';
import { clearAuth } from '../auth';
import { ToastContext } from '../App';

const DashboardPage: React.FC = () => {
  const toast = useContext(ToastContext)!;
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<'overview' | 'automation' | 'settings'>('overview');
  const [postFilter, setPostFilter] = useState<'all' | 'manual' | 'bot'>('all');
  const [queue, setQueue] = useState([]);
  const [loading, setLoading] = useState(false);

  // Settings State
  const [linkedinClientId, setLinkedinClientId] = useState('');
  const [linkedinClientSecret, setLinkedinClientSecret] = useState('');
  const [googleClientId, setGoogleClientId] = useState('');
  const [googleClientSecret, setGoogleClientSecret] = useState('');
  const [isLinkedinConfigured, setIsLinkedinConfigured] = useState(false);
  const [isGoogleConfigured, setIsGoogleConfigured] = useState(false);

  useEffect(() => {
    loadData();
  }, [activeTab]);

  const loadData = async () => {
    if (activeTab === 'overview') {
      loadQueue();
    } else if (activeTab === 'settings') {
      loadUserConfig();
    }
  };

  const loadQueue = async () => {
    try {
      const res = await api.get('/posts');
      setQueue(res.data);
    } catch (e) { console.error(e); }
  };

  const loadUserConfig = async () => {
    try {
      const res = await api.get('/user/me');
      setIsLinkedinConfigured(res.data.linkedinConfigured);
      setIsGoogleConfigured(res.data.googleConfigured);
    } catch (e) { console.error(e); }
  };

  const handleLogout = () => {
    clearAuth();
    navigate('/login');
  };

  // Settings Tab Logic
  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.put('/user/config', {
        linkedinClientId, linkedinClientSecret, googleClientId, googleClientSecret
      });
      toast.success('Settings saved successfully');
      setLinkedinClientId(''); setLinkedinClientSecret('');
      setGoogleClientId(''); setGoogleClientSecret('');
      loadUserConfig();
    } catch (e) { toast.error('Failed to save settings'); }
  };

  const connectService = async (service: 'linkedin' | 'sheets') => {
    try {
      const res = await api.get(`/${service}/connect`);
      window.location.href = res.data.url;
    } catch (e) { toast.error('Connection failed'); }
  };

  return (
    <div className="app-shell">
      <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} onLogout={handleLogout} />

      <main className="content-area">

        {activeTab === 'overview' && (
          <div className="tab-content fade-in">
            <header className="content-header">
              <h1>Overview</h1>
              <p className="subtitle">Manage and schedule your content.</p>
            </header>

            {/* Post Filter Tabs */}
            <div className="post-filter-tabs">
              <button
                className={`filter-tab ${postFilter === 'all' ? 'active' : ''}`}
                onClick={() => setPostFilter('all')}
              >
                All Posts
              </button>
              <button
                className={`filter-tab ${postFilter === 'manual' ? 'active' : ''}`}
                onClick={() => setPostFilter('manual')}
              >
                Manual Posts
              </button>
              <button
                className={`filter-tab ${postFilter === 'bot' ? 'active' : ''}`}
                onClick={() => setPostFilter('bot')}
              >
                Bot Posts
              </button>
              <button
                className={`filter-tab ${postFilter === 'published' ? 'active' : ''}`}
                onClick={() => setPostFilter('published')}
              >
                Published
              </button>
            </div>


            <div className="dashboard-grid">
              <section className="left-column">
                <CreatePostForm onPostCreated={loadQueue} />
              </section>
              <section className="right-column">
                <ActivityFeed posts={queue} loading={loading} onRefresh={loadQueue} filter={postFilter} />
              </section>
            </div>
          </div>
        )}

        {activeTab === 'automation' && (
          <div className="tab-content fade-in">
            <header className="content-header">
              <h1>Automation</h1>
              <p className="subtitle">Configure AI trending bots.</p>
            </header>
            <div className="single-column">
              <TrendingBotSettings onGenerationComplete={() => {
                setActiveTab('overview');
                setPostFilter('bot');
              }} />
            </div>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="tab-content fade-in">
            <header className="content-header">
              <h1>Connections</h1>
              <p className="subtitle">Manage external account linkages.</p>
            </header>
            <div className="settings-grid">
              <div className="card settings-card">
                <div className="card-header">
                  <h3>LinkedIn</h3>
                  <span className={`status-badge ${isLinkedinConfigured ? 'connected' : ''}`}>
                    {isLinkedinConfigured ? 'Active' : 'Disconnected'}
                  </span>
                </div>
                <form onSubmit={saveSettings} className="form-stack">
                  <input type="text" placeholder="Client ID" value={linkedinClientId} onChange={e => setLinkedinClientId(e.target.value)} />
                  <input type="password" placeholder="Client Secret" value={linkedinClientSecret} onChange={e => setLinkedinClientSecret(e.target.value)} />
                  <div className="btn-row">
                    <button type="submit" className="btn btn-secondary">Update Keys</button>
                    <button type="button" className="btn btn-primary" onClick={() => connectService('linkedin')} disabled={!isLinkedinConfigured}>
                      {isLinkedinConfigured ? 'Reconnect' : 'Connect Account'}
                    </button>
                  </div>
                </form>
              </div>

              <div className="card settings-card">
                <div className="card-header">
                  <h3>Google Sheets</h3>
                  <span className={`status-badge ${isGoogleConfigured ? 'connected' : ''}`}>
                    {isGoogleConfigured ? 'Active' : 'Disconnected'}
                  </span>
                </div>
                <form onSubmit={saveSettings} className="form-stack">
                  <input type="text" placeholder="Client ID" value={googleClientId} onChange={e => setGoogleClientId(e.target.value)} />
                  <input type="password" placeholder="Client Secret" value={googleClientSecret} onChange={e => setGoogleClientSecret(e.target.value)} />
                  <div className="btn-row">
                    <button type="submit" className="btn btn-secondary">Update Keys</button>
                    <button type="button" className="btn btn-primary" onClick={() => connectService('sheets')} disabled={!isGoogleConfigured}>
                      {isGoogleConfigured ? 'Reconnect' : 'Connect Account'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        )}

      </main>
    </div>
  );
};

export default DashboardPage;


