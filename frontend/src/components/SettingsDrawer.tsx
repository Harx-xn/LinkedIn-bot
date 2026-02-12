import React, { useState, useContext } from 'react';
import { api } from '../api';
import { ToastContext } from '../App';

interface SettingsDrawerProps {
    isOpen: boolean;
    onClose: () => void;
    isLinkedinConfigured: boolean;
    isGoogleConfigured: boolean;
    onConfigSave: () => void;
}

const SettingsDrawer: React.FC<SettingsDrawerProps> = ({
    isOpen, onClose, isLinkedinConfigured, isGoogleConfigured, onConfigSave
}) => {
    const toast = useContext(ToastContext)!;
    const [linkedinClientId, setLinkedinClientId] = useState('');
    const [linkedinClientSecret, setLinkedinClientSecret] = useState('');
    const [googleClientId, setGoogleClientId] = useState('');
    const [googleClientSecret, setGoogleClientSecret] = useState('');
    const [loading, setLoading] = useState(false);

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        try {
            await api.put('/user/config', {
                linkedinClientId,
                linkedinClientSecret,
                googleClientId,
                googleClientSecret
            });
            toast.success('Settings saved!');
            setLinkedinClientId('');
            setLinkedinClientSecret('');
            setGoogleClientId('');
            setGoogleClientSecret('');
            onConfigSave();
        } catch (err) {
            console.error(err);
            toast.error('Failed to save settings');
        } finally {
            setLoading(false);
        }
    };

    const connectLinkedIn = async () => {
        try {
            const res = await api.get('/linkedin/connect');
            window.location.href = res.data.url;
        } catch (err) {
            toast.error('Failed to get LinkedIn URL');
        }
    };

    const connectGoogle = async () => {
        try {
            const res = await api.get('/sheets/connect');
            window.location.href = res.data.url;
        } catch (err) {
            toast.error('Failed to get Google URL');
        }
    };

    return (
        <>
            {isOpen && <div className="drawer-overlay" onClick={onClose} />}
            <div className={`drawer ${isOpen ? 'open' : ''}`}>
                <div className="drawer-header">
                    <h2>Configuration</h2>
                    <button className="btn-close" onClick={onClose}>&times;</button>
                </div>

                <div className="drawer-content">
                    <section className="drawer-section">
                        <h3>LinkedIn Connection</h3>
                        <div className="status-indicator">
                            <span className={`status-dot ${isLinkedinConfigured ? 'green' : 'red'}`} />
                            {isLinkedinConfigured ? 'Connected' : 'Not Configured'}
                        </div>

                        <form onSubmit={handleSave} className="form-stack">
                            <label>Client ID
                                <input type="text" value={linkedinClientId} onChange={e => setLinkedinClientId(e.target.value)} placeholder="Update Client ID" />
                            </label>
                            <label>Client Secret
                                <input type="password" value={linkedinClientSecret} onChange={e => setLinkedinClientSecret(e.target.value)} placeholder="Update Client Secret" />
                            </label>
                            <button type="submit" className="btn btn-secondary" disabled={loading}>Update Credentials</button>
                        </form>

                        <button className="btn btn-primary full-width mt-4" onClick={connectLinkedIn} disabled={!isLinkedinConfigured}>
                            {isLinkedinConfigured ? 'Reconnect LinkedIn' : 'Connect LinkedIn Account'}
                        </button>
                    </section>

                    <hr className="drawer-divider" />

                    <section className="drawer-section">
                        <h3>Google Sheets</h3>
                        <div className="status-indicator">
                            <span className={`status-dot ${isGoogleConfigured ? 'green' : 'red'}`} />
                            {isGoogleConfigured ? 'Connected' : 'Not Configured'}
                        </div>

                        <form onSubmit={handleSave} className="form-stack">
                            <label>Client ID
                                <input type="text" value={googleClientId} onChange={e => setGoogleClientId(e.target.value)} placeholder="Update Client ID" />
                            </label>
                            <label>Client Secret
                                <input type="password" value={googleClientSecret} onChange={e => setGoogleClientSecret(e.target.value)} placeholder="Update Client Secret" />
                            </label>
                            <button type="submit" className="btn btn-secondary" disabled={loading}>Update Credentials</button>
                        </form>

                        <button className="btn btn-primary full-width mt-4" onClick={connectGoogle} disabled={!isGoogleConfigured}>
                            {isGoogleConfigured ? 'Reconnect Google Sheets' : 'Connect Google Sheets'}
                        </button>
                    </section>
                </div>
            </div>
        </>
    );
};

export default SettingsDrawer;
