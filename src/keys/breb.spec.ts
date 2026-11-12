import { BREB_KEY_TYPES, detectKey, maskKey, maskName, phoneDigits } from './breb';

/** Llaves Banklite: cómo se reconoce cada tipo y cómo se muestra a medias (mismas reglas que el frontend). */
describe('detectKey', () => {
  it.each([
    ['3001234567', 'celular', '3001234567'],
    [' 300 123 4567 ', 'celular', '3001234567'],
    ['300-123-4567', 'celular', '3001234567'],
    ['Ana.Perez@Banklite.Test', 'correo', 'ana.perez@banklite.test'],
    ['1.020.304.050', 'documento', '1020304050'],
    ['123456', 'documento', '123456'],
    ['@Ana.Perez_99', 'alfanumerica', '@ana.perez_99'],
  ])('%s se reconoce como %s', (raw, type, key) => {
    expect(detectKey(raw)).toEqual({ type, key });
  });

  it.each([
    '',
    '   ',
    '12345', // documento muy corto
    '12345678901', // 11 dígitos: ni celular ni documento
    '2001234567', // celular que no empieza por 3 (y 10 dígitos = documento)
    '@ab', // personalizada muy corta
    '@' + 'a'.repeat(21),
    'sin-arroba.com',
    'a@b',
    'a b@c.co',
  ])('"%s" no es una llave válida', (raw) => {
    const found = detectKey(raw);
    // Un número de 10 dígitos que no empieza por 3 sí es un documento válido.
    if (raw === '2001234567') expect(found).toEqual({ type: 'documento', key: raw });
    else expect(found).toBeNull();
  });

  it('un correo de más de 120 caracteres no vale, y un valor nulo no rompe', () => {
    expect(detectKey(`${'a'.repeat(116)}@b.co`)).toBeNull();
    expect(detectKey(undefined as never)).toBeNull();
  });

  it('el celular gana al documento cuando empieza por 3 y tiene 10 dígitos', () => {
    expect(detectKey('3101234567')?.type).toBe('celular');
    expect(BREB_KEY_TYPES).toEqual(['celular', 'correo', 'documento', 'alfanumerica']);
  });
});

describe('maskKey', () => {
  it('muestra a medias cada tipo sin revelar la llave completa', () => {
    expect(maskKey('3001234567', 'celular')).toBe('300 ••• 4567');
    expect(maskKey('1020304050', 'documento')).toBe('••• 4050');
    expect(maskKey('ana.perez@banklite.test', 'correo')).toBe('an•••••@banklite.test');
    expect(maskKey('a@b.co', 'correo')).toBe('a•@b.co');
    expect(maskKey('@ana99', 'alfanumerica')).toBe('@ana99');
  });
});

describe('maskName', () => {
  it('deja las tres primeras letras de cada palabra (hasta tres palabras)', () => {
    expect(maskName('Laura Gómez Pérez')).toBe('Lau•• Góm•• Pér••');
    expect(maskName('Ana de la Cruz Rodríguez')).toBe('Ana de la');
    expect(maskName('  Juan   Sebastián ')).toBe('Jua• Seb••••');
  });

  it('sin nombre usa uno genérico', () => {
    expect(maskName('')).toBe('Cliente Banklite');
    expect(maskName('   ')).toBe('Cliente Banklite');
    expect(maskName(undefined as never)).toBe('Cliente Banklite');
  });
});

describe('phoneDigits', () => {
  it('deja 10 dígitos aunque KYC lo guarde con +57', () => {
    expect(phoneDigits('+57 300 123 4567')).toBe('3001234567');
    expect(phoneDigits('3001234567')).toBe('3001234567');
    expect(phoneDigits(null)).toBe('');
    expect(phoneDigits(undefined)).toBe('');
  });
});
