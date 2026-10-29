export type Role = 'ADMIN' | 'SELLER';
export type PaymentMethod = 'CASH' | 'CARD' | 'TRANSFER';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface Lot {
  id: number;
  code: string;
  karat: number;
  supplier: string;
  totalGrams: number;
  remainingGrams: number;
  costPerGram: number;
  purchasedOn: string;
}

export interface Piece {
  id: number;
  sku: string;
  name: string;
  category: string;
  lotCode: string;
  karat: number;
  grams: number;
  price: number;
  status: 'IN_STOCK' | 'SOLD';
  imageUrl: string | null;
}

export interface Invoice {
  id: string;
  number: number;
  businessDate: string;
  customerName: string;
  paymentMethod: PaymentMethod;
  total: number;
  seller: string;
}

export interface Expense {
  id: number;
  category: string;
  description: string;
  amount: number;
  receiptUrl: string | null;
  createdBy: string;
}

export interface DaySummary {
  date: string;
  openingCash: number;
  salesByMethod: Record<PaymentMethod, number>;
  invoiceCount: number;
  expenses: number;
  expectedCash: number;
  closed: boolean;
  closing: { countedCash: number; difference: number; notes: string | null } | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  token?: string;
  headers?: Record<string, string>;
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  let body: BodyInit | undefined;

  if (options.body instanceof FormData) {
    body = options.body; // the browser sets the multipart boundary itself
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  const response = await fetch(`/api${path}`, { method: options.method ?? 'GET', headers, body });

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new ApiError(response.status, data?.error?.code ?? 'HTTP_ERROR', data?.error?.message ?? `HTTP ${response.status}`);
  }
  return response;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return (await send(path, options)).json() as Promise<T>;
}

/** PDFs need the auth header, so they are fetched as a blob and opened from a local URL. */
export async function openPdf(path: string, token: string): Promise<void> {
  const blob = await (await send(path, { token })).blob();
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: 'Correo o contraseña incorrectos.',
  PIECE_NOT_AVAILABLE: 'Una de las piezas ya no está disponible.',
  DAY_CLOSED: 'La caja de hoy ya está cerrada.',
  DAY_ALREADY_CLOSED: 'Este día ya fue cerrado.',
  INSUFFICIENT_GOLD: 'El lote no tiene suficiente oro.',
  INVALID_IMAGE: 'La imagen debe ser JPEG, PNG o WebP.',
  PAYLOAD_TOO_LARGE: 'El archivo supera los 2 MB.',
  ASSISTANT_UNAVAILABLE: 'El modelo de IA no está disponible en este momento.',
  UNAUTHORIZED: 'Tu sesión expiró. Vuelve a ingresar.',
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return MESSAGES[error.code] ?? error.message;
  }
  return 'No fue posible conectar con el servidor. Intenta de nuevo.';
}
