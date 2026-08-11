import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useBootstrapAuth, useAuth } from '@/hooks/useAuth';
import { useAccessBlock } from '@/store/appStore';
import { AppShell } from '@/components/layout/AppShell';
import { Spinner } from '@/components/ui/States';
import Login from '@/routes/Login';
import AcceptInvite from '@/routes/AcceptInvite';
import Dashboard from '@/routes/Dashboard';
import Connections from '@/routes/Connections';
import ConnectionWorkspace from '@/routes/ConnectionWorkspace';
import ConnectionCreate from '@/routes/ConnectionCreate';
import Account from '@/routes/Account';
import Conversations from '@/routes/Conversations';
import ConversationDetail from '@/routes/ConversationDetail';
import Audios from '@/routes/Audios';
import Products from '@/routes/Products';
import Messages from '@/routes/Messages';
import Keywords from '@/routes/Keywords';
import Broadcasts from '@/routes/Broadcasts';
import PasteConversation from '@/routes/PasteConversation';
import Admin from '@/routes/Admin';

/** Teste vencido / conta desativada: o painel para aqui, com explicação. */
function AccessBlocked({ message }: { message: string }) {
  const { logout } = useAuth();
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-bg bg-app-radial px-6 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-warning/15 text-3xl">
        ⏳
      </div>
      <div className="max-w-sm">
        <h1 className="mb-2 text-xl font-extrabold text-text-primary">Acesso pausado</h1>
        <p className="text-sm text-text-secondary">{message}</p>
      </div>
      <button
        onClick={logout}
        className="rounded-xl border border-border px-4 py-2 text-sm font-semibold text-text-secondary transition hover:text-text-primary"
      >
        Sair
      </button>
    </div>
  );
}

function ProtectedRoutes() {
  const { isAuthenticated, isInitialized } = useAuth();
  const blockedMessage = useAccessBlock((s) => s.message);
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

  if (blockedMessage) return <AccessBlocked message={blockedMessage} />;

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Connections />} />
        <Route path="/conexoes/nova" element={<ConnectionCreate />} />
        <Route path="/conexoes/:connectionId" element={<ConnectionWorkspace />} />
        <Route path="/conta" element={<Account />} />
        <Route path="/configuracoes" element={<Navigate to="/conta" replace />} />
        <Route path="/painel" element={<Dashboard />} />
        <Route path="/conversas" element={<Conversations />} />
        <Route path="/conversas/:id" element={<ConversationDetail />} />
        <Route path="/audios" element={<Audios />} />
        <Route path="/produtos" element={<Products />} />
        <Route path="/disparos" element={<Broadcasts />} />
        <Route path="/scripts" element={<Messages />} />
        <Route path="/keywords" element={<Keywords />} />
        <Route path="/colar-conversa" element={<PasteConversation />} />
        <Route path="/admin" element={<Admin />} />
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
      {/* Público: o convidado cria a conta antes de existir sessão. */}
      <Route path="/convite/:token" element={<AcceptInvite />} />
      <Route path="/*" element={<ProtectedRoutes />} />
    </Routes>
  );
}
