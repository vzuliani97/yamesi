import { useCallback, useState } from 'react';
import { User } from './api';
import { AssistantPage } from './pages/Assistant';
import { ClosingPage } from './pages/Closing';
import { InventoryPage } from './pages/Inventory';
import { LoginPage } from './pages/Login';
import { PettyCashPage } from './pages/PettyCash';
import { ReportsPage } from './pages/Reports';
import { SellPage } from './pages/Sell';

export interface Session {
  token: string;
  user: User;
}

export interface PageProps {
  token: string;
  user: User;
  onUnauthorized: () => void;
}

const STORAGE_KEY = 'yamesi.session';

const TABS = [
  { id: 'sell', label: 'Vender', page: SellPage, adminOnly: false },
  { id: 'inventory', label: 'Inventario', page: InventoryPage, adminOnly: false },
  { id: 'petty-cash', label: 'Caja menor', page: PettyCashPage, adminOnly: false },
  { id: 'closing', label: 'Cierre de caja', page: ClosingPage, adminOnly: false },
  { id: 'reports', label: 'Reportes', page: ReportsPage, adminOnly: true },
  { id: 'assistant', label: 'Asistente', page: AssistantPage, adminOnly: true },
] as const;

function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function App() {
  const [session, setSession] = useState<Session | null>(loadSession);
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('sell');

  const signIn = (next: Session) => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setSession(next);
  };

  // Stable identity, so pages can list it as an effect dependency without reloading in a loop.
  const signOut = useCallback(() => {
    sessionStorage.removeItem(STORAGE_KEY);
    setSession(null);
  }, []);

  if (!session) {
    return <LoginPage onSignIn={signIn} />;
  }

  const tabs = TABS.filter((t) => !t.adminOnly || session.user.role === 'ADMIN');
  const Page = (tabs.find((t) => t.id === tab) ?? tabs[0]).page;

  return (
    <div className="layout">
      <header className="topbar">
        <strong>Joyería Yamesi</strong>
        <nav className="tabs">
          {tabs.map((t) => (
            <button key={t.id} className={t.id === tab ? 'tab active' : 'tab'} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <span className="muted">
          {session.user.name} · {session.user.role === 'ADMIN' ? 'Administración' : 'Ventas'}
        </span>
        <button className="link" onClick={signOut}>
          Salir
        </button>
      </header>
      <main>
        <Page token={session.token} user={session.user} onUnauthorized={signOut} />
      </main>
    </div>
  );
}
