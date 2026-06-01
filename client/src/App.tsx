import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useBootstrapAuth, useAuth } from '@/hooks/useAuth';
import { AppShell } from '@/components/layout/AppShell';
import { Spinner } from '@/components/ui/States';
import Login from '@/routes/Login';
import Dashboard from '@/routes/Dashboard';
import Conversations from '@/routes/Conversations';
import ConversationDetail from '@/routes/ConversationDetail';
import Audios from '@/routes/Audios';
import Products from '@/routes/Products';
import Messages from '@/routes/Messages';
import Keywords from '@/routes/Keywords';
import Settings from '@/routes/Settings';

function ProtectedRoutes() {
  const { isAuthenticated, isInitialized } = useAuth();
  const location = useLocation();

  if (!isInitialized) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner label="Carregando..." />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/conversas" element={<Conversations />} />
        <Route path="/conversas/:id" element={<ConversationDetail />} />
        <Route path="/audios" element={<Audios />} />
        <Route path="/produtos" element={<Products />} />
        <Route path="/scripts" element={<Messages />} />
        <Route path="/keywords" element={<Keywords />} />
        <Route path="/configuracoes" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}

export default function App() {
  useBootstrapAuth();

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/*" element={<ProtectedRoutes />} />
    </Routes>
  );
}
