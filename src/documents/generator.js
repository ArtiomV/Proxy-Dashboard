const { escHtml } = require('../utils/html');

function buildDocHtml(type, doc, client, billAmount, tochkaConfig) {
  const tc = tochkaConfig;
  const sellerName = tc.companyName || 'ООО "ПАЛИТРУМЛАБ"';
  const sellerInn = tc.companyInn || '7727796050';
  const sellerKpp = tc.companyKpp || '773601001';
  const sellerAddress = tc.companyAddress || '119334, г. Москва, ул. Косыгина, д. 13, помещ. 1Ц';
  const bankAccount = tc.bankAccount || '';
  const bankName = tc.bankName || '';
  const bankBic = tc.bankBic || '';
  const bankCorrAccount = tc.bankCorrAccount || '';

  const buyerName = client.legalName || client.name;
  const buyerInn = client.inn || '';
  const buyerKpp = client.kpp || '';
  const buyerAddress = client.address || '';

  const hasBankDetails = bankAccount && bankName && bankBic;
  const sellerBlock = `${escHtml(sellerName)}, ИНН/КПП ${escHtml(sellerInn)}/${escHtml(sellerKpp)}, ${escHtml(sellerAddress)}` +
    (hasBankDetails ? `, р/с ${escHtml(bankAccount)}, в банке ${escHtml(bankName)}, БИК ${escHtml(bankBic)}` + (bankCorrAccount ? `, к/с ${escHtml(bankCorrAccount)}` : '') : '');

  const buyerBlock = `${escHtml(buyerName)}` +
    (buyerInn ? `, ИНН${buyerKpp ? '/КПП' : ''} ${escHtml(buyerInn)}${buyerKpp ? '/' + escHtml(buyerKpp) : ''}` : '') +
    (buyerAddress ? `, ${escHtml(buyerAddress)}` : '');

  let tableRows = '';
  let totalSum = 0;
  const items = type === 'act' ? (doc.items || []) : [{
    name: 'Предоплата за услуги мобильных прокси',
    quantity: 1,
    unit: 'услуга',
    price: billAmount || doc.amount || 0,
    amount: billAmount || doc.amount || 0
  }];

  items.forEach((item, idx) => {
    const qty = item.quantity || 1;
    const price = item.price || 0;
    const amount = item.amount || (qty * price);
    totalSum += amount;
    tableRows += `<tr>
      <td style="border:1px solid #ccc;padding:6px 8px;text-align:center">${idx + 1}</td>
      <td style="border:1px solid #ccc;padding:6px 8px">${escHtml(item.name || 'Услуги мобильных прокси')}</td>
      <td style="border:1px solid #ccc;padding:6px 8px;text-align:center">${escHtml(item.unit || 'услуга')}</td>
      <td style="border:1px solid #ccc;padding:6px 8px;text-align:right">${qty.toLocaleString('ru-RU', { maximumFractionDigits: 3 })}</td>
      <td style="border:1px solid #ccc;padding:6px 8px;text-align:right">${price.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      <td style="border:1px solid #ccc;padding:6px 8px;text-align:right;font-weight:600">${amount.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
    </tr>`;
  });

  const isAct = type === 'act';
  const docTitle = isAct
    ? `АКТ оказанных услуг № ${doc.actNumber || doc.id} от ${(doc.period || '').replace('-', '.')} г.`
    : `СЧЁТ НА ОПЛАТУ № ${doc.billNumber || doc.id} от ${(doc.period || '').replace('-', '.')} г.`;
  const totalFormatted = totalSum.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const contract = doc.contractInfo || client.contractInfo || '';

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<title>${docTitle}</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 12px; color: #000; margin: 20px 40px; }
  h2 { font-size: 15px; text-align: center; margin: 16px 0 8px; }
  .parties { display: flex; gap: 40px; margin: 12px 0; }
  .party { flex: 1; background: #f5f5f5; padding: 8px 12px; border-radius: 4px; font-size: 11px; line-height: 1.5; }
  .party strong { display: block; font-size: 12px; margin-bottom: 2px; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 11px; }
  th { background: #f0f0f0; border: 1px solid #ccc; padding: 6px 8px; text-align: center; font-weight: 600; }
  .total-row td { font-weight: 700; border-top: 2px solid #333; font-size: 12px; }
  .footer { margin-top: 20px; font-size: 11px; }
  .sign-row { display: flex; gap: 60px; margin-top: 30px; }
  .sign-block { flex: 1; }
  .sign-line { border-top: 1px solid #000; margin-top: 40px; font-size: 10px; color: #555; }
  @media print { body { margin: 10px; } button { display: none; } }
</style>
</head>
<body>
<div style="text-align:right;margin-bottom:8px"><button onclick="window.print()" style="padding:6px 16px;background:#185FA5;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px">🖨 Печать</button></div>
<h2>${docTitle}</h2>
${contract ? `<p style="text-align:center;font-size:11px;color:#555">Основание: ${contract}</p>` : ''}
<div class="parties">
  <div class="party"><strong>Исполнитель:</strong>${sellerBlock}</div>
  <div class="party"><strong>Заказчик:</strong>${buyerBlock}</div>
</div>
<table>
  <thead><tr>
    <th style="width:30px">№</th>
    <th>Наименование</th>
    <th style="width:60px">Ед. изм.</th>
    <th style="width:80px">Количество</th>
    <th style="width:100px">Цена, руб.</th>
    <th style="width:110px">Сумма, руб.</th>
  </tr></thead>
  <tbody>${tableRows}
  <tr class="total-row">
    <td colspan="5" style="border:1px solid #ccc;padding:6px 8px;text-align:right">ИТОГО без НДС:</td>
    <td style="border:1px solid #ccc;padding:6px 8px;text-align:right">${totalFormatted}</td>
  </tr>
  <tr>
    <td colspan="5" style="border:1px solid #ccc;padding:4px 8px;text-align:right;color:#555">НДС не облагается</td>
    <td style="border:1px solid #ccc;padding:4px 8px;text-align:right;color:#555">—</td>
  </tr>
  </tbody>
</table>
<div class="footer">
  <p><strong>Всего оказано услуг на сумму: ${totalFormatted} руб. (НДС не облагается)</strong></p>
  ${isAct ? `<p style="margin-top:16px">Вышеперечисленные услуги выполнены полностью и в срок. Заказчик претензий по объёму, качеству и срокам оказания услуг не имеет.</p>` : `<p>Оплата в течение 5 (пяти) банковских дней с момента выставления счёта.</p>`}
</div>
${isAct ? `<div class="sign-row">
  <div class="sign-block"><strong>ИСПОЛНИТЕЛЬ:</strong><div class="sign-line">${sellerName}</div></div>
  <div class="sign-block"><strong>ЗАКАЗЧИК:</strong><div class="sign-line">${buyerName}</div></div>
</div>` : ''}
</body>
</html>`;
}

module.exports = { buildDocHtml };
