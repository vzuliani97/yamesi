import { FormEvent, useState } from 'react';
import { api, errorMessage, User } from '../api';
import type { Session } from '../App';

export function LoginPage({ onSignIn }: { onSignIn: (session: Session) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const result = await api<{ accessToken: string; user: User }>('/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      onSignIn({ token: result.accessToken, user: result.user });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <h1>Joyería Yamesi</h1>
        <p className="muted">Inventario, ventas y caja</p>
        <label>
          Correo
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
        </label>
        <label>
          Contraseña
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
        </label>
        {error && <p className="alert error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Ingresando…' : 'Ingresar'}
        </button>
        <p className="hint">Demo: vendedor@yamesi.local o admin@yamesi.local</p>
      </form>
    </div>
  );
}
