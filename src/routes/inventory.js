'use strict';

// Admin inventory:
//   - equipment grouped by the same physical locations as monthly costs;
//   - imported ICCID -> phone directory, automatically matched to modem_meta.

const express = require('express');
const { buildCostLocations } = require('../billing/cost-locations');
const { normalizeIccid, normalizePhone, parseSimRegistryText } = require('../inventory/sim-registry');

module.exports = function createInventoryRouter(deps) {
  const {
    db, logger, authMiddleware, adminMiddleware,
    getApiServers, getServerCountries, logActivity,
  } = deps;
  const r = express.Router();

  const equipmentList = db.prepare(
    'SELECT id, location_key, equipment_type, quantity, notes, created_at, updated_at ' +
    'FROM equipment_inventory ORDER BY location_key, equipment_type COLLATE NOCASE'
  );
  const equipmentGet = db.prepare('SELECT * FROM equipment_inventory WHERE id = ?');
  const equipmentUpsert = db.prepare(
    `INSERT INTO equipment_inventory (location_key, equipment_type, quantity, notes)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(location_key, equipment_type) DO UPDATE SET
       quantity = excluded.quantity,
       notes = excluded.notes,
       updated_at = datetime('now')`
  );
  const equipmentUpdate = db.prepare(
    `UPDATE equipment_inventory SET location_key = ?, equipment_type = ?, quantity = ?, notes = ?,
       updated_at = datetime('now') WHERE id = ?`
  );
  const equipmentDelete = db.prepare('DELETE FROM equipment_inventory WHERE id = ?');

  const registryList = db.prepare(
    'SELECT iccid, phone, operator, notes, source, imported_at, updated_at FROM sim_registry ORDER BY updated_at DESC, iccid'
  );
  const registryGet = db.prepare('SELECT iccid, phone, operator, notes FROM sim_registry WHERE iccid = ?');
  const registryUpsert = db.prepare(
    `INSERT INTO sim_registry (iccid, phone, operator, notes, source)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(iccid) DO UPDATE SET
       phone = excluded.phone,
       operator = excluded.operator,
       notes = excluded.notes,
       source = excluded.source,
       updated_at = datetime('now')`
  );
  const registryDelete = db.prepare('DELETE FROM sim_registry WHERE iccid = ?');
  const modemMetaWithIccid = db.prepare(
    `SELECT server_name, imei, nick, operator, phone, iccid, updated_at
       FROM modem_meta
      WHERE iccid IS NOT NULL AND TRIM(iccid) != ''
        AND (deleted IS NULL OR deleted = 0)
      ORDER BY server_name, nick`
  );
  const modemMetaWithoutIccidCount = db.prepare(
    `SELECT COUNT(*) AS total FROM modem_meta
      WHERE (iccid IS NULL OR TRIM(iccid) = '')
        AND nick IS NOT NULL AND TRIM(nick) != ''
        AND (deleted IS NULL OR deleted = 0)`
  );
  const modemPhoneUpdate = db.prepare(
    "UPDATE modem_meta SET phone = ?, updated_at = datetime('now') WHERE server_name = ? AND imei = ?"
  );

  function locations() {
    return buildCostLocations(
      typeof getApiServers === 'function' ? getApiServers() : [],
      typeof getServerCountries === 'function' ? getServerCountries() : {}
    );
  }

  function cleanEquipment(body) {
    const locationKey = String((body && body.location_key) || '').trim();
    const equipmentType = String((body && body.equipment_type) || '').replace(/\s+/g, ' ').trim();
    const quantity = Number(body && body.quantity);
    const notes = String((body && body.notes) || '').trim();
    if (!locationKey || !locations().some(location => location.key === locationKey)) {
      throw new Error('Выберите существующую локацию');
    }
    if (!equipmentType || equipmentType.length > 120) throw new Error('Укажите тип оборудования (до 120 символов)');
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 1000000) {
      throw new Error('Количество должно быть целым числом от 0 до 1 000 000');
    }
    if (notes.length > 500) throw new Error('Примечание — не более 500 символов');
    return { locationKey, equipmentType, quantity, notes };
  }

  function registryRowsWithBindings() {
    const serverNames = new Map((typeof getApiServers === 'function' ? getApiServers() : [])
      .map(server => [server.name, server.displayName || server.name]));
    const byIccid = new Map();
    for (const row of modemMetaWithIccid.all()) {
      const iccid = normalizeIccid(row.iccid);
      if (!iccid) continue;
      const binding = {
        server: row.server_name,
        server_name: serverNames.get(row.server_name) || row.server_name,
        imei: row.imei,
        nick: row.nick,
        operator: row.operator,
        modem_phone: row.phone,
        updated_at: row.updated_at,
      };
      if (!byIccid.has(iccid)) byIccid.set(iccid, []);
      byIccid.get(iccid).push(binding);
    }

    const registered = registryList.all().map(row => {
      const bindings = byIccid.get(row.iccid) || [];
      byIccid.delete(row.iccid);
      const conflict = bindings.some(binding => {
        const modemPhone = normalizePhone(binding.modem_phone);
        return modemPhone && modemPhone !== normalizePhone(row.phone);
      });
      return { ...row, registered: true, matched: bindings.length > 0, conflict, bindings };
    });
    const discovered = Array.from(byIccid.entries()).map(([iccid, bindings]) => ({
      iccid,
      phone: (bindings.find(binding => normalizePhone(binding.modem_phone)) || {}).modem_phone || '',
      operator: (bindings.find(binding => binding.operator) || {}).operator || '',
      notes: '',
      source: 'detected',
      imported_at: '',
      updated_at: (bindings[0] && bindings[0].updated_at) || '',
      registered: false,
      matched: true,
      conflict: false,
      bindings,
    }));
    const items = registered.concat(discovered);
    const knownIccids = new Set(items.filter(item => item.bindings.length).map(item => item.iccid));
    return {
      items,
      summary: {
        registry_total: registered.length,
        registry_matched: registered.filter(item => item.matched).length,
        detected_not_registered: discovered.length,
        known_iccids: knownIccids.size,
        phone_missing: items.filter(item => item.bindings.length && !normalizePhone(item.phone)).length,
        modems_without_iccid: modemMetaWithoutIccidCount.get().total || 0,
        conflicts: registered.filter(item => item.conflict).length,
      },
    };
  }

  function syncModemPhones(rows) {
    const phoneByIccid = new Map(rows.map(row => [row.iccid, row.phone]));
    const matched = new Set();
    let updated = 0;
    for (const modem of modemMetaWithIccid.all()) {
      const iccid = normalizeIccid(modem.iccid);
      const phone = phoneByIccid.get(iccid);
      if (!phone) continue;
      matched.add(iccid);
      if (normalizePhone(modem.phone) !== normalizePhone(phone)) {
        updated += modemPhoneUpdate.run(phone, modem.server_name, modem.imei).changes;
      }
    }
    return { matched: matched.size, modem_rows_updated: updated };
  }

  function upsertRegistryRows(rows, source) {
    let inserted = 0;
    let updated = 0;
    const tx = db.transaction(() => {
      for (const row of rows) {
        if (registryGet.get(row.iccid)) updated += 1;
        else inserted += 1;
        registryUpsert.run(row.iccid, row.phone, row.operator || '', row.notes || '', source);
      }
      return syncModemPhones(rows);
    });
    const syncResult = tx();
    return { inserted, updated, ...syncResult };
  }

  r.get('/api/admin/equipment', authMiddleware, adminMiddleware, (req, res) => {
    try {
      const currentLocations = locations();
      const items = equipmentList.all();
      const knownKeys = new Set(currentLocations.map(location => location.key));
      const orphanLocations = Array.from(new Set(items.map(item => item.location_key).filter(key => !knownKeys.has(key))))
        .map(key => ({ key, label: key, address: '', country: '', servers: [], missing: true }));
      res.json({
        locations: currentLocations.concat(orphanLocations),
        items,
        summary: {
          total_units: items.reduce((sum, item) => sum + item.quantity, 0),
          equipment_types: new Set(items.map(item => item.equipment_type.toLowerCase())).size,
          locations_with_equipment: new Set(items.map(item => item.location_key)).size,
        },
      });
    } catch (e) {
      logger.error('[Inventory] equipment list: ' + e.message);
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/api/admin/equipment', authMiddleware, adminMiddleware, (req, res) => {
    try {
      const item = cleanEquipment(req.body || {});
      equipmentUpsert.run(item.locationKey, item.equipmentType, item.quantity, item.notes);
      const saved = db.prepare(
        'SELECT * FROM equipment_inventory WHERE location_key = ? AND equipment_type = ? COLLATE NOCASE'
      ).get(item.locationKey, item.equipmentType);
      if (logActivity) logActivity('inventory', 'info', 'equipment_saved', item.locationKey,
        `${item.equipmentType}: ${item.quantity} шт.`, { user: req.user && req.user.login });
      res.json({ ok: true, item: saved });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  r.patch('/api/admin/equipment/:id', authMiddleware, adminMiddleware, (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || !equipmentGet.get(id)) return res.status(404).json({ error: 'Позиция не найдена' });
      const item = cleanEquipment(req.body || {});
      equipmentUpdate.run(item.locationKey, item.equipmentType, item.quantity, item.notes, id);
      if (logActivity) logActivity('inventory', 'info', 'equipment_saved', item.locationKey,
        `${item.equipmentType}: ${item.quantity} шт.`, { id, user: req.user && req.user.login });
      res.json({ ok: true, item: equipmentGet.get(id) });
    } catch (e) {
      const duplicate = /UNIQUE constraint failed/.test(e.message || '');
      res.status(duplicate ? 409 : 400).json({ error: duplicate ? 'Такой тип оборудования уже есть на этой локации' : e.message });
    }
  });

  r.delete('/api/admin/equipment/:id', authMiddleware, adminMiddleware, (req, res) => {
    try {
      const id = Number(req.params.id);
      const old = Number.isInteger(id) ? equipmentGet.get(id) : null;
      if (!old) return res.status(404).json({ error: 'Позиция не найдена' });
      equipmentDelete.run(id);
      if (logActivity) logActivity('inventory', 'warning', 'equipment_deleted', old.location_key,
        `${old.equipment_type}: ${old.quantity} шт.`, { id, user: req.user && req.user.login });
      res.json({ ok: true });
    } catch (e) {
      logger.error('[Inventory] equipment delete: ' + e.message);
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/api/admin/sim_registry', authMiddleware, adminMiddleware, (req, res) => {
    try { res.json(registryRowsWithBindings()); }
    catch (e) {
      logger.error('[Inventory] SIM registry list: ' + e.message);
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/api/admin/sim_registry', authMiddleware, adminMiddleware, (req, res) => {
    try {
      const iccid = normalizeIccid(req.body && req.body.iccid);
      const phone = normalizePhone(req.body && req.body.phone);
      if (!iccid) throw new Error('ICCID должен содержать 15–24 цифры');
      if (!phone) throw new Error('Укажите корректный номер телефона');
      const row = {
        iccid,
        phone,
        operator: String((req.body && req.body.operator) || '').trim().slice(0, 100),
        notes: String((req.body && req.body.notes) || '').trim().slice(0, 500),
      };
      const result = upsertRegistryRows([row], 'manual');
      if (logActivity) logActivity('inventory', 'info', 'sim_registry_saved', iccid,
        `Сохранена связка ICCID → ${phone}`, { user: req.user && req.user.login, ...result });
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  r.post('/api/admin/sim_registry/import', authMiddleware, adminMiddleware, (req, res) => {
    try {
      const parsed = parseSimRegistryText(req.body && req.body.text);
      if (!parsed.rows.length) {
        return res.status(400).json({ error: 'Нет корректных строк для импорта', errors: parsed.errors.slice(0, 100) });
      }
      const result = upsertRegistryRows(parsed.rows, 'import');
      if (logActivity) logActivity('inventory', 'info', 'sim_registry_imported', null,
        `Импортировано ${parsed.rows.length} связок ICCID → телефон`, {
          user: req.user && req.user.login, ...result, errors: parsed.errors.length,
        });
      res.json({ ok: true, processed: parsed.rows.length, errors: parsed.errors.slice(0, 100), ...result });
    } catch (e) {
      logger.error('[Inventory] SIM registry import: ' + e.message);
      res.status(400).json({ error: e.message });
    }
  });

  r.delete('/api/admin/sim_registry/:iccid', authMiddleware, adminMiddleware, (req, res) => {
    try {
      const iccid = normalizeIccid(req.params.iccid);
      if (!iccid || !registryGet.get(iccid)) return res.status(404).json({ error: 'ICCID не найден' });
      registryDelete.run(iccid);
      if (logActivity) logActivity('inventory', 'warning', 'sim_registry_deleted', iccid,
        'Связка ICCID → телефон удалена', { user: req.user && req.user.login });
      res.json({ ok: true });
    } catch (e) {
      logger.error('[Inventory] SIM registry delete: ' + e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return r;
};
