/**
 * Llaves Banklite: tipos, cómo se reconoce cada una y cómo se muestran a medias.
 * Las mismas reglas que usa el frontend (llaves.js / transferir.js).
 */
export type BrebKeyType = 'celular' | 'correo' | 'documento' | 'alfanumerica';

export const BREB_KEY_TYPES: BrebKeyType[] = ['celular', 'correo', 'documento', 'alfanumerica'];

export const BREB_LABELS: Record<BrebKeyType, string> = {
  celular: 'Celular',
  correo: 'Correo',
  documento: 'Documento',
  alfanumerica: 'Llave personalizada',
};

/** Reconoce el tipo de llave y la deja normalizada (minúsculas, sin espacios ni puntos). */
export function detectKey(raw: string): { type: BrebKeyType; key: string } | null {
  const value = String(raw ?? '').trim();
  const digits = value.replace(/[\s.-]/g, '');
  if (/^@[a-z0-9._]{3,20}$/i.test(value)) return { type: 'alfanumerica', key: value.toLowerCase() };
  if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(value) && value.length <= 120)
    return { type: 'correo', key: value.toLowerCase() };
  if (/^3\d{9}$/.test(digits)) return { type: 'celular', key: digits };
  if (/^\d{6,10}$/.test(digits)) return { type: 'documento', key: digits };
  return null;
}

export function maskKey(key: string, type: BrebKeyType): string {
  if (type === 'celular') return `${key.slice(0, 3)} ••• ${key.slice(-4)}`;
  if (type === 'documento') return `••• ${key.slice(-4)}`;
  if (type === 'correo') {
    const [user, domain] = key.split('@');
    return `${user.slice(0, 2)}${'•'.repeat(Math.max(1, Math.min(user.length - 2, 5)))}@${domain}`;
  }
  return key;
}

/** El nombre se muestra a medias para confirmar sin revelarlo completo: "Lau••• Góm•••". */
export function maskName(name: string): string {
  return (
    String(name ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3)
      .map((word) => (word.length <= 3 ? word : word.slice(0, 3) + '•'.repeat(Math.min(word.length - 3, 4))))
      .join(' ') || 'Cliente Banklite'
  );
}

/** Celular a 10 dígitos (KYC puede guardarlo con +57). */
export function phoneDigits(value: string | null | undefined): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}
