import { describe,it,expect } from 'vitest';
import { createRequire } from 'module';

const require=createRequire(import.meta.url);
const ports=require('../src/routes/proxies-ports.js');

describe('создание порта ProxySmart',()=>{
  it('нормализует и строго проверяет имя до отправки формы',()=>{
    expect(ports.validPortName('  client_01  ')).toEqual({ok:true,name:'client_01'});
    expect(ports.validPortName('ab').ok).toBe(false);
    expect(ports.validPortName('@client').ok).toBe(false);
    expect(ports.validPortName('client name').ok).toBe(false);
  });

  it('подтверждает порт по авторитетному portID, а не поиском подстроки в JSON',()=>{
    const list={'8601':[{portID:'port-12',portName:'client'}]};
    expect(ports.portPersisted(list,'port-12','8601')).toBe(true);
    expect(ports.portPersisted(list,'port-1','8601')).toBe(false);
    expect(ports.portPersisted(list,'port-12','wrong-imei')).toBe(true);
  });
});
