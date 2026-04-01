-- Fix bare "Orange" operator names that lack country suffix
UPDATE modem_meta SET operator='Orange MD'
  WHERE LOWER(operator)='orange' AND server_name='S1';
UPDATE modem_meta SET operator='Orange RO'
  WHERE LOWER(operator)='orange' AND server_name='S2';
UPDATE traffic_hourly SET operator='Orange MD'
  WHERE LOWER(operator)='orange' AND server_name='S1';
UPDATE traffic_hourly SET operator='Orange RO'
  WHERE LOWER(operator)='orange' AND server_name='S2';
