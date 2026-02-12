import React, { useEffect, useState, useContext } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { ToastContext } from '../App';

const GoogleCallbackPage: React.FC = () => {
    const toast = useContext(ToastContext)!;
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const code = searchParams.get('code');

    const [tokens, setTokens] = useState<any>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Form state
    const [spreadsheetId, setSpreadsheetId] = useState('');
    const [range, setRange] = useState('Posts!A:D');

    useEffect(() => {
        if (code && !tokens) {
            exchangeCode(code);
        }
    }, [code]);

    const exchangeCode = async (authCode: string) => {
        setLoading(true);
        try {
            const res = await api.get(`/sheets/callback?code=${authCode}`);
            setTokens(res.data.tokens);
        } catch (err: any) {
            console.error(err);
            setError('Failed to exchange code for tokens');
        } finally {
            setLoading(false);
        }
    };

    const handleSaveConfig = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!tokens) return;
        setLoading(true);
        try {
            await api.post('/sheets/config', {
                spreadsheetId,
                range,
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token
            });
            toast.success('Google Sheets connected successfully!');
            navigate('/dashboard');
        } catch (err: any) {
            console.error(err);
            setError('Failed to save configuration');
        } finally {
            setLoading(false);
        }
    };

    if (!code) {
        return <div className="page-root">No code provided.</div>;
    }

    return (
        <div className="page-root">
            <div className="card" style={{ maxWidth: '500px', margin: '2rem auto' }}>
                <h2>Connect Google Sheets</h2>
                {error && <div className="error-text">{error}</div>}

                {loading && <p>Processing...</p>}

                {!tokens && !loading && !error && <p>Exchanging code...</p>}

                {tokens && (
                    <form onSubmit={handleSaveConfig} className="form-stack">
                        <p><strong>Tokens received!</strong> Now configure your sheet.</p>
                        <label className="form-label">
                            Spreadsheet ID
                            <input
                                className="form-input"
                                value={spreadsheetId}
                                onChange={e => setSpreadsheetId(e.target.value)}
                                required
                                placeholder="e.g. 1BxiMVs0XRA5nFMdKbBdB_..."
                            />
                        </label>
                        <label className="form-label">
                            Range
                            <input
                                className="form-input"
                                value={range}
                                onChange={e => setRange(e.target.value)}
                                required
                                placeholder="Posts!A:D"
                            />
                        </label>
                        <button className="btn btn-primary" type="submit" disabled={loading}>
                            Save and Connect
                        </button>
                    </form>
                )}
            </div>
        </div>
    );
};

export default GoogleCallbackPage;
