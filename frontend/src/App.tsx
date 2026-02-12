import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import GoogleCallbackPage from './pages/GoogleCallbackPage';
import { getToken } from './auth';
import './styles.css';
import './styles/toast.css';
import ToastContainer from './components/ToastContainer';
import { useToast } from './hooks/useToast';

export const ToastContext = React.createContext<ReturnType<typeof useToast> | null>(null);

const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const token = getToken();
  if (!token) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
};

const App: React.FC = () => {
  const toast = useToast();

  return (
    <ToastContext.Provider value={toast}>
      <ToastContainer toasts={toast.toasts} removeToast={toast.removeToast} />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <DashboardPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/google-callback"
          element={
            <ProtectedRoute>
              <GoogleCallbackPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/"
          element={<Navigate to="/dashboard" replace />}
        />
      </Routes>
    </ToastContext.Provider>
  );
};

export default App;
