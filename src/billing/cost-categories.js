'use strict';

// P2-2: monthly-cost category definitions, extracted from server.js. Consumed by
// the finance routes in src/routes/billing-ext.js (monthly_costs / finance_dashboard).
// `perItem` categories carry a subkey (location or operator); only truly global
// expenses remain flat. All site-specific costs use the same location key.
const COST_CATEGORIES = {
  server:      { label: 'Аренда площадок', perItem: true,  itemType: 'location' }, // subkey = location:<address>
  sim:         { label: 'SIM-карты',       perItem: true,  itemType: 'operator' }, // subkey = Orange MD / Moldtelecom / ...
  electricity: { label: 'Электричество',   perItem: true,  itemType: 'location' },
  hosting:     { label: 'Связь',            perItem: true,  itemType: 'location' },
  salary:      { label: 'Команда',          perItem: true,  itemType: 'location' },
  other:       { label: 'Прочее',          perItem: false }
};

module.exports = { COST_CATEGORIES };
