import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { setAuth } from '../auth';

const usernameRegex = /^[a-zA-Z0-9][a-zA-Z0-9_.]{2,19}$/; // 3–20, starts with alnum

const LoginPage: React.FC = () => {
  const navigate = useNavigate();

  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [username, setUsername] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const isRegister = mode === 'register';

  const clientValidationError = useMemo(() => {
    if (!isRegister) return null;

    if (!username.trim()) return 'Username is required';
    if (!usernameRegex.test(username.trim())) {
      return 'Username must be 3–20 characters, start with a letter/number, and contain only letters, numbers, "_" or "."';
    }
    if (password.length < 6) return 'Password must be at least 6 characters';
    if (password !== confirmPassword) return 'Passwords do not match';

    return null;
  }, [isRegister, username, password, confirmPassword]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;

    setError(null);
    if (clientValidationError) {
      setError(clientValidationError);
      return;
    }

    setLoading(true);
    try {
      const endpoint = isRegister ? '/auth/register' : '/auth/login';
      const payload = isRegister
        ? { email, password, username: username.trim() }
        : { email, password };

      const res = await api.post(endpoint, payload);
      setAuth(res.data.token, res.data.user ?? null);
      navigate('/dashboard');
    } catch (err: any) {
      console.error(err);
      setError(err?.response?.data?.error || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  const toggleMode = () => {
    const nextMode = isRegister ? 'login' : 'register';
    setMode(nextMode);
    setError(null);

    if (nextMode === 'login') {
      setUsername('');
      setConfirmPassword('');
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-shell">
        <div className="auth-card">
          <div className="auth-header">
            <div className="auth-logo">in</div>
            <div>
              <h1 className="auth-title">LinkedIn Bot</h1>
              <p className="auth-subtitle">
                {isRegister ? 'Create a new account' : 'Log in to your account'}
              </p>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="auth-form" noValidate>
            <div className="auth-grid">
              {isRegister && (
                <div className="field">
                  <label className="label">Username</label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="input"
                    autoComplete="username"
                    placeholder="e.g. ahmed_khan"
                  />
                </div>
              )}

              <div className="field">
                <label className="label">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="input"
                  autoComplete="email"
                  placeholder="you@example.com"
                />
              </div>

              <div className="field">
                <label className="label">Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input"
                  autoComplete={isRegister ? 'new-password' : 'current-password'}
                  placeholder="••••••••"
                />
              </div>

              {isRegister && (
                <div className="field">
                  <label className="label">Confirm password</label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="input"
                    autoComplete="new-password"
                    placeholder="••••••••"
                  />
                </div>
              )}
            </div>

            {error && <div className="auth-error">{error}</div>}

            <button className="primary-btn" type="submit" disabled={loading}>
              {loading ? 'Please wait…' : isRegister ? 'Create account' : 'Login'}
            </button>
          </form>

          <div className="auth-footer">
            <button className="text-btn" onClick={toggleMode} type="button">
              {isRegister ? 'Already have an account? Login' : "Don't have an account? Register"}
            </button>
          </div>
        </div>

        <div className="auth-hint">
          <span className="dot" />
          Tip: After logging in, go to <b>Settings</b> to add your LinkedIn & Google API keys.
        </div>
      </div>
    </div>
  );
};

export default LoginPage;
