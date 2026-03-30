UPDATE clients SET password = NULL WHERE password IS NOT NULL AND password != '';
