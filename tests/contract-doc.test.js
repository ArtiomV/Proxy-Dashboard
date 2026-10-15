import { describe, it, expect } from 'vitest';
const { genName, genPosition, shortName, buildContract, isIp } = require('../src/documents/contract');
const JSZip = require('jszip');

describe('contract: склонение', () => {
  it('ФИО', () => {
    expect(genName('Жуков Дмитрий Андреевич')).toBe('Жукова Дмитрия Андреевича');
    expect(genName('Иванов Иван Иванович')).toBe('Иванова Ивана Ивановича');
    expect(genName('Петрова Анна Сергеевна')).toBe('Петровой Анны Сергеевны');
  });
  it('должность и сокращение', () => {
    expect(genPosition('Генеральный директор')).toBe('Генерального директора');
    expect(shortName('Иванов Иван Иванович')).toBe('Иванов И. И.');
  });
});

describe('contract: сборка docx', () => {
  const org = { legal_name: 'ООО «Ромашка»', inn: '7701234567', kpp: '770101001', ogrn: '1027700000000', legal_address: 'Москва', account: '40702810000000000001', bank_name: 'Банк', corr_account: '30101810000000000001', bik: '044525000', contact_email: 'a@b.ru', contact_phone: '+7900', signer_name: 'Иванов Иван Иванович', signer_position: 'Генеральный директор', signer_basis: 'Устава' };
  async function text(r) {
    const buf = await buildContract(r, 'ЛК-2026-001', new Date('2026-10-15T12:00:00'));
    const zip = await JSZip.loadAsync(buf);
    return (await zip.file('word/document.xml').async('string'));
  }
  it('организация: номер, преамбула, реквизиты', async () => {
    const x = await text(org);
    expect(x).toContain('ЛК-2026-001');
    expect(x).toContain('в лице Генерального директора Иванова Ивана Ивановича');
    expect(x).toContain('КПП: 770101001');
    expect(x).not.toContain('(наименование организации)');
  });
  it('ИП: ОГРНИП и КПП «—»', async () => {
    const r = { ...org, inn: '770212345678', legal_name: 'ИП Сидоров Пётр', ogrn: '321770000000001' };
    expect(isIp(r)).toBe(true);
    const x = await text(r);
    expect(x).toContain('ОГРНИП: 321770000000001');
    expect(x).toContain('КПП: —');
  });
});
