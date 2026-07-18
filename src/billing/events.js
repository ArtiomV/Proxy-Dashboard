'use strict';
// Tiny write-event bus for cache invalidation (WP7.2).
// Any finance-affecting write (ledger entry via atomicCredit/atomicDebit,
// monthly-cost save, client create/update/delete) emits 'finance-write'
// here; the finance dashboard cache subscribes and drops itself — instead
// of expiring manually in exactly one endpoint, like before.
const { EventEmitter } = require('events');
module.exports = new EventEmitter();
