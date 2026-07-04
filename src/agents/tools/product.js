'use strict';

/**
 * Product knowledge for the sales department — proxies.rent mobile 4G/LTE
 * proxies. Returned to the agent so outreach drafts are accurate (offer,
 * geo, USPs, use-cases, pricing model). Edit this as the offer changes; it is
 * the single source of truth the sales agents quote from.
 */

const KNOWLEDGE = `
Продукт: proxies.rent — мобильные 4G/LTE прокси (HTTP/SOCKS5) на парке USB-модемов.
Гео: несколько локаций (например Молдова MD и др.), реальные мобильные IP операторов.

Ключевые преимущества:
- Реальные мобильные IP (не дата-центр) → высокий траст, низкий бан-рейт.
- Ротация IP по запросу и по таймеру.
- Личный кабинет: реквизиты прокси, аналитика трафика, биллинг, документы.
- Мониторинг аптайма и авто-восстановление офлайн-модемов.

Тарификация: руб/ГБ по трафику, либо за модем, либо фиксированная подписка (зависит от объёма).
Реферальная программа: 15% комиссии за приведённых клиентов (выгодно reseller'ам и партнёрам).

Под кого (ICP):
- Арбитраж трафика (Facebook/Google Ads), фарм и мультиаккаунтинг.
- Пользователи антидетект-браузеров (Dolphin{anty}, AdsPower, GoLogin, Octo Browser).
- SMM-агентства и фермы аккаунтов (Instagram, TikTok).
- Парсинг/скрейпинг, ad-verification, мониторинг выдачи.
- Маркетплейс-мультиаккаунтинг (Avito, Wildberries и т.п.).
- Reseller'ы прокси (B2B-перепродажа) — самый ценный сегмент.

Боли, которые закрываем: баны аккаунтов на дата-центр прокси, нужен чистый мобильный IP,
гибкая ротация, прозрачный биллинг по трафику, стабильность и поддержка.
`.trim();

const productKnowledge = {
  name: 'product_knowledge',
  description:
    'Справка о продукте proxies.rent: оффер, тарифы, гео, преимущества, ICP. ' +
    'Вызывай ПЕРЕД составлением аутрича, чтобы предложение было точным и не выдуманным.',
  input_schema: { type: 'object', properties: {} },
  async run() { return KNOWLEDGE; },
};

module.exports = { productKnowledge, KNOWLEDGE };
