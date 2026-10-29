import { FormEvent, useState } from 'react';
import { api, ApiError, errorMessage } from '../api';
import type { PageProps } from '../App';
import { useApi } from '../useApi';

interface Answer {
  answer: string;
  toolsUsed: Array<{ name: string; arguments: Record<string, unknown>; ok: boolean }>;
  model: string;
}

const TOOL_LABELS: Record<string, string> = {
  sales_summary: 'Resumen de ventas',
  sales_by_category: 'Ventas por categoría',
  margins: 'Margen bruto',
  expenses_summary: 'Gastos de caja menor',
  gold_inventory: 'Inventario de oro',
};

const EXAMPLES = [
  '¿Cuánto vendimos hoy y con qué medios de pago?',
  '¿Cuál fue el margen bruto de este mes?',
  '¿Cuántos gramos de oro de 18 kilates quedan?',
  '¿Qué categoría de joyas se vendió más este mes?',
];

export function AssistantPage({ token, onUnauthorized }: PageProps) {
  const status = useApi<{ enabled: boolean; model: string }>('/assistant/status', token, onUnauthorized);
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function ask(event?: FormEvent, text = question) {
    event?.preventDefault();
    setQuestion(text);
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api<Answer>('/assistant/ask', { method: 'POST', token, body: { question: text } }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onUnauthorized();
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (status.data && !status.data.enabled) {
    return (
      <section className="card">
        <h2>Asistente</h2>
        <p className="muted">El asistente no está activo. Inícialo con `make up-ai`, que corre un modelo local con Ollama.</p>
      </section>
    );
  }

  return (
    <div className="grid">
      <form className="card wide" onSubmit={ask}>
        <h2>Pregúntale al negocio</h2>
        <p className="muted">
          Modelo local {status.data?.model ?? ''}: los datos no salen de este equipo. Solo consulta totales; nunca ve datos de clientes.
        </p>
        <label>
          Pregunta
          <input value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={500} required minLength={3} />
        </label>
        <div className="row">
          {EXAMPLES.map((example) => (
            <button key={example} type="button" className="link" onClick={() => void ask(undefined, example)}>
              {example}
            </button>
          ))}
        </div>
        <button type="submit" disabled={busy}>
          {busy ? 'Consultando…' : 'Preguntar'}
        </button>
        {error && <p className="alert error">{error}</p>}
        {result && (
          <div className="answer">
            <p>{result.answer}</p>
            <p className="hint">
              Datos consultados:{' '}
              {result.toolsUsed.length
                ? result.toolsUsed
                    .map((t) => `${TOOL_LABELS[t.name] ?? t.name}${t.arguments.from ? ` (${t.arguments.from} a ${t.arguments.to})` : ''}${t.ok ? '' : ' (error)'}`)
                    .join(' · ')
                : 'ninguno'}
            </p>
          </div>
        )}
      </form>
    </div>
  );
}
