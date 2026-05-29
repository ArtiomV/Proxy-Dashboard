'use strict';

// P2-2: monthly-cost category definitions, extracted from server.js. Consumed by
// the finance routes in src/routes/billing-ext.js (monthly_costs / finance_dashboard).
// `perItem` categories carry a subkey (server name or operator); the rest are flat.
const COST_CATEGORIES = {
  server:      { label: 'Аренда серверов', perItem: true,  itemType: 'server' },   // subkey = S1/S2/...
  sim:         { label: 'SIM-карты',       perItem: true,  itemType: 'operator' }, // subkey = Orange MD / Moldtelecom / ...
  electricity: { label: 'Электричество',   perItem: false },
  hosting:     { label: 'Хостинг/связь',   perItem: false },
  salary:      { label: 'Зарплата',        perItem: false },
  other:       { label: 'Прочее',          perItem: false }
};

module.exports = { COST_CATEGORIES };
